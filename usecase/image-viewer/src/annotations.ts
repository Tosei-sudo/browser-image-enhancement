/**
 * Notes drawn on the map ("注記"): arrows, lines, boxes and text, each in a
 * color and size of its own, on one layer above the images. A small toolbar
 * over the map picks what to draw; drawn notes can be moved, and deleted with
 * Delete. They stay in the browser, are saved in projects, and show in what
 * is saved or printed of the view (they are an ordinary vector layer).
 */
import type OlMap from 'ol/Map.js';
import Feature from 'ol/Feature.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import type Geometry from 'ol/geom/Geometry.js';
import LineString from 'ol/geom/LineString.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import Draw, { createBox } from 'ol/interaction/Draw.js';
import Select from 'ol/interaction/Select.js';
import Translate from 'ol/interaction/Translate.js';
import VectorLayer from 'ol/layer/Vector.js';
import Overlay from 'ol/Overlay.js';
import VectorSource from 'ol/source/Vector.js';
import { Fill, Stroke, Style, Text } from 'ol/style.js';
import type { FeatureLike } from 'ol/Feature.js';

/** What a note is. */
export type NoteKind = 'arrow' | 'line' | 'box' | 'text';

/** The sizes offered: line width and text size, in pixels. */
export const NOTE_SIZES = { small: { width: 2, font: 14 }, medium: { width: 3, font: 20 }, large: { width: 5, font: 28 } } as const;
export type NoteSize = keyof typeof NOTE_SIZES;

/** A note as saved: GeoJSON in `EPSG:3857` with its kind, color, size and text. */
export interface SavedNotes {
  type: 'FeatureCollection';
  features: object[];
}

const format = new GeoJSON();

/** The arrowhead at the end of `line` for `resolution`: a triangle `length` pixels long. */
export function arrowHead(line: readonly number[][], resolution: number, length: number): number[][] | null {
  if (line.length < 2) return null;
  const end = line[line.length - 1];
  // The last point far enough back to give a direction.
  let from = line[line.length - 2];
  for (let i = line.length - 2; i >= 0 && Math.hypot(end[0] - from[0], end[1] - from[1]) < resolution; i--) from = line[i];
  const dx = end[0] - from[0];
  const dy = end[1] - from[1];
  const d = Math.hypot(dx, dy);
  if (!d) return null;
  const ux = dx / d;
  const uy = dy / d;
  const l = length * resolution;
  const w = l * 0.45;
  const bx = end[0] - ux * l;
  const by = end[1] - uy * l;
  return [end, [bx - uy * w, by + ux * w], [bx + uy * w, by - ux * w], end];
}

const sizeOf = (f: FeatureLike) => NOTE_SIZES[(f.get('size') as NoteSize) ?? 'medium'] ?? NOTE_SIZES.medium;

/** How a note is drawn (selected: with a light halo). */
export function noteStyle(feature: FeatureLike, resolution: number, selected = false): Style[] {
  const color = (feature.get('color') as string) || '#e11d48';
  const { width, font } = sizeOf(feature);
  const halo = selected ? [new Style({ stroke: new Stroke({ color: '#38bdf8aa', width: width + 8 }) })] : [];
  const kind = feature.get('kind') as NoteKind;
  if (kind === 'text') {
    return [
      new Style({
        text: new Text({
          text: String(feature.get('text') ?? ''),
          font: `bold ${font}px system-ui, sans-serif`,
          fill: new Fill({ color }),
          stroke: new Stroke({ color: selected ? '#38bdf8' : '#ffffff', width: Math.max(3, font / 5) }),
          overflow: true,
        }),
      }),
    ];
  }
  const stroke = new Stroke({ color, width, lineCap: 'round', lineJoin: 'round' });
  const styles = [...halo, new Style({ stroke, fill: kind === 'box' ? new Fill({ color: 'rgba(0, 0, 0, 0)' }) : undefined })];
  if (kind === 'arrow') {
    const geometry = feature.getGeometry();
    const coordinates = geometry instanceof LineString ? geometry.getCoordinates() : null;
    const head = coordinates && arrowHead(coordinates, resolution, 4 * width + 8);
    if (head) styles.push(new Style({ geometry: new Polygon([head]), fill: new Fill({ color }), stroke: new Stroke({ color, width: 1 }) }));
  }
  return styles;
}

const STORE_KEY = 'image-viewer.annotations';

export interface AnnotationOptions {
  say: (message: string) => void;
  /** When drawing starts (to turn the other click tools off). */
  onStart?: () => void;
  /** The button that shows and hides the toolbar. */
  button?: HTMLButtonElement;
}

/** The notes layer and its toolbar. */
export class Annotations {
  readonly source = new VectorSource<Feature<Geometry>>();
  readonly layer: VectorLayer<VectorSource<Feature<Geometry>>>;
  readonly toolbar: HTMLElement;
  private draw_: Draw | null = null;
  private readonly select_: Select;
  private readonly translate_: Translate;
  private active_ = false;
  private kind_: NoteKind | 'select' = 'arrow';
  private color_ = '#e11d48';
  private size_: NoteSize = 'medium';
  private readonly textOverlay_: Overlay;

  constructor(
    private readonly map: OlMap,
    private readonly options: AnnotationOptions,
  ) {
    this.layer = new VectorLayer({ source: this.source, zIndex: 10_000, style: (f, r) => noteStyle(f, r), properties: { title: '注記' } });
    map.addLayer(this.layer);
    this.select_ = new Select({ layers: [this.layer], style: (f) => noteStyle(f, map.getView().getResolution() ?? 1, true), hitTolerance: 6 });
    this.translate_ = new Translate({ features: this.select_.getFeatures() });
    this.translate_.on('translateend', () => this.store_());
    for (const i of [this.select_, this.translate_]) {
      i.setActive(false);
      map.addInteraction(i);
    }
    this.load_();

    const bar = (this.toolbar = document.createElement('div'));
    bar.className = 'annotation-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '注記');
    bar.hidden = true;
    const kinds: Array<[NoteKind | 'select', string, string]> = [
      ['arrow', '矢印', 'クリックで点を置き、ダブルクリックした所が矢印の先になります'],
      ['line', '線', 'クリックで点を置き、ダブルクリックで終わります'],
      ['box', '四角', '2 か所のクリックで四角を描きます'],
      ['text', '文字', 'クリックした所に文字を置きます'],
      ['select', '選択・移動', '注記をクリックで選び、ドラッグで動かします。Delete で削除'],
    ];
    for (const [kind, label, title] of kinds) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.dataset.kind = kind;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => this.setKind(kind));
      bar.append(b);
    }
    const color = document.createElement('input');
    color.type = 'color';
    color.value = this.color_;
    color.setAttribute('aria-label', '注記の色');
    color.title = '色（選んだ注記にも）';
    color.addEventListener('input', () => {
      this.color_ = color.value;
      this.restyleSelected_({ color: color.value });
    });
    const size = document.createElement('select');
    size.setAttribute('aria-label', '注記の大きさ');
    size.append(new Option('小', 'small'), new Option('中', 'medium', true, true), new Option('大', 'large'));
    size.addEventListener('change', () => {
      this.size_ = size.value as NoteSize;
      this.restyleSelected_({ size: size.value });
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '削除';
    remove.title = '選んだ注記を削除（Delete）';
    remove.addEventListener('click', () => this.deleteSelected());
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'すべて消去';
    clear.addEventListener('click', () => this.clear());
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'annotation-done';
    done.textContent = '終了';
    done.addEventListener('click', () => this.setActive(false));
    bar.append(color, size, remove, clear, done);
    map.getTargetElement()?.append(bar);

    // Text is typed where it goes.
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'annotation-text';
    input.setAttribute('aria-label', '注記の文字');
    input.placeholder = '文字を入力して Enter';
    this.textOverlay_ = new Overlay({ element: input, positioning: 'center-left', stopEvent: true });
    map.addOverlay(this.textOverlay_);

    options.button?.addEventListener('click', () => this.setActive(!this.active_));
    document.addEventListener('keydown', (e) => {
      if (!this.active_ || (e.target as HTMLElement).closest?.('input, textarea, select')) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.deleteSelected()) e.preventDefault();
      } else if (e.key === 'Escape') {
        if (this.draw_?.getActive()) this.draw_.abortDrawing();
        else this.setActive(false);
      }
    });
  }

  isActive(): boolean {
    return this.active_;
  }

  /** Shows the toolbar and draws (or hides it and stops). */
  setActive(on: boolean): void {
    this.active_ = on;
    this.toolbar.hidden = !on;
    this.options.button?.setAttribute('aria-pressed', String(on));
    if (on) this.options.onStart?.();
    this.setKind(on ? this.kind_ : null);
  }

  /** What a click draws: a kind of note, or picking notes to move (null: nothing). */
  setKind(kind: NoteKind | 'select' | null): void {
    if (this.draw_) {
      this.map.removeInteraction(this.draw_);
      this.draw_ = null;
    }
    this.hideText_();
    if (kind) this.kind_ = kind;
    const on = this.active_ && kind !== null;
    for (const b of this.toolbar.querySelectorAll<HTMLButtonElement>('[data-kind]')) b.setAttribute('aria-pressed', String(on && b.dataset.kind === kind));
    const selecting = on && kind === 'select';
    this.select_.setActive(selecting);
    this.translate_.setActive(selecting);
    if (!selecting) this.select_.getFeatures().clear();
    if (!on || kind === 'select' || !kind) return;
    const draw = new Draw({
      source: kind === 'text' ? undefined : this.source,
      type: kind === 'text' ? 'Point' : kind === 'box' ? 'Circle' : 'LineString',
      geometryFunction: kind === 'box' ? createBox() : undefined,
      style: (f) => noteStyle(withProps(f, { kind, color: this.color_, size: this.size_ }), this.map.getView().getResolution() ?? 1),
    });
    draw.on('drawend', (e) => {
      const feature = e.feature as Feature<Geometry>;
      if (kind === 'text') {
        this.askText_((feature.getGeometry() as Point).getCoordinates());
        return;
      }
      feature.setProperties({ kind, color: this.color_, size: this.size_ });
      // Stored once the source has it.
      setTimeout(() => this.store_());
    });
    this.draw_ = draw;
    this.map.addInteraction(draw);
  }

  /** Adds a note (for scripts and tests). */
  add(kind: NoteKind, geometry: Geometry, props: { color?: string; size?: NoteSize; text?: string } = {}): Feature<Geometry> {
    const feature = new Feature({ geometry, kind, color: props.color ?? this.color_, size: props.size ?? this.size_, ...(props.text !== undefined ? { text: props.text } : {}) });
    this.source.addFeature(feature);
    this.store_();
    return feature;
  }

  /** Deletes the selected notes; false when none is. */
  deleteSelected(): boolean {
    const selected = this.select_.getFeatures();
    if (!selected.getLength()) return false;
    for (const f of selected.getArray()) if (this.source.hasFeature(f)) this.source.removeFeature(f);
    selected.clear();
    this.store_();
    return true;
  }

  /** Deletes every note. */
  clear(): void {
    if (!this.source.getFeatures().length) return;
    this.select_.getFeatures().clear();
    this.source.clear();
    this.store_();
    this.options.say('注記をすべて消去しました');
  }

  /** The notes, for a project. */
  get(): SavedNotes | null {
    const features = this.source.getFeatures();
    return features.length ? (format.writeFeaturesObject(features) as SavedNotes) : null;
  }

  /** Replaces the notes (a project opened). */
  set(saved: SavedNotes | null): void {
    this.select_.getFeatures().clear();
    this.source.clear();
    if (saved) this.source.addFeatures(readNotes(saved));
    this.store_();
  }

  private restyleSelected_(props: Record<string, string>): void {
    const selected = this.select_.getFeatures().getArray();
    for (const f of selected) f.setProperties(props);
    if (selected.length) this.store_();
  }

  private askText_(at: number[]): void {
    const input = this.textOverlay_.getElement() as HTMLInputElement;
    input.value = '';
    this.textOverlay_.setPosition(at);
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      input.removeEventListener('keydown', key);
      input.removeEventListener('blur', blur);
      const text = input.value.trim();
      this.hideText_();
      if (keep && text) this.add('text', new Point(at), { text });
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    };
    const blur = () => finish(true);
    input.addEventListener('keydown', key);
    input.addEventListener('blur', blur);
    requestAnimationFrame(() => input.focus());
  }

  private hideText_(): void {
    this.textOverlay_.setPosition(undefined);
  }

  private store_(): void {
    try {
      const saved = this.get();
      if (saved) localStorage.setItem(STORE_KEY, JSON.stringify(saved));
      else localStorage.removeItem(STORE_KEY);
    } catch {
      // Storage blocked or full: the notes last for this page (and the project saved).
    }
  }

  private load_(): void {
    try {
      const text = localStorage.getItem(STORE_KEY);
      if (text) this.source.addFeatures(readNotes(JSON.parse(text) as SavedNotes));
    } catch {
      // Nothing kept, or not readable.
    }
  }
}

/** The notes of a project or of the browser's store, as far as they can be read. */
export function readNotes(saved: unknown): Array<Feature<Geometry>> {
  if (!saved || typeof saved !== 'object' || (saved as SavedNotes).type !== 'FeatureCollection') return [];
  try {
    return (format.readFeatures(saved) as Array<Feature<Geometry>>).filter((f) => ['arrow', 'line', 'box', 'text'].includes(f.get('kind') as string) && f.getGeometry());
  } catch {
    return [];
  }
}

/** A copy of the feature being drawn with the note's properties, for its style. */
function withProps(f: FeatureLike, props: Record<string, unknown>): FeatureLike {
  const feature = f as Feature;
  if (feature.get('kind') === undefined) feature.setProperties(props, true);
  return feature;
}
