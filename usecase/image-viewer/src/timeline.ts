/**
 * The timeline (タイムライン): every layer that has times on one time axis,
 * and a window of time that filters the whole viewer.
 *
 * - Vector layers: the attribute holding each feature's time (found by
 *   itself: date attributes, text that reads as dates, an Esri layer's
 *   `timeInfo`; a start and an end make a span). The chart shows how many
 *   features fall in each step, stacked by layer; the map, the 3D view and
 *   the attribute table show only those in the window.
 * - Images: when each was taken, from its metadata (GDAL acquisition items,
 *   NITF IDATIM), its file name or the TIFF DateTime, or as typed. Images
 *   outside the window are hidden; images without a time stay.
 * - WMS layers with a time dimension: drawn at the window's end (the latest
 *   time the server offers by then).
 *
 * The window is dragged on the chart (its edges stretch it), set to a
 * calendar length (a day, a month…), stepped and played; in 累積 mode it
 * runs from the beginning. Closing the timeline shows everything again.
 */
import Observable, { unByKey } from 'ol/Observable.js';
import type { EventsKey } from 'ol/events.js';
import type Feature from 'ol/Feature.js';
import type { FeatureLike } from 'ol/Feature.js';
import type { GeoTIFFImage } from 'geotiff';
import type { ImageList, ViewerImage, ViewerLayer, ViewerService } from './images.js';
import { fileInfoOf } from './nitf-tiff.js';
import {
  addTime,
  defaultTimeFields,
  floorTime,
  formatSpan,
  formatTime,
  parseTime,
  stepAtLeast,
  stepLength,
  stepsBetween,
  timeFields,
  timeFromGdalMetadata,
  timeFromName,
  unitNames,
  type TimeField,
  type TimeFilter,
  type TimeUnit,
} from './time.js';

/** Where an image's time came from. */
export type ImageTimeOrigin = 'metadata' | 'nitf' | 'name' | 'tiff' | 'manual';
export const imageTimeOrigins: Record<ImageTimeOrigin, string> = {
  metadata: 'メタデータ',
  nitf: 'NITF',
  name: 'ファイル名',
  tiff: 'TIFF の DateTime',
  manual: '手入力',
};

/** When an image was taken, read from what it says of itself; null when nothing says. */
export async function imageTime(image: Pick<ViewerImage, 'name' | 'source'>): Promise<{ time: number; origin: ImageTimeOrigin } | null> {
  const nitf = fileInfoOf(image.source).find(([k]) => k === '撮影日時')?.[1];
  const fromNitf = nitf ? parseTime(nitf.replace(/ UTC$/, 'Z').replace(' ', 'T')) : null;
  let tiff: GeoTIFFImage | undefined;
  try {
    tiff = (image.source.getTiffImages() as GeoTIFFImage[][])[0]?.[0];
  } catch {
    tiff = undefined;
  }
  const fd = tiff?.fileDirectory as { hasTag?: (t: number) => boolean; loadValue?: (t: number) => Promise<unknown> } | undefined;
  const tag = async (n: number): Promise<string | null> => {
    if (!fd?.hasTag?.(n) || !fd.loadValue) return null;
    const v = await fd.loadValue(n).catch(() => null);
    return typeof v === 'string' ? v : null;
  };
  const gdal = await tag(42112);
  const fromGdal = gdal ? timeFromGdalMetadata(gdal) : null;
  if (fromGdal !== null) return { time: fromGdal, origin: 'metadata' };
  if (fromNitf !== null) return { time: fromNitf, origin: 'nitf' };
  const fromName = timeFromName(image.name);
  if (fromName !== null) return { time: fromName, origin: 'name' };
  const dateTime = await tag(306);
  const fromTiff = dateTime ? parseTime(dateTime.replace(/\0+$/, '')) : null;
  return fromTiff !== null ? { time: fromTiff, origin: 'tiff' } : null;
}

/** What the timeline knows of one layer. */
interface LayerTime {
  /** Whether the layer follows the window. */
  on: boolean;
  /** Vector layers: the attributes holding times, the ones used, and each feature's span. */
  fields?: TimeField[];
  start?: TimeField | null;
  end?: TimeField | null;
  span?: TimeFilter['span'] | null;
  /** The starts of the features' spans, sorted (for the chart). */
  starts?: Float64Array;
  /** Images: when it was taken (undefined while it is being read). */
  time?: number | null;
  origin?: ImageTimeOrigin;
}

/** A layer's time settings, as saved in a project. */
export interface LayerTimeState {
  on: boolean;
  /** Vector layers: the start and end attributes (null: none). */
  start?: string | null;
  end?: string | null;
  /** Images: a time typed by hand. */
  time?: number;
}

/** The timeline's state, as saved in a project. */
export interface TimelineState {
  open: boolean;
  window: [number, number] | null;
  /** The window's calendar length (`free`: as dragged). */
  width: TimeUnit | 'free';
  cumulative: boolean;
  /** Seconds per step when playing. */
  speed: number;
}

/** The span of each feature: from its start attribute to its end attribute (open-ended when the end is empty). */
function spanReader(start: TimeField, end: TimeField | null): TimeFilter['span'] {
  const cache = new WeakMap<object, { revision: number; span: readonly [number, number] | null }>();
  return (feature: FeatureLike) => {
    const revision = (feature as Feature).getRevision?.() ?? 0;
    const kept = cache.get(feature);
    if (kept && kept.revision === revision) return kept.span;
    const s = parseTime(feature.get(start.name), start.hint);
    let span: readonly [number, number] | null = null;
    if (s !== null) {
      if (end) {
        const e = parseTime(feature.get(end.name), end.hint);
        span = [s, e === null ? Infinity : Math.max(s, e)];
      } else if (start.hint === 'year') span = [s, addTime(s, 'year', 1) - 1];
      else span = [s, s];
    }
    cache.set(feature, { revision, span });
    return span;
  };
}

const PALETTE = ['#2563eb', '#e8590c', '#2f9e44', '#ae3ec9', '#c92a2a', '#0c8599', '#e67700', '#5f3dc4'];
const WIDTHS: Array<TimeUnit | 'free'> = ['free', 'hour', 'day', 'week', 'month', 'year'];
const SPEEDS = [0.25, 0.5, 1, 2];

/**
 * The timeline panel. It fires `change` whenever what it shows changes (the
 * window, a layer's settings), for the attribute table and the 3D view.
 */
export class Timeline extends Observable {
  readonly element: HTMLElement;
  private readonly canvas_: HTMLCanvasElement;
  private readonly label_: HTMLElement;
  private readonly count_: HTMLElement;
  private readonly playButton_: HTMLButtonElement;
  private readonly widthSelect_: HTMLSelectElement;
  private readonly cumulativeBox_: HTMLInputElement;
  private readonly speedSelect_: HTMLSelectElement;
  private readonly layersList_: HTMLElement;
  private readonly empty_: HTMLElement;

  private readonly times_ = new Map<ViewerLayer, LayerTime>();
  private readonly watched_ = new Map<ViewerLayer, EventsKey[]>();
  private open_ = false;
  private window_: [number, number] | null = null;
  private view_: [number, number] | null = null;
  private width_: TimeUnit | 'free' = 'free';
  private cumulative_ = false;
  private speed_ = 1;
  private timer_: ReturnType<typeof setInterval> | null = null;
  private frame_ = 0;
  private collectTimer_: ReturnType<typeof setTimeout> | null = null;
  private wmsTimer_: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly images: ImageList,
    private readonly options: {
      element: HTMLElement;
      /** The menu button that opens it (pressed while open). */
      button: HTMLButtonElement;
      say: (message: string) => void;
      /** Called when it opens or closes (the map changes size). */
      onToggle?: (open: boolean) => void;
    },
  ) {
    super();
    this.element = options.element;
    this.element.classList.add('timeline');
    this.element.hidden = true;
    this.element.innerHTML = `
      <div class="timeline-bar">
        <h2>タイムライン</h2>
        <button type="button" data-action="previous" title="前の期間（←）" aria-label="前の期間">⏮</button>
        <button type="button" data-action="play" title="再生（Space）" aria-label="再生" aria-pressed="false">▶</button>
        <button type="button" data-action="next" title="次の期間（→）" aria-label="次の期間">⏭</button>
        <span class="timeline-label" aria-live="polite"></span>
        <label class="timeline-width">幅 <select aria-label="期間の幅"></select></label>
        <span class="timeline-count"></span>
        <details class="timeline-more">
          <summary title="累積表示・再生速度・レイヤーごとの時間">設定</summary>
          <div class="timeline-settings">
            <label><input type="checkbox" name="cumulative" /> 累積（最初から期間の終わりまでを表示）</label>
            <label>再生速度 <select name="speed" aria-label="再生速度"></select></label>
            <button type="button" data-action="all">全期間を表示</button>
            <h3>レイヤーの時間</h3>
            <div class="timeline-layers"></div>
          </div>
        </details>
        <button type="button" data-action="close" class="timeline-close" title="タイムラインを閉じる（T）。すべて表示に戻ります" aria-label="タイムラインを閉じる">×</button>
      </div>
      <div class="timeline-chart">
        <canvas tabindex="0" aria-label="時間軸。ドラッグで期間を選び、矢印キーで送ります"></canvas>
        <p class="timeline-empty">時間を持つレイヤーがありません。日時の属性を持つベクターレイヤー、撮影日時の分かる画像、時間次元を持つ WMS を開くと表示されます。</p>
      </div>`;
    const q = <T extends HTMLElement>(s: string) => this.element.querySelector<T>(s)!;
    this.canvas_ = q('canvas');
    this.label_ = q('.timeline-label');
    this.count_ = q('.timeline-count');
    this.playButton_ = q('[data-action=play]');
    this.widthSelect_ = q('.timeline-width select');
    this.cumulativeBox_ = q('input[name=cumulative]');
    this.speedSelect_ = q('select[name=speed]');
    this.layersList_ = q('.timeline-layers');
    this.empty_ = q('.timeline-empty');
    for (const w of WIDTHS) this.widthSelect_.add(new Option(w === 'free' ? '自由' : `1${unitNames[w]}`, w));
    for (const s of SPEEDS) this.speedSelect_.add(new Option(`${s} 秒／コマ`, String(s)));
    this.speedSelect_.value = String(this.speed_);

    q('[data-action=previous]').addEventListener('click', () => this.step(-1));
    q('[data-action=next]').addEventListener('click', () => this.step(1));
    this.playButton_.addEventListener('click', () => this.setPlaying(!this.isPlaying()));
    q('[data-action=close]').addEventListener('click', () => this.setOpen(false));
    q('[data-action=all]').addEventListener('click', () => this.showAll());
    this.widthSelect_.addEventListener('change', () => this.setWidth(this.widthSelect_.value as TimeUnit | 'free'));
    this.cumulativeBox_.addEventListener('change', () => this.setCumulative(this.cumulativeBox_.checked));
    this.speedSelect_.addEventListener('change', () => {
      this.speed_ = Number(this.speedSelect_.value);
      if (this.isPlaying()) {
        this.setPlaying(false);
        this.setPlaying(true);
      }
    });
    options.button.addEventListener('click', () => this.setOpen(!this.open_));
    this.bindChart_();
    new ResizeObserver(() => this.draw_()).observe(this.canvas_);
  }

  /** Whether the timeline is open (and filtering). */
  isOpen(): boolean {
    return this.open_;
  }

  /** Opens the timeline (filtering by its window) or closes it (showing everything again). */
  setOpen(open: boolean): void {
    if (open === this.open_) return;
    this.open_ = open;
    this.element.hidden = !open;
    this.options.button.setAttribute('aria-pressed', String(open));
    if (!open) this.setPlaying(false);
    this.collect_();
    if (open && !this.window_) this.showAll(false);
    this.options.onToggle?.(open);
    this.apply_();
    if (open) this.canvas_.focus({ preventScroll: true });
  }

  /** The window shown, as set (the start is the beginning in 累積 mode); null before any data. */
  getWindow(): [number, number] | null {
    return this.window_ ? [...this.window_] : null;
  }

  /** The window that filters: from the beginning in 累積 mode. */
  effectiveWindow(): [number, number] | null {
    if (!this.window_) return null;
    return this.cumulative_ ? [-Infinity, this.window_[1]] : [...this.window_];
  }

  /** Sets the window (ms); with a calendar width, its start goes to the start of its step. */
  setWindow(from: number, to: number): void {
    if (!(to >= from)) [from, to] = [to, from];
    this.window_ = [from, to];
    this.apply_();
  }

  /** The window's calendar length, or `free`. */
  setWidth(width: TimeUnit | 'free'): void {
    this.width_ = width;
    this.widthSelect_.value = width;
    if (width !== 'free') {
      const from = floorTime(this.window_?.[0] ?? this.range_()?.[0] ?? Date.now(), width);
      this.window_ = [from, addTime(from, width, 1) - 1];
    }
    this.apply_();
  }

  /** Shows everything from the beginning up to the window's end (累積), or the window alone. */
  setCumulative(cumulative: boolean): void {
    this.cumulative_ = cumulative;
    this.cumulativeBox_.checked = cumulative;
    this.apply_();
  }

  /** The window over all the data, and the axis too. */
  showAll(apply = true): void {
    const range = this.range_();
    this.view_ = null;
    if (range) {
      this.width_ = 'free';
      this.widthSelect_.value = 'free';
      this.window_ = [range[0], range[1]];
    }
    if (apply) this.apply_();
  }

  /** Moves the window `by` steps (its calendar length, or its own length). */
  step(by: number): void {
    const w = this.window_;
    if (!w) return;
    if (this.width_ !== 'free') {
      const from = addTime(floorTime(w[0], this.width_), this.width_, by);
      this.window_ = [from, addTime(from, this.width_, 1) - 1];
    } else {
      const length = w[1] - w[0] + 1;
      this.window_ = [w[0] + by * length, w[1] + by * length];
    }
    this.followWindow_();
    this.apply_();
  }

  isPlaying(): boolean {
    return this.timer_ !== null;
  }

  /** Plays: the window steps forward until the data ends. */
  setPlaying(playing: boolean): void {
    if (playing === this.isPlaying()) return;
    if (!playing) {
      clearInterval(this.timer_!);
      this.timer_ = null;
    } else {
      const range = this.range_();
      if (!range || !this.window_) return;
      // A window over (nearly) everything: play in steps of about a twentieth.
      if (this.width_ === 'free' && this.window_[1] - this.window_[0] >= 0.9 * (range[1] - range[0])) {
        const unit = (['hour', 'day', 'week', 'month', 'year'] as TimeUnit[]).find((u) => stepLength({ unit: u, count: 1 }) >= (range[1] - range[0]) / 20) ?? 'year';
        this.width_ = unit;
        this.widthSelect_.value = unit;
        const from = floorTime(range[0], unit);
        this.window_ = [from, addTime(from, unit, 1) - 1];
      } else if (this.window_[1] >= range[1]) {
        // At the end: from the beginning again.
        const length = this.window_[1] - this.window_[0];
        const from = this.width_ !== 'free' ? floorTime(range[0], this.width_) : range[0];
        this.window_ = [from, this.width_ !== 'free' ? addTime(from, this.width_, 1) - 1 : from + length];
      }
      this.apply_();
      this.timer_ = setInterval(() => {
        const end = this.range_()?.[1];
        if (end === undefined || !this.window_ || this.window_[1] >= end) return this.setPlaying(false);
        this.step(1);
      }, this.speed_ * 1000);
    }
    this.playButton_.textContent = playing ? '⏸' : '▶';
    this.playButton_.setAttribute('aria-pressed', String(playing));
    this.playButton_.title = playing ? '停止（Space）' : '再生（Space）';
    this.playButton_.setAttribute('aria-label', playing ? '停止' : '再生');
  }

  /** Whether a feature of a vector layer is in the window (always, while closed or for a layer the timeline leaves alone). */
  inWindow(layer: ViewerLayer, feature: FeatureLike): boolean {
    return layer.type !== 'service' || !layer.service.style || layer.service.style.inTime(feature);
  }

  /** The features of a vector layer in the window. */
  featuresInWindow<F extends FeatureLike>(layer: ViewerLayer, features: F[]): F[] {
    const style = layer.type === 'service' ? layer.service.style : undefined;
    if (!this.open_ || !style || !this.times_.get(layer)?.on) return features;
    return features.filter((f) => style.inTime(f));
  }

  /** The time span of each feature of a vector layer, as the timeline reads it (null: the layer has no times). */
  spanOf(layer: ViewerLayer): TimeFilter['span'] | null {
    if (!this.times_.has(layer)) this.collect_();
    return this.times_.get(layer)?.span ?? null;
  }

  /** Opens the timeline on the window from `from` to `to` (one `unit` long, when given). */
  focus(from: number, to: number, unit?: TimeUnit): void {
    this.setPlaying(false);
    if (unit && WIDTHS.includes(unit)) {
      this.width_ = unit;
      this.widthSelect_.value = unit;
    } else {
      this.width_ = 'free';
      this.widthSelect_.value = 'free';
    }
    this.cumulative_ = false;
    this.cumulativeBox_.checked = false;
    this.window_ = [from, to];
    this.setOpen(true);
    this.followWindow_();
    this.apply_();
  }

  /** Whether the timeline filters `layer` now. */
  filters(layer: ViewerLayer): boolean {
    const t = this.times_.get(layer);
    return this.open_ && !!t?.on && (!!t.span || t.time != null || (layer.type === 'service' && !!layer.service.time));
  }

  /** Each layer's time settings, for a project. */
  layerState(layer: ViewerLayer): LayerTimeState | undefined {
    const t = this.times_.get(layer);
    if (!t) return undefined;
    const state: LayerTimeState = { on: t.on };
    if (t.fields) {
      state.start = t.start?.name ?? null;
      state.end = t.end?.name ?? null;
    }
    if (t.origin === 'manual' && t.time != null) state.time = t.time;
    return state;
  }

  /** Gives a layer the time settings saved in a project. */
  setLayerState(layer: ViewerLayer, state: LayerTimeState): void {
    const t = this.timeOf_(layer);
    t.on = state.on;
    if (t.fields && state.start !== undefined) {
      t.start = t.fields.find((f) => f.name === state.start) ?? null;
      t.end = t.fields.find((f) => f.name === state.end) ?? null;
      t.span = t.start ? spanReader(t.start, t.end ?? null) : null;
    }
    if (state.time !== undefined) {
      t.time = state.time;
      t.origin = 'manual';
    }
    this.scheduleCollect_();
  }

  /** The panel's state, for a project. */
  getState(): TimelineState {
    return { open: this.open_, window: this.getWindow(), width: this.width_, cumulative: this.cumulative_, speed: this.speed_ };
  }

  /** Puts the panel as saved in a project. */
  setState(state: Partial<TimelineState>): void {
    if (state.width && WIDTHS.includes(state.width)) {
      this.width_ = state.width;
      this.widthSelect_.value = state.width;
    }
    if (typeof state.cumulative === 'boolean') {
      this.cumulative_ = state.cumulative;
      this.cumulativeBox_.checked = state.cumulative;
    }
    if (state.speed && SPEEDS.includes(state.speed)) {
      this.speed_ = state.speed;
      this.speedSelect_.value = String(state.speed);
    }
    if (Array.isArray(state.window) && state.window.every(Number.isFinite)) this.window_ = [state.window[0], state.window[1]];
    if (typeof state.open === 'boolean') this.setOpen(state.open);
    this.apply_();
  }

  /** Layers were added, removed or changed: read their times again. */
  refresh(): void {
    this.scheduleCollect_();
  }

  // ---- data ----

  private timeOf_(layer: ViewerLayer): LayerTime {
    let t = this.times_.get(layer);
    if (!t) {
      t = { on: true };
      this.times_.set(layer, t);
      if (layer.type === 'image') {
        t.time = undefined;
        void imageTime(layer).then((found) => {
          if (t!.origin === 'manual') return;
          t!.time = found?.time ?? null;
          t!.origin = found?.origin;
          this.scheduleCollect_();
        });
      }
    }
    return t;
  }

  private scheduleCollect_(): void {
    if (this.collectTimer_) return;
    this.collectTimer_ = setTimeout(() => {
      this.collectTimer_ = null;
      this.collect_();
      this.apply_();
    }, 50);
  }

  /** Reads the times of every layer (vector attributes are found once there are features). */
  private collect_(): void {
    const layers = this.images.layers();
    for (const [layer, keys] of this.watched_) {
      if (layers.includes(layer)) continue;
      unByKey(keys);
      this.watched_.delete(layer);
      this.times_.delete(layer);
    }
    for (const layer of layers) {
      const t = this.timeOf_(layer);
      const vector = layer.type === 'service' ? layer.service.vector : null;
      if (vector && layer.type === 'service') {
        if (!this.watched_.has(layer)) {
          this.watched_.set(layer, [vector.source.on(['addfeature', 'removefeature', 'changefeature', 'clear'], () => this.scheduleCollect_())].flat());
        }
        const features = vector.source.getFeatures();
        if (!t.fields || (!t.fields.length && features.length)) {
          t.fields = timeFields(vector.fields, features);
          const given = layer.service.esri?.time;
          const { start, end } = defaultTimeFields(t.fields, given);
          t.start = start;
          t.end = end;
          t.span = start ? spanReader(start, end) : null;
        }
        const starts: number[] = [];
        if (t.span) {
          // The dashboard's filter counts: the chart shows what can be shown.
          const style = layer.service.style;
          for (const f of features) {
            if (style && !style.passesFilter(f)) continue;
            const s = t.span(f);
            if (s) starts.push(s[0]);
          }
        }
        t.starts = Float64Array.from(starts).sort();
      }
    }
    this.buildLayers_();
  }

  /** Every time of the data: [first, last], padded a little; null when there are none. */
  private range_(): [number, number] | null {
    let min = Infinity;
    let max = -Infinity;
    const see = (v: number) => {
      if (!Number.isFinite(v)) return;
      if (v < min) min = v;
      if (v > max) max = v;
    };
    for (const layer of this.images.layers()) {
      const t = this.times_.get(layer);
      if (!t) continue;
      if (t.starts?.length) {
        see(t.starts[0]);
        see(t.starts[t.starts.length - 1]);
        // The ends of spans.
        if (t.end && t.span && layer.type === 'service') for (const f of layer.service.vector!.source.getFeatures()) see(t.span(f)?.[1] ?? NaN);
      }
      if (t.time != null) see(t.time);
      if (layer.type === 'service' && layer.service.time?.values.length) {
        see(layer.service.time.values[0]);
        see(layer.service.time.values[layer.service.time.values.length - 1]);
      }
    }
    if (min > max) return null;
    if (min === max) return [min - 43_200_000, max + 43_200_000];
    return [min, max];
  }

  private hasData_(): boolean {
    return this.range_() !== null;
  }

  // ---- applying the window ----

  /** Filters every layer by the window, on the next frame. */
  private apply_(): void {
    if (this.frame_) return;
    this.frame_ = requestAnimationFrame(() => {
      this.frame_ = 0;
      this.applyNow_();
    });
  }

  private applyNow_(): void {
    const window = this.open_ ? this.effectiveWindow() : null;
    let shown = 0;
    let total = 0;
    for (const layer of this.images.layers()) {
      const t = this.times_.get(layer);
      const on = !!window && !!t?.on;
      if (layer.type === 'service' && layer.service.style) {
        const filter = on && t!.span ? { span: t!.span, window } : null;
        layer.service.style.setTimeFilter(filter);
        if (filter && t!.starts) {
          total += layer.service.vector!.source.getFeatures().length;
          shown += this.featuresInWindow(layer, layer.service.vector!.source.getFeatures()).length;
        }
      }
      if (layer.type === 'image') {
        const time = t?.time;
        this.images.setTimeHidden(layer, on && time != null && (time < window[0] || time > window[1]));
      }
    }
    // WMS tiles load again for every change: wait until the window rests.
    if (this.wmsTimer_) clearTimeout(this.wmsTimer_);
    this.wmsTimer_ = setTimeout(() => {
      this.wmsTimer_ = null;
      for (const layer of this.images.layers()) {
        if (layer.type !== 'service' || !layer.service.time) continue;
        const on = !!window && !!this.times_.get(layer)?.on;
        layer.service.time.set(on ? window[1] : null);
      }
    }, 250);
    const w = this.window_;
    this.label_.textContent = !this.hasData_() || !w ? '' : this.cumulative_ ? `〜 ${formatTime(w[1], this.width_ === 'free' ? 'minute' : this.width_ === 'week' ? 'day' : this.width_)}` : this.windowText_(w);
    this.count_.textContent = total ? `表示 ${shown.toLocaleString()} / ${total.toLocaleString()} 件` : '';
    this.draw_();
    this.changed();
  }

  private windowText_(w: [number, number]): string {
    if (this.width_ === 'year' || this.width_ === 'month' || this.width_ === 'day') return formatTime(w[0], this.width_);
    if (this.width_ === 'hour') return formatTime(w[0], 'minute');
    return formatSpan(w[0], w[1]);
  }

  // ---- the layer settings ----

  private buildLayers_(): void {
    const rows: HTMLElement[] = [];
    for (const layer of this.images.layers()) {
      const t = this.times_.get(layer);
      if (!t) continue;
      const row = document.createElement('div');
      row.className = 'timeline-layer';
      const on = document.createElement('input');
      on.type = 'checkbox';
      on.checked = t.on;
      on.setAttribute('aria-label', `${layer.name} を時間で絞り込む`);
      on.addEventListener('change', () => {
        t.on = on.checked;
        this.apply_();
      });
      const name = document.createElement('span');
      name.className = 'timeline-layer-name';
      name.textContent = layer.name.replace(/^.*[/\\]/, '');
      name.title = layer.name;
      row.append(on, name);
      if (layer.type === 'service' && t.fields) {
        if (!t.fields.length) {
          on.disabled = true;
          row.append(this.note_('時間の属性がありません'));
        } else row.append(this.fieldSelect_(t, 'start', '開始'), this.fieldSelect_(t, 'end', '終了'));
      } else if (layer.type === 'service' && layer.service.time) {
        row.append(this.note_(`WMS の時間（${layer.service.time.values.length} 時点）`));
      } else if (layer.type === 'image') {
        const input = document.createElement('input');
        input.type = 'datetime-local';
        input.step = '1';
        input.setAttribute('aria-label', `${layer.name} の撮影日時`);
        if (t.time != null) input.value = localInput(t.time);
        input.addEventListener('change', () => {
          const v = parseTime(input.value);
          t.time = v;
          t.origin = v === null ? undefined : 'manual';
          this.collect_();
          this.apply_();
        });
        row.append(input, this.note_(t.time === undefined ? '読み込み中…' : t.origin ? imageTimeOrigins[t.origin] : '不明（期間外でも表示）'));
      } else {
        continue;
      }
      rows.push(row);
    }
    this.layersList_.replaceChildren(...(rows.length ? rows : [this.note_('時間を持つレイヤーはありません')]));
  }

  private note_(text: string): HTMLElement {
    const s = document.createElement('span');
    s.className = 'timeline-note';
    s.textContent = text;
    return s;
  }

  private fieldSelect_(t: LayerTime, which: 'start' | 'end', label: string): HTMLElement {
    const wrap = document.createElement('label');
    wrap.append(label, ' ');
    const select = document.createElement('select');
    select.setAttribute('aria-label', `${label}の属性`);
    if (which === 'end') select.add(new Option('なし', ''));
    for (const f of t.fields!) select.add(new Option(f.name, f.name));
    select.value = t[which]?.name ?? '';
    select.addEventListener('change', () => {
      t[which] = t.fields!.find((f) => f.name === select.value) ?? null;
      t.span = t.start ? spanReader(t.start, t.end ?? null) : null;
      this.collect_();
      this.apply_();
    });
    wrap.append(select);
    return wrap;
  }

  // ---- the chart ----

  /** The axis shown: zoomed by the wheel, else all the data (with a margin). */
  private axis_(): [number, number] | null {
    if (this.view_) return this.view_;
    const range = this.range_();
    if (!range) return null;
    const pad = (range[1] - range[0]) * 0.03;
    return [range[0] - pad, range[1] + pad];
  }

  /** Keeps the window on the axis (playing past the edge of a zoomed axis scrolls it). */
  private followWindow_(): void {
    const v = this.view_;
    const w = this.window_;
    if (!v || !w) return;
    const span = v[1] - v[0];
    if (w[1] > v[1]) this.view_ = [w[1] - span * 0.9, w[1] + span * 0.1];
    else if (w[0] < v[0]) this.view_ = [w[0] - span * 0.1, w[0] + span * 0.9];
  }

  private draw_(): void {
    const canvas = this.canvas_;
    const has = this.hasData_();
    this.empty_.hidden = has;
    canvas.hidden = !has;
    if (!this.open_ || !has) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const css = getComputedStyle(this.element);
    const fg = css.getPropertyValue('--fg').trim() || '#222';
    const muted = css.getPropertyValue('--muted').trim() || '#666';
    const accent = css.getPropertyValue('--accent').trim() || '#2563eb';
    const axis = this.axis_()!;
    const x = (t: number) => ((t - axis[0]) / (axis[1] - axis[0])) * width;
    const lane = 14;
    const bottom = height - 16;
    const top = lane + 2;

    // The bars: features per step, stacked by layer.
    const step = stepAtLeast((axis[1] - axis[0]) / Math.max(1, width / 8));
    const bins = stepsBetween(floorTime(axis[0], step.unit, step.count), axis[1], step, 4000);
    const vectors = this.images.layers().filter((l): l is ViewerService => l.type === 'service' && !!this.times_.get(l)?.starts?.length);
    const counts = bins.map((b) => {
      const end = addTime(b, step.unit, step.count);
      return vectors.map((l) => {
        const s = this.times_.get(l)!.starts!;
        return lowerBound(s, end) - lowerBound(s, b);
      });
    });
    const most = Math.max(1, ...counts.map((c) => c.reduce((a, v) => a + v, 0)));
    const win = this.effectiveWindow();
    bins.forEach((b, i) => {
      const x0 = x(b);
      const x1 = x(addTime(b, step.unit, step.count));
      let y = bottom;
      const inside = !win || (b <= win[1] && addTime(b, step.unit, step.count) > win[0]);
      counts[i].forEach((c, j) => {
        if (!c) return;
        const h = (c / most) * (bottom - top);
        ctx.fillStyle = this.colorOf_(vectors[j]);
        ctx.globalAlpha = inside ? 0.85 : 0.3;
        ctx.fillRect(x0 + 0.5, y - h, Math.max(1, x1 - x0 - 1), h);
        y -= h;
      });
    });
    ctx.globalAlpha = 1;

    // Images (diamonds) and WMS times (ticks) in the lane at the top.
    this.images.layers().forEach((layer) => {
      const t = this.times_.get(layer);
      const color = this.colorOf_(layer);
      if (layer.type === 'image' && t?.time != null) {
        const cx = x(t.time);
        const hidden = !!win && t.on && (t.time < win[0] || t.time > win[1]);
        ctx.fillStyle = color;
        ctx.globalAlpha = hidden ? 0.35 : 1;
        ctx.beginPath();
        ctx.moveTo(cx, 2);
        ctx.lineTo(cx + 5, 7);
        ctx.lineTo(cx, 12);
        ctx.lineTo(cx - 5, 7);
        ctx.fill();
      } else if (layer.type === 'service' && layer.service.time) {
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        for (const v of layer.service.time.values) {
          const px = Math.round(x(v)) + 0.5;
          if (px < 0 || px > width) continue;
          ctx.moveTo(px, 3);
          ctx.lineTo(px, 11);
        }
        ctx.stroke();
      }
    });
    ctx.globalAlpha = 1;

    // The window.
    if (win) {
      const x0 = Math.max(-2, x(win[0]));
      const x1 = Math.min(width + 2, x(win[1]));
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.12;
      ctx.fillRect(x0, 0, x1 - x0, bottom);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (!this.cumulative_) {
        ctx.moveTo(x0, 0);
        ctx.lineTo(x0, bottom);
      }
      ctx.moveTo(x1, 0);
      ctx.lineTo(x1, bottom);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // The axis and its labels.
    ctx.strokeStyle = muted;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(0, bottom + 0.5);
    ctx.lineTo(width, bottom + 0.5);
    ctx.stroke();
    ctx.globalAlpha = 1;
    const labelStep = stepAtLeast((axis[1] - axis[0]) / Math.max(1, width / 110));
    ctx.fillStyle = fg;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (const t of stepsBetween(axis[0], axis[1], labelStep, 200)) {
      const px = Math.round(x(t)) + 0.5;
      ctx.strokeStyle = muted;
      ctx.beginPath();
      ctx.moveTo(px, bottom);
      ctx.lineTo(px, bottom + 4);
      ctx.stroke();
      const text = formatTime(t, labelStep.unit === 'week' ? 'day' : labelStep.unit);
      if (px + 2 + ctx.measureText(text).width <= width) ctx.fillText(text, px + 2, bottom + 3);
    }
    canvas.dataset.most = String(most);
  }

  /** A layer's color on the chart: its symbol's, for a vector layer drawn in one. */
  private colorOf_(layer: ViewerLayer): string {
    const spec = layer.type === 'service' ? layer.service.style?.get() : undefined;
    if (spec && spec.mode === 'single' && /^#[0-9a-f]{6}$/i.test(spec.symbol.fill)) return spec.symbol.fill;
    return PALETTE[this.images.layers().indexOf(layer) % PALETTE.length];
  }

  private bindChart_(): void {
    const canvas = this.canvas_;
    const timeAt = (clientX: number) => {
      const axis = this.axis_()!;
      const r = canvas.getBoundingClientRect();
      return axis[0] + ((clientX - r.left) / r.width) * (axis[1] - axis[0]);
    };
    const pxPerMs = () => {
      const axis = this.axis_()!;
      return canvas.getBoundingClientRect().width / (axis[1] - axis[0]);
    };
    let drag: { mode: 'move' | 'start' | 'end' | 'new'; at: number; from: [number, number]; moved: boolean } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.axis_()) return;
      const at = timeAt(e.clientX);
      const w = this.effectiveWindow() ?? [at, at];
      const near = 6 / pxPerMs();
      let mode: 'move' | 'start' | 'end' | 'new' = 'new';
      if (Math.abs(at - w[1]) <= near) mode = 'end';
      else if (!this.cumulative_ && Math.abs(at - w[0]) <= near) mode = 'start';
      else if (at > w[0] && at < w[1]) mode = 'move';
      drag = { mode, at, from: [...(this.window_ ?? [at, at])], moved: false };
      canvas.setPointerCapture(e.pointerId);
      this.setPlaying(false);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.axis_()) return;
      const at = timeAt(e.clientX);
      if (!drag) {
        const w = this.effectiveWindow();
        const near = 6 / pxPerMs();
        canvas.style.cursor = w && (Math.abs(at - w[1]) <= near || (!this.cumulative_ && Math.abs(at - w[0]) <= near)) ? 'ew-resize' : w && at > w[0] && at < w[1] ? 'grab' : 'crosshair';
        canvas.title = formatTime(at, 'minute');
        return;
      }
      if (Math.abs(at - drag.at) * pxPerMs() > 2) drag.moved = true;
      if (!drag.moved) return;
      const [a, b] = drag.from;
      const unit = this.width_;
      if (drag.mode === 'move') {
        let from = a + (at - drag.at);
        if (unit !== 'free') {
          from = floorTime(from + (addTime(a, unit, 1) - a) / 2, unit);
          this.window_ = [from, addTime(from, unit, 1) - 1];
        } else this.window_ = [from, b + (at - drag.at)];
      } else {
        // Stretching or drawing a window makes its width free.
        if (unit !== 'free') this.setWidth('free');
        if (drag.mode === 'start') this.window_ = [Math.min(at, b), Math.max(at, b)];
        else if (drag.mode === 'end') this.window_ = [Math.min(a, at), Math.max(a, at)];
        else this.window_ = [Math.min(drag.at, at), Math.max(drag.at, at)];
      }
      this.apply_();
    });
    const end = (e: PointerEvent) => {
      if (!drag) return;
      const click = !drag.moved;
      const at = timeAt(e.clientX);
      drag = null;
      if (!click) return;
      // A click: the window goes there, keeping its length.
      const w = this.window_;
      if (!w) return;
      if (this.width_ !== 'free') {
        const from = floorTime(at, this.width_);
        this.window_ = [from, addTime(from, this.width_, 1) - 1];
      } else if (this.cumulative_) this.window_ = [w[0], at];
      else {
        const half = (w[1] - w[0]) / 2;
        this.window_ = [at - half, at + half];
      }
      this.apply_();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', () => (drag = null));
    canvas.addEventListener(
      'wheel',
      (e) => {
        const axis = this.axis_();
        if (!axis) return;
        e.preventDefault();
        const at = timeAt(e.clientX);
        const k = Math.exp(Math.sign(e.deltaY) * 0.2);
        const span = Math.max(60_000, (axis[1] - axis[0]) * k);
        const f = (at - axis[0]) / (axis[1] - axis[0]);
        this.view_ = [at - f * span, at - f * span + span];
        this.draw_();
      },
      { passive: false },
    );
    canvas.addEventListener('dblclick', () => {
      this.view_ = null;
      this.draw_();
    });
    canvas.addEventListener('keydown', (e) => {
      const range = this.range_();
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') this.step(e.key === 'ArrowRight' ? 1 : -1);
      else if (e.key === ' ') this.setPlaying(!this.isPlaying());
      else if ((e.key === 'Home' || e.key === 'End') && range && this.window_) {
        const length = this.window_[1] - this.window_[0];
        const unit = this.width_;
        if (unit !== 'free') {
          const from = floorTime(e.key === 'Home' ? range[0] : range[1], unit);
          this.window_ = [from, addTime(from, unit, 1) - 1];
        } else this.window_ = e.key === 'Home' ? [range[0], range[0] + length] : [range[1] - length, range[1]];
        this.followWindow_();
        this.apply_();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }
}

/** The first index of a sorted array whose value is at least `v`. */
function lowerBound(a: Float64Array, v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** `yyyy-MM-ddTHH:mm:ss` in local time, for a datetime-local input. */
function localInput(t: number): string {
  const d = new Date(t);
  const p = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
