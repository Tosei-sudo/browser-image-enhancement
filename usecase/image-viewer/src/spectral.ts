/**
 * The spectral graph (スペクトル) of the information section: the value of
 * every band of the selected image at the points clicked on the map, or the
 * mean over a box dragged on it, as lines over the bands. Several points
 * overlay, so vegetation, water and built-up ground can be told apart before
 * choosing bands for band math or an RGB assignment. The values are the
 * file's own (DN, reflectance…), not the corrected display. A CSV of them
 * can be saved.
 */
import type OlMap from 'ol/Map.js';
import Feature from 'ol/Feature.js';
import { Point, Polygon } from 'ol/geom.js';
import { fromExtent } from 'ol/geom/Polygon.js';
import DragBox from 'ol/interaction/DragBox.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import { Circle, Fill, Stroke, Style, Text } from 'ol/style.js';
import type { EventsKey } from 'ol/events.js';
import { unByKey } from 'ol/Observable.js';
import type { Extent } from 'ol/extent.js';
import { place, transformer } from './composite-dialog.js';
import type { ViewerImage } from './images.js';
import { download } from './local-edit.js';

/** The statistics of one band over the pixels read. */
export interface BandStat {
  mean: number;
  min: number;
  max: number;
  std: number;
  /** Pixels with a value (not no data). */
  count: number;
}

/** One line of the graph. */
export interface Spectrum {
  /** 1, 2…: the marker's number on the map. */
  number: number;
  /** 点 or 範囲, with where. */
  label: string;
  color: string;
  /** One per band. */
  bands: BandStat[];
  /** Pixels read (a box: all of them, no data included). */
  pixels: number;
}

/** Most points kept; the oldest goes when another is added. */
const MAX_SERIES = 8;
/** A box larger than this many pixels is read at a lower resolution. */
const MAX_READ = 1_000_000;
const COLORS = ['#3e7bfa', '#e5484d', '#30a46c', '#f5a524', '#8e4ec6', '#12a5b0', '#d6409f', '#7c5d3a'];

/**
 * Mean, range and spread of each band, leaving out no data (`isNoData`, and
 * NaN). A band with no value gets NaN statistics and a count of 0.
 */
export function bandStats(bands: ReadonlyArray<ArrayLike<number>>, isNoData: (v: number) => boolean = () => false): BandStat[] {
  return bands.map((values) => {
    let n = 0;
    let sum = 0;
    let sum2 = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (Number.isNaN(v) || isNoData(v)) continue;
      n++;
      sum += v;
      sum2 += v * v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!n) return { mean: NaN, min: NaN, max: NaN, std: NaN, count: 0 };
    const mean = sum / n;
    return { mean, min, max, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), count: n };
  });
}

/** The band labels of the graph: `B1`, or `B4 NIR` with the band's name. */
export function bandLabels(count: number, names: ReadonlyArray<string | null> = []): string[] {
  return Array.from({ length: count }, (_, i) => (names[i] ? `B${i + 1} ${names[i]}` : `B${i + 1}`));
}

/** The lines as CSV: one row per band, a column of means per line (and the range and spread of a box). */
export function spectralCsv(series: readonly Spectrum[], labels: readonly string[]): string {
  const quote = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const head = ['band'];
  for (const s of series) {
    const name = `${s.number} ${s.label}`;
    head.push(name);
    if (s.pixels > 1) head.push(`${name} min`, `${name} max`, `${name} std`);
  }
  const rows = [head.map(quote).join(',')];
  const num = (v: number) => (Number.isNaN(v) ? '' : String(+v.toPrecision(7)));
  labels.forEach((label, b) => {
    const row = [quote(label)];
    for (const s of series) {
      const stat = s.bands[b];
      row.push(num(stat?.mean ?? NaN));
      if (s.pixels > 1) row.push(num(stat?.min ?? NaN), num(stat?.max ?? NaN), num(stat?.std ?? NaN));
    }
    rows.push(row.join(','));
  });
  return `${rows.join('\n')}\n`;
}

/** A round step giving about `count` ticks over `span`. */
function niceStep(span: number, count: number): number {
  const raw = span / Math.max(1, count);
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}

const W = 320;
const H = 170;
const PAD = { left: 46, right: 8, top: 10, bottom: 30 };
const SVG = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function format(v: number): string {
  if (Number.isNaN(v)) return '—';
  const a = Math.abs(v);
  return a !== 0 && (a < 0.01 || a >= 1e6) ? v.toExponential(2) : String(+v.toFixed(a < 10 ? 4 : a < 1000 ? 2 : 0));
}

/** Draws `series` over `labels` into `container` (replacing what is there). */
export function drawSpectrum(container: HTMLElement, series: readonly Spectrum[], labels: readonly string[]): void {
  container.replaceChildren();
  const n = labels.length;
  const values = series.flatMap((s) => s.bands.flatMap((b) => (s.pixels > 1 ? [b.min, b.max] : [b.mean]))).filter((v) => Number.isFinite(v));
  if (!series.length || !n || !values.length) return;
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max - min < 1e-9) {
    const pad = Math.abs(max) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const step = niceStep(max - min, 4);
  min = Math.floor(min / step) * step;
  max = Math.ceil(max / step) * step;
  const x = (b: number) => PAD.left + (n === 1 ? (W - PAD.left - PAD.right) / 2 : ((W - PAD.left - PAD.right) * b) / (n - 1));
  const y = (v: number) => PAD.top + ((H - PAD.top - PAD.bottom) * (max - v)) / (max - min);

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'spectral-chart', role: 'img' });
  svg.setAttribute('aria-label', `スペクトル（${n} バンド、${series.length} 本）`);
  for (let v = min; v <= max + step / 2; v += step) {
    svg.append(el('line', { x1: PAD.left, x2: W - PAD.right, y1: y(v), y2: y(v), class: 'profile-grid' }));
    const t = el('text', { x: PAD.left - 4, y: y(v) + 3, class: 'profile-tick', 'text-anchor': 'end' });
    t.textContent = format(+v.toPrecision(10));
    svg.append(t);
  }
  // Band ticks: every one while they fit, else every k-th.
  const every = Math.ceil(n / 12);
  for (let b = 0; b < n; b += every) {
    const t = el('text', { x: x(b), y: H - PAD.bottom + 13, class: 'profile-tick', 'text-anchor': 'middle' });
    t.textContent = `B${b + 1}`;
    svg.append(t);
  }
  const axis = el('text', { x: W - PAD.right, y: H - 3, class: 'profile-tick', 'text-anchor': 'end' });
  axis.textContent = 'バンド';
  svg.append(axis);

  for (const s of series) {
    // A box's range as a band behind its mean.
    if (s.pixels > 1) {
      const top = s.bands.map((b, i) => [i, b.max] as const).filter(([, v]) => Number.isFinite(v));
      const bottom = s.bands.map((b, i) => [i, b.min] as const).filter(([, v]) => Number.isFinite(v)).reverse();
      if (top.length > 1) {
        const d = [...top, ...bottom].map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
        svg.append(el('path', { d: `${d} Z`, fill: s.color, 'fill-opacity': 0.15, stroke: 'none' }));
      }
    }
    let d = '';
    s.bands.forEach((b, i) => {
      if (!Number.isFinite(b.mean)) return;
      d += `${d && Number.isFinite(s.bands[i - 1]?.mean) ? 'L' : 'M'}${x(i).toFixed(1)},${y(b.mean).toFixed(1)} `;
    });
    svg.append(el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, class: 'spectral-line' }));
    s.bands.forEach((b, i) => {
      if (Number.isFinite(b.mean)) svg.append(el('circle', { cx: x(i), cy: y(b.mean), r: 2.5, fill: s.color }));
    });
  }

  // Hover: the band and every line's value there.
  const cross = el('line', { y1: PAD.top, y2: H - PAD.bottom, class: 'profile-cross', visibility: 'hidden' });
  svg.append(cross);
  const tip = document.createElement('div');
  tip.className = 'profile-tip';
  tip.hidden = true;
  const hit = el('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent' });
  svg.append(hit);
  hit.addEventListener('pointermove', (event) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    const b = n === 1 ? 0 : Math.min(n - 1, Math.max(0, Math.round(((px - PAD.left) / (W - PAD.left - PAD.right)) * (n - 1))));
    cross.setAttribute('x1', String(x(b)));
    cross.setAttribute('x2', String(x(b)));
    cross.setAttribute('visibility', 'visible');
    tip.textContent = [labels[b], ...series.map((s) => `${s.number}: ${format(s.bands[b]?.mean ?? NaN)}`)].join('\n');
    tip.hidden = false;
    tip.style.left = `${Math.min(box.width - 100, Math.max(0, event.clientX - box.left + 8))}px`;
  });
  hit.addEventListener('pointerleave', () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
  });

  const legend = document.createElement('ol');
  legend.className = 'spectral-legend';
  for (const s of series) {
    const item = document.createElement('li');
    const swatch = document.createElement('i');
    swatch.style.background = s.color;
    item.append(swatch, `${s.number}. ${s.label}`);
    legend.append(item);
  }
  const wrap = document.createElement('div');
  wrap.className = 'profile-wrap';
  wrap.append(svg, tip);
  container.append(wrap, legend);
}

/** What the panel reads from. */
export interface SpectralPanelOptions {
  /** The toggle button (its `aria-pressed` follows the panel). */
  button: HTMLButtonElement;
  /** The element the panel is built in (hidden while closed). */
  element: HTMLElement;
  /** The selected image, or null when the selected layer is not one. */
  image: () => ViewerImage | null;
  /** Whether a map click is free for the panel (no measuring, points or drawing on). */
  idle: () => boolean;
}

type Pixels = { bands: ArrayLike<number>[]; pixels: number; label: string };

/** The panel. Clicks on the map add points while it is open; in 範囲 mode a drag adds a box. */
export class SpectralPanel {
  private open_ = false;
  private series_: Spectrum[] = [];
  private labels_: string[] = [];
  private image_: ViewerImage | null = null;
  private next_ = 1;
  private keys_: EventsKey[] = [];
  private readonly markers_ = new VectorSource();
  private readonly layer_: VectorLayer;
  private readonly box_ = new DragBox({ condition: () => true, className: 'ol-dragbox spectral-box' });
  private readonly mode_: HTMLSelectElement;
  private readonly chart_: HTMLElement;
  private readonly note_: HTMLParagraphElement;
  private readonly clear_: HTMLButtonElement;
  private readonly save_: HTMLButtonElement;

  constructor(
    private readonly map: OlMap,
    private readonly options: SpectralPanelOptions,
  ) {
    const { element } = options;
    element.classList.add('spectral');
    element.hidden = true;
    const controls = document.createElement('div');
    controls.className = 'histogram-controls spectral-controls';
    this.mode_ = document.createElement('select');
    this.mode_.setAttribute('aria-label', '取り方');
    this.mode_.append(new Option('クリックした点', 'point'), new Option('ドラッグした範囲の平均', 'box'));
    this.mode_.addEventListener('change', () => this.attach_());
    this.clear_ = document.createElement('button');
    this.clear_.type = 'button';
    this.clear_.textContent = '消去';
    this.clear_.addEventListener('click', () => this.clear());
    this.save_ = document.createElement('button');
    this.save_.type = 'button';
    this.save_.textContent = 'CSV 保存';
    this.save_.addEventListener('click', () => this.saveCsv());
    controls.append(this.mode_, this.clear_, this.save_);
    this.chart_ = document.createElement('div');
    this.chart_.className = 'spectral-graph';
    this.note_ = document.createElement('p');
    this.note_.className = 'histogram-note';
    this.note_.setAttribute('role', 'status');
    element.append(controls, this.chart_, this.note_);
    options.button.addEventListener('click', () => this.setOpen(!this.open_));

    this.layer_ = new VectorLayer({
      source: this.markers_,
      zIndex: 1000,
      style: (feature) => {
        const color = feature.get('color') as string;
        const text = String(feature.get('number'));
        const font = 'bold 11px system-ui, sans-serif';
        if (feature.getGeometry() instanceof Polygon) {
          return new Style({
            stroke: new Stroke({ color, width: 2 }),
            fill: new Fill({ color: `${color}22` }),
            text: new Text({ text, font, overflow: true, fill: new Fill({ color }), stroke: new Stroke({ color: '#fff', width: 3 }) }),
          });
        }
        return new Style({ image: new Circle({ radius: 8, fill: new Fill({ color }), stroke: new Stroke({ color: '#fff', width: 2 }) }), text: new Text({ text, font, fill: new Fill({ color: '#fff' }) }) });
      },
    });
    this.layer_.set('helper', true);
    this.box_.on('boxend', () => void this.addBox(this.box_.getGeometry().getExtent()));
    this.update_();
  }

  isOpen(): boolean {
    return this.open_;
  }

  setOpen(open: boolean): void {
    if (open === this.open_) return;
    this.open_ = open;
    this.options.button.setAttribute('aria-pressed', String(open));
    this.options.element.hidden = !open;
    if (open) this.map.addLayer(this.layer_);
    else this.map.removeLayer(this.layer_);
    this.attach_();
    this.update_();
  }

  /** Follows the selection: another image starts the graph afresh. */
  setImage(image: ViewerImage | null): void {
    if (image === this.image_) return;
    this.image_ = image;
    this.clear();
  }

  /** The lines shown (for tests and the console). */
  getSeries(): readonly Spectrum[] {
    return this.series_;
  }

  getLabels(): readonly string[] {
    return this.labels_;
  }

  clear(): void {
    this.series_ = [];
    this.markers_.clear();
    this.next_ = 1;
    this.update_();
  }

  /** Adds the bands' values at `coordinate` (in the view's projection). */
  async addPoint(coordinate: number[]): Promise<void> {
    await this.add_(() => this.read_(coordinate, null), new Point(coordinate));
  }

  /** Adds the bands' means over `extent` (in the view's projection). */
  async addBox(extent: Extent): Promise<void> {
    await this.add_(() => this.read_(null, extent), fromExtent(extent));
  }

  saveCsv(): void {
    if (!this.series_.length) return;
    const base = (this.image_?.name ?? 'spectrum').replace(/\.[^.]+$/, '');
    download(`${base}_spectrum.csv`, `\ufeff${spectralCsv(this.series_, this.labels_)}`, 'text/csv');
  }

  private async add_(read: () => Promise<Pixels>, geometry: Point | Polygon): Promise<void> {
    const image = this.options.image();
    if (!image) return this.say_('画像のレイヤーを選択');
    this.image_ = image;
    try {
      const got = await read();
      if (this.options.image() !== image) return;
      const nodata = this.noDataTest_(image);
      const bands = bandStats(got.bands, nodata);
      if (bands.every((b) => b.count === 0)) return this.say_(got.pixels ? 'その地点はノーデータ' : 'その地点に画像なし');
      const number = this.next_++;
      const color = COLORS[(number - 1) % COLORS.length];
      this.series_.push({ number, label: got.label, color, bands, pixels: got.pixels });
      const feature = new Feature({ geometry, number, color });
      feature.setId(number);
      this.markers_.addFeature(feature);
      while (this.series_.length > MAX_SERIES) {
        const gone = this.series_.shift()!;
        const old = this.markers_.getFeatureById(gone.number);
        if (old) this.markers_.removeFeature(old);
      }
      this.labels_ = bandLabels(bands.length, await image.source.getBandNames().catch(() => []));
      this.update_();
    } catch (error) {
      this.say_(error instanceof Error ? error.message : String(error));
    }
  }

  /** Reads every band at a point, or over a box (at a lower resolution when it is large). */
  private async read_(coordinate: number[] | null, extent: Extent | null): Promise<Pixels> {
    const image = this.options.image()!;
    const p = place(image);
    const toImage = transformer(this.map.getView().getProjection(), p.projection);
    const toPixel = (xy: number[]) => [(xy[0] - p.shift[0] - p.origin[0]) / p.resolution[0], (xy[1] - p.shift[1] - p.origin[1]) / p.resolution[1]];
    const width = p.tiff.getWidth();
    const height = p.tiff.getHeight();
    const count = Math.min(p.tiff.getSamplesPerPixel(), image.source.getValueBandCount() || p.tiff.getSamplesPerPixel());
    const samples = Array.from({ length: count }, (_, i) => i);
    if (coordinate) {
      const [c, r] = toPixel(toImage(coordinate.slice(0, 2)));
      const col = Math.floor(c);
      const row = Math.floor(r);
      if (!(col >= 0 && row >= 0 && col < width && row < height)) return { bands: samples.map(() => []), pixels: 0, label: '' };
      const bands = (await p.tiff.readRasters({ window: [col, row, col + 1, row + 1], samples })) as unknown as ArrayLike<number>[];
      return { bands, pixels: 1, label: `点（列 ${col}、行 ${row}）` };
    }
    // The box's corners and edge midpoints in the image's pixels; their bounds, clipped to the image.
    const [x0, y0, x1, y1] = extent!;
    const corners = [x0, y0, x1, y0, x1, y1, x0, y1, (x0 + x1) / 2, y0, (x0 + x1) / 2, y1, x0, (y0 + y1) / 2, x1, (y0 + y1) / 2];
    const cols: number[] = [];
    const rows: number[] = [];
    for (let k = 0; k < corners.length; k += 2) {
      const [c, r] = toPixel(toImage([corners[k], corners[k + 1]]));
      cols.push(c);
      rows.push(r);
    }
    const c0 = Math.max(0, Math.floor(Math.min(...cols)));
    const r0 = Math.max(0, Math.floor(Math.min(...rows)));
    const c1 = Math.min(width, Math.ceil(Math.max(...cols)));
    const r1 = Math.min(height, Math.ceil(Math.max(...rows)));
    if (!(c1 > c0 && r1 > r0)) return { bands: samples.map(() => []), pixels: 0, label: '' };
    const w = c1 - c0;
    const h = r1 - r0;
    const scale = Math.min(1, Math.sqrt(MAX_READ / (w * h)));
    const outW = Math.max(1, Math.round(w * scale));
    const outH = Math.max(1, Math.round(h * scale));
    const bands = (await p.tiff.readRasters({ window: [c0, r0, c1, r1], samples, width: outW, height: outH, resampleMethod: 'nearest' })) as unknown as ArrayLike<number>[];
    return { bands, pixels: w * h, label: `範囲 ${w.toLocaleString()} × ${h.toLocaleString()} 画素${scale < 1 ? '（間引き）' : ''}` };
  }

  /** The image's no-data values: the file's own, and any typed for it (see nodata-dialog.ts). */
  private noDataTest_(image: ViewerImage): (v: number) => boolean {
    const own = place(image).tiff.getGDALNoData();
    const values = new Set<number>([...image.source.getNoData().values, ...(own === null ? [] : [own])]);
    return (v) => values.has(v);
  }

  private attach_(): void {
    unByKey(this.keys_);
    this.keys_ = [];
    this.map.removeInteraction(this.box_);
    if (!this.open_) return;
    if (this.mode_.value === 'box') {
      this.map.addInteraction(this.box_);
      return;
    }
    this.keys_.push(
      this.map.on('singleclick', (e) => {
        if (this.options.idle()) void this.addPoint(e.coordinate);
      }),
    );
  }

  private say_(message: string): void {
    this.note_.textContent = message;
  }

  private update_(): void {
    drawSpectrum(this.chart_, this.series_, this.labels_);
    this.clear_.disabled = this.save_.disabled = !this.series_.length;
    this.note_.textContent = this.series_.length
      ? ''
      : this.mode_.value === 'box'
        ? '地図上をドラッグすると、その範囲の各バンドの平均（と最小〜最大の幅）を表示'
        : '地図をクリックすると、その点の各バンドの値を表示。複数を重ねて比較可能';
  }
}
