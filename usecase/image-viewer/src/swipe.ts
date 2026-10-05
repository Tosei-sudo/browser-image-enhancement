/**
 * Swipe comparison: the selected layer is drawn on one side of a line across
 * the map only, so the layers beneath show on the other side. Dragging the
 * line (or its handle with the arrow keys) moves it; a double click on the
 * handle turns it between a vertical line (layer on the left) and a
 * horizontal one (layer on top).
 *
 * WebGL layers (the images) are cut with the scissor test, so the GPU
 * correction only sees their visible part; canvas layers (vectors, base
 * maps) with a clip path.
 */
import type OlMap from 'ol/Map.js';
import type BaseLayer from 'ol/layer/Base.js';
import type Layer from 'ol/layer/Layer.js';
import LayerGroup from 'ol/layer/Group.js';
import type RenderEvent from 'ol/render/Event.js';
import { getRenderPixel } from 'ol/render.js';
import { unByKey } from 'ol/Observable.js';
import type { EventsKey } from 'ol/events.js';

/** `vertical`: a vertical line, the layer on its left. `horizontal`: a horizontal line, the layer above it. */
export type SwipeOrientation = 'vertical' | 'horizontal';

/** A rectangle in CSS pixels of the map: `[left, top, right, bottom]`. */
export type ScreenRect = [number, number, number, number];

/** The part of a map of `size` (CSS pixels) where the swiped layer is drawn, with the line at `position` (0-1). */
export function swipeRect(orientation: SwipeOrientation, position: number, size: [number, number]): ScreenRect {
  const p = Math.min(1, Math.max(0, position));
  const [width, height] = size;
  return orientation === 'vertical' ? [0, 0, Math.round(width * p), height] : [0, 0, width, Math.round(height * p)];
}

/** Options for {@link SwipeTool}. */
export interface SwipeToolOptions {
  /** The toggle button (its `aria-pressed` follows the state). */
  button: HTMLButtonElement;
  /** Status line. */
  say: (message: string) => void;
}

/** The swipe line over the map and the clipping of the swiped layer. */
export class SwipeTool {
  private layer_: BaseLayer | null = null;
  private name_ = '';
  private keys_: EventsKey[] = [];
  /** The swiped layers' own class names, while they have the swipe's. */
  private readonly classNames_ = new Map<Layer, string>();
  private active_ = false;
  private position_ = 0.5;
  private orientation_: SwipeOrientation = 'vertical';
  private readonly bar_: HTMLDivElement;
  private readonly handle_: HTMLDivElement;

  constructor(
    private readonly map: OlMap,
    private readonly options: SwipeToolOptions,
  ) {
    this.bar_ = document.createElement('div');
    this.bar_.className = 'swipe-bar';
    this.bar_.hidden = true;
    this.handle_ = document.createElement('div');
    this.handle_.className = 'swipe-handle';
    this.handle_.tabIndex = 0;
    this.handle_.setAttribute('role', 'slider');
    this.handle_.setAttribute('aria-valuemin', '0');
    this.handle_.setAttribute('aria-valuemax', '100');
    this.handle_.title = 'ドラッグで移動・ダブルクリックで縦／横の切り替え・Esc で終了';
    this.bar_.append(this.handle_);
    // Over the map but outside OpenLayers' own event handling, so dragging the line does not pan.
    map.getViewport().append(this.bar_);
    this.bindDrag_();
    options.button.addEventListener('click', () => this.setActive(!this.active_));
    map.on('change:size', () => this.place_());
  }

  /** Whether the swipe is on. */
  isActive(): boolean {
    return this.active_;
  }

  /** Turns the swipe on or off. */
  setActive(active: boolean): void {
    if (active === this.active_) return;
    this.active_ = active;
    this.options.button.setAttribute('aria-pressed', String(active));
    this.bar_.hidden = !active;
    this.attach_();
    if (active) {
      this.place_();
      this.options.say(this.layer_ ? `${this.name_} を線の${this.side_()}だけに表示しています。下のレイヤーと見比べられます` : 'レイヤーを選ぶと、線の片側だけに表示して見比べられます');
    }
  }

  /** The layer to swipe: the selected one (null for none). */
  setLayer(layer: BaseLayer | null, name = ''): void {
    if (layer === this.layer_) return;
    this.layer_ = layer;
    this.name_ = name;
    this.attach_();
  }

  /** Where the line is, 0-1 from the left (or the top). */
  getPosition(): number {
    return this.position_;
  }

  /** Moves the line, 0-1 from the left (or the top). */
  setPosition(position: number): void {
    this.position_ = Math.min(1, Math.max(0, position));
    this.place_();
    this.map.render();
  }

  getOrientation(): SwipeOrientation {
    return this.orientation_;
  }

  setOrientation(orientation: SwipeOrientation): void {
    this.orientation_ = orientation;
    this.place_();
    this.map.render();
  }

  private side_(): string {
    return this.orientation_ === 'vertical' ? '左側' : '上側';
  }

  /** Clips the swiped layer (every layer of a group) while the swipe is on. */
  private attach_(): void {
    unByKey(this.keys_);
    this.keys_ = [];
    for (const [layer, className] of this.classNames_) setClassName(layer, className);
    this.classNames_.clear();
    if (this.active_ && this.layer_) {
      for (const layer of layersOf(this.layer_)) {
        // A class of its own gives the layer a canvas of its own: OpenLayers draws neighbouring layers
        // of one class into one canvas, which the scissor would cut (or leave stale) for all of them.
        this.classNames_.set(layer, layer.getClassName());
        setClassName(layer, `${layer.getClassName()} swipe-layer`);
        this.keys_.push(
          layer.on('prerender', (e) => this.clip_(e)),
          layer.on('postrender', (e) => this.unclip_(e)),
        );
      }
    }
    this.map.render();
  }

  private clip_(e: RenderEvent): void {
    const size = this.map.getSize();
    const context = e.context;
    if (!size || !context) return;
    const [left, top, right, bottom] = swipeRect(this.orientation_, this.position_, size as [number, number]);
    if (isWebGL(context)) {
      // The canvas is the layer's own (see attach_): clear it whole, as the scissor will keep
      // OpenLayers from clearing the other side, then let the layer draw only its side.
      const ratio = e.frameState?.pixelRatio ?? 1;
      const height = context.drawingBufferHeight;
      context.disable(context.SCISSOR_TEST);
      context.clearColor(0, 0, 0, 0);
      context.clear(context.COLOR_BUFFER_BIT);
      context.enable(context.SCISSOR_TEST);
      const x = Math.round(left * ratio);
      const y = Math.round(height - bottom * ratio);
      context.scissor(x, y, Math.max(0, Math.round(right * ratio) - x), Math.max(0, Math.round(height - top * ratio) - y));
      return;
    }
    // Canvas: the rectangle's corners in the canvas's own pixels (it may be rotated or scaled).
    const corners = [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ].map((p) => getRenderPixel(e, p));
    context.save();
    context.beginPath();
    corners.forEach(([x, y], i) => (i ? context.lineTo(x, y) : context.moveTo(x, y)));
    context.closePath();
    context.clip();
  }

  private unclip_(e: RenderEvent): void {
    const context = e.context;
    if (!context) return;
    if (isWebGL(context)) context.disable(context.SCISSOR_TEST);
    else context.restore();
  }

  /** Puts the line where it belongs. */
  private place_(): void {
    const vertical = this.orientation_ === 'vertical';
    this.bar_.classList.toggle('horizontal', !vertical);
    const percent = `${this.position_ * 100}%`;
    this.bar_.style.left = vertical ? percent : '';
    this.bar_.style.top = vertical ? '' : percent;
    this.handle_.setAttribute('aria-valuenow', String(Math.round(this.position_ * 100)));
    this.handle_.setAttribute('aria-label', `スワイプの位置（${vertical ? '左から' : '上から'}）`);
  }

  private bindDrag_(): void {
    const bar = this.bar_;
    const move = (e: PointerEvent) => {
      const rect = this.map.getViewport().getBoundingClientRect();
      const p = this.orientation_ === 'vertical' ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height;
      if (Number.isFinite(p)) this.setPosition(p);
    };
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      bar.setPointerCapture(e.pointerId);
      bar.classList.add('dragging');
      move(e);
    });
    bar.addEventListener('pointermove', (e) => {
      if (bar.hasPointerCapture(e.pointerId)) move(e);
    });
    const end = (e: PointerEvent) => {
      if (bar.hasPointerCapture(e.pointerId)) bar.releasePointerCapture(e.pointerId);
      bar.classList.remove('dragging');
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
    this.handle_.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.setOrientation(this.orientation_ === 'vertical' ? 'horizontal' : 'vertical');
      this.options.say(`スワイプを${this.orientation_ === 'vertical' ? '縦線（左右で比較）' : '横線（上下で比較）'}にしました`);
    });
    this.handle_.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.1 : 0.01;
      const back = this.orientation_ === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
      const forward = this.orientation_ === 'vertical' ? 'ArrowRight' : 'ArrowDown';
      if (e.key === back) this.setPosition(this.position_ - step);
      else if (e.key === forward) this.setPosition(this.position_ + step);
      else if (e.key === 'Home') this.setPosition(0);
      else if (e.key === 'End') this.setPosition(1);
      else if (e.key === 'Escape') this.setActive(false);
      else return;
      e.preventDefault();
    });
  }
}

/** The layers that draw for `layer`: itself, or every layer of a group. */
function layersOf(layer: BaseLayer): Layer[] {
  return layer instanceof LayerGroup ? layer.getLayersArray() : [layer as Layer];
}

/**
 * Changes a layer's class name, which OpenLayers only takes as an option (it decides which
 * layers share a canvas). The renderer makes a new canvas for the layer on its next frame.
 */
function setClassName(layer: Layer, className: string): void {
  (layer as unknown as { className_: string }).className_ = className;
  layer.changed();
}

function isWebGL(context: NonNullable<RenderEvent['context']>): context is WebGLRenderingContext {
  return typeof WebGLRenderingContext !== 'undefined' && (context instanceof WebGLRenderingContext || (typeof WebGL2RenderingContext !== 'undefined' && context instanceof WebGL2RenderingContext));
}
