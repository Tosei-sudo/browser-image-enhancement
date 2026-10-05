/**
 * Histogram of the selected image as shown: the pixels of the visible area,
 * after the correction (or before it, as OpenLayers drew the tiles), per
 * R, G, B or of the gray level. It follows the view and the correction
 * sliders; pointing at it reads the counts of one value.
 */
import type OlMap from 'ol/Map.js';
import type BaseLayer from 'ol/layer/Base.js';
import type RenderEvent from 'ol/render/Event.js';
import { unByKey } from 'ol/Observable.js';
import type { EventsKey } from 'ol/events.js';
import { histogram, type ColorMode, type Histogram } from 'browser-image-enhancement';
import { GpuCorrectedTileLayer } from 'browser-image-enhancement/openlayers';

/** Summary of one channel of a histogram (8-bit codes). */
export interface ChannelStats {
  min: number;
  max: number;
  mean: number;
  median: number;
  count: number;
}

/** Minimum, maximum, mean and median of one channel's 256 bins; null when it counted nothing. */
export function channelStats(bins: ArrayLike<number>): ChannelStats | null {
  let count = 0;
  let sum = 0;
  let min = -1;
  let max = -1;
  for (let v = 0; v < bins.length; v++) {
    const c = bins[v];
    if (!c) continue;
    if (min < 0) min = v;
    max = v;
    count += c;
    sum += c * v;
  }
  if (count === 0) return null;
  let median = min;
  for (let v = min, seen = 0; v <= max; v++) {
    seen += bins[v];
    if (seen >= count / 2) {
      median = v;
      break;
    }
  }
  return { min, max, mean: sum / count, median, count };
}

/**
 * Bar heights 0-1 for the bins of every channel, on one scale. Linear: the
 * tallest bin away from 0 and 255 is full height (the ends, where clipped
 * pixels pile up, may go over and are cut). Logarithmic: log(1 + count).
 */
export function barHeights(channels: ReadonlyArray<ArrayLike<number>>, log: boolean): Float32Array[] {
  let peak = 0;
  for (const bins of channels) {
    for (let v = log ? 0 : 1; v < (log ? bins.length : bins.length - 1); v++) peak = Math.max(peak, bins[v]);
  }
  if (!log && peak === 0) for (const bins of channels) for (let v = 0; v < bins.length; v++) peak = Math.max(peak, bins[v]);
  const scale = log ? Math.log1p(peak) : peak;
  return channels.map((bins) => {
    const out = new Float32Array(bins.length);
    if (scale > 0) for (let v = 0; v < bins.length; v++) out[v] = Math.min(1, (log ? Math.log1p(bins[v]) : bins[v]) / scale);
    return out;
  });
}

/** Options for {@link HistogramPanel}. */
export interface HistogramPanelOptions {
  /** The toggle button (its `aria-pressed` follows the panel). */
  button: HTMLButtonElement;
  /** The element the panel is built in (hidden while closed). */
  element: HTMLElement;
}

/** Longest side of the copy of the map the histogram is counted from. */
const SAMPLE = 512;
const COLORS = ['#e5484d', '#30a46c', '#3e7bfa'];
const NAMES = ['R', 'G', 'B'];

/** The histogram panel of the information section. */
export class HistogramPanel {
  private layer_: GpuCorrectedTileLayer | null = null;
  private colorMode_: () => ColorMode | null = () => null;
  private open_ = false;
  private keys_: EventsKey[] = [];
  private framesAtDraw_ = -1;
  private timer_: ReturnType<typeof setTimeout> | undefined;
  private readonly before_ = sampleContext();
  private readonly after_ = sampleContext();
  /** Whether the last frame was corrected (else after = before). */
  private corrected_ = false;
  private shown_: Histogram | null = null;
  private readonly canvas_: HTMLCanvasElement;
  private readonly note_: HTMLParagraphElement;
  private readonly stats_: HTMLTableElement;
  private readonly readout_: HTMLParagraphElement;
  private readonly which_: HTMLSelectElement;
  private readonly log_: HTMLInputElement;

  constructor(
    private readonly map: OlMap,
    private readonly options: HistogramPanelOptions,
  ) {
    const { element } = options;
    element.classList.add('histogram');
    element.hidden = true;
    const controls = document.createElement('div');
    controls.className = 'histogram-controls';
    this.which_ = document.createElement('select');
    this.which_.setAttribute('aria-label', 'ヒストグラムの対象');
    this.which_.append(new Option('補正後', 'after'), new Option('補正前', 'before'));
    this.which_.addEventListener('change', () => this.update_());
    const logLabel = document.createElement('label');
    this.log_ = document.createElement('input');
    this.log_.type = 'checkbox';
    this.log_.addEventListener('change', () => this.draw_());
    logLabel.append(this.log_, '対数');
    logLabel.title = '縦軸を対数にして、少ない値も見えるようにします';
    controls.append(this.which_, logLabel);
    this.canvas_ = document.createElement('canvas');
    this.canvas_.width = 256;
    this.canvas_.height = 100;
    this.canvas_.setAttribute('role', 'img');
    this.canvas_.setAttribute('aria-label', 'ヒストグラム');
    this.canvas_.addEventListener('pointermove', (e) => this.read_(e));
    this.canvas_.addEventListener('pointerleave', () => (this.readout_.textContent = ''));
    this.readout_ = document.createElement('p');
    this.readout_.className = 'histogram-readout';
    this.stats_ = document.createElement('table');
    this.stats_.className = 'histogram-stats';
    this.note_ = document.createElement('p');
    this.note_.className = 'histogram-note';
    element.append(controls, this.canvas_, this.readout_, this.stats_, this.note_);
    options.button.addEventListener('click', () => this.setOpen(!this.open_));
  }

  isOpen(): boolean {
    return this.open_;
  }

  setOpen(open: boolean): void {
    this.open_ = open;
    this.options.button.setAttribute('aria-pressed', String(open));
    this.options.element.hidden = !open;
    this.attach_();
  }

  /** The layer to count: the selected one (null, or a layer that is not an image, shows a note). */
  setLayer(layer: BaseLayer | null, colorMode: () => ColorMode | null = () => null): void {
    this.layer_ = layer instanceof GpuCorrectedTileLayer ? layer : null;
    this.colorMode_ = colorMode;
    this.shown_ = null;
    this.attach_();
    if (!layer) this.message_('レイヤーを選ぶと、表示範囲のヒストグラムを表示します');
    else if (!this.layer_) this.message_('このレイヤーにはヒストグラムがありません（画像・WMS・WMTS のみ）');
  }

  /** The histogram shown (for tests and the console); null before the first count. */
  getHistogram(): Histogram | null {
    return this.shown_;
  }

  /** Copies each frame of the layer while the panel is open; counts once the map is still. */
  private attach_(): void {
    unByKey(this.keys_);
    this.keys_ = [];
    clearTimeout(this.timer_);
    const layer = this.layer_;
    if (!this.open_ || !layer) return;
    this.keys_.push(
      // The tiles as drawn, before the GPU corrects them (the canvas is still this layer's here).
      layer.on('postrender', (e: RenderEvent) => {
        const gl = e.context as WebGLRenderingContext | undefined;
        if (!gl?.canvas || !copyInto(this.before_, gl.canvas as HTMLCanvasElement)) return;
        this.framesAtDraw_ = layer.frames;
      }),
      // After every layer has rendered: the corrected picture, if this frame was corrected.
      this.map.on('postrender', () => {
        if (this.framesAtDraw_ < 0) return;
        this.corrected_ = layer.frames > this.framesAtDraw_ && copyInto(this.after_, layer.getOutputCanvas());
        this.framesAtDraw_ = -1;
        clearTimeout(this.timer_);
        this.timer_ = setTimeout(() => this.update_(), 150);
      }),
    );
    layer.changed();
  }

  /** Counts the last copied frame and draws it. */
  private update_(): void {
    if (!this.open_ || !this.layer_) return;
    const source = this.which_.value === 'after' && this.corrected_ ? this.after_ : this.before_;
    const { width, height } = source.canvas;
    if (!width || !height) return;
    const mode = this.colorMode_() === 'gray' ? 'gray' : 'rgb';
    this.shown_ = histogram(source.getImageData(0, 0, width, height), { colorMode: mode });
    this.draw_();
  }

  private message_(text: string): void {
    const ctx = this.canvas_.getContext('2d');
    ctx?.clearRect(0, 0, this.canvas_.width, this.canvas_.height);
    this.stats_.replaceChildren();
    this.readout_.textContent = '';
    this.note_.textContent = text;
  }

  private draw_(): void {
    const h = this.shown_;
    if (!h) return;
    if (h.count === 0) {
      this.message_('表示範囲に画素がありません');
      return;
    }
    const ctx = this.canvas_.getContext('2d')!;
    const { width, height } = this.canvas_;
    ctx.clearRect(0, 0, width, height);
    const heights = barHeights(h.bins, this.log_.checked);
    const gray = h.mode === 'gray';
    // Additive: where R, G and B overlap the bars turn white, as in photo editors.
    ctx.globalCompositeOperation = gray ? 'source-over' : 'lighter';
    heights.forEach((bars, c) => {
      ctx.fillStyle = gray ? '#9aa0a6' : COLORS[c];
      ctx.globalAlpha = gray ? 1 : 0.85;
      for (let v = 0; v < bars.length; v++) {
        const bar = bars[v] * height;
        if (bar > 0) ctx.fillRect(v, height - bar, 1, bar);
      }
    });
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    const header = document.createElement('tr');
    for (const text of ['', '最小', '平均', '中央', '最大']) header.append(cell('th', text));
    const rows = h.bins.map((bins, c) => {
      const s = channelStats(bins);
      const row = document.createElement('tr');
      const name = cell('th', gray ? '輝度' : NAMES[c]);
      if (!gray) name.style.color = COLORS[c];
      row.append(name, ...(s ? [s.min, s.mean.toFixed(1), s.median, s.max] : ['-', '-', '-', '-']).map((v) => cell('td', String(v))));
      return row;
    });
    this.stats_.replaceChildren(header, ...rows);
    const which = this.which_.value === 'after' && !this.corrected_ ? '補正前（補正なし）' : this.which_.selectedOptions[0].text;
    this.note_.textContent = `表示範囲の ${h.count.toLocaleString()} 画素・${which}`;
  }

  /** The counts of the value under the pointer. */
  private read_(e: PointerEvent): void {
    const h = this.shown_;
    if (!h || !h.count) return;
    // Inside the border: the bars span the canvas's content box.
    const x = e.clientX - this.canvas_.getBoundingClientRect().left - this.canvas_.clientLeft;
    const v = Math.min(255, Math.max(0, Math.floor((x / this.canvas_.clientWidth) * 256)));
    const counts = h.bins.map((bins, c) => `${h.mode === 'gray' ? '輝度' : NAMES[c]} ${bins[v].toLocaleString()}`);
    this.readout_.textContent = `値 ${v}: ${counts.join('・')}`;
  }
}

function sampleContext(): CanvasRenderingContext2D {
  return document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
}

/** Draws `from` scaled down into `ctx` (at most SAMPLE px on its long side); false when it is empty. */
function copyInto(ctx: CanvasRenderingContext2D, from: HTMLCanvasElement): boolean {
  if (!from.width || !from.height) return false;
  const scale = Math.min(1, SAMPLE / Math.max(from.width, from.height));
  const width = Math.max(1, Math.round(from.width * scale));
  const height = Math.max(1, Math.round(from.height * scale));
  if (ctx.canvas.width !== width || ctx.canvas.height !== height) {
    ctx.canvas.width = width;
    ctx.canvas.height = height;
  } else ctx.clearRect(0, 0, width, height);
  // Nearest pixels: no blended values (or half-transparent edges) that are not on the screen.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(from, 0, 0, width, height);
  return true;
}

function cell(tag: 'th' | 'td', text: string): HTMLTableCellElement {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}
