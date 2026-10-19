/**
 * Vector layers with many features drawn on the GPU. A layer of more than
 * {@link glVector}`.threshold` features, drawn with one symbol or colored by
 * an attribute, gets a WebGL layer next to it that draws its points, lines
 * and polygons; the layer itself (a canvas layer) then draws only the labels,
 * so they keep their halo and are still left out where they overlap.
 *
 * The WebGL layer ({@link GlVectorLayer}) keeps each feature's shape on the
 * GPU from when it is added or reshaped, and draws it in the colors worked
 * out from the style. Features hidden by their category or a filter keep
 * their shape there, undrawn, so showing them again is only a change of
 * colors. Layers drawn in the service's own style (Esri renderers) stay on
 * the canvas.
 *
 * Clicks are matched to features by their geometry ({@link GlVector.featureAt}),
 * with the same tolerance as the canvas layers.
 *
 * The timeline's filter ({@link TimeFilter}): each feature carries its time
 * span, and moving the window only changes what the shaders compare it with.
 */
import type Feature from 'ol/Feature.js';
import type Map from 'ol/Map.js';
import { unByKey } from 'ol/Observable.js';
import type { EventsKey } from 'ol/events.js';
import type { Coordinate } from 'ol/coordinate.js';
import type Geometry from 'ol/geom/Geometry.js';
import type VectorLayer from 'ol/layer/Vector.js';
import type VectorSource from 'ol/source/Vector.js';
import type { VectorSourceEvent } from 'ol/source/Vector.js';
import type { Pixel } from 'ol/pixel.js';
import { asArray } from 'ol/color.js';
import type RegularShape from 'ol/style/RegularShape.js';
import { isLine, styleFunction, type LineDash, type VectorStyleSpec } from './vector-style.js';
import type { TimeFilter } from './time.js';
import { GlVectorLayer, type GlSymbol } from './gl-vector-layer.js';

/** Times on the GPU: minutes since 2000 (32-bit floats keep minutes exact for decades either side). */
const TIME_ORIGIN = Date.UTC(2000, 0, 1);
const NEVER = 1e9;
function glMinutes(t: number): number {
  if (t === -Infinity) return -NEVER;
  if (t === Infinity) return NEVER;
  return (t - TIME_ORIGIN) / 60_000;
}
/** The style variables of a time window. */
function timeVariables(window: TimeFilter['window']): { timeStart: number; timeEnd: number } {
  return { timeStart: Math.floor(glMinutes(window[0])), timeEnd: Math.ceil(glMinutes(window[1])) };
}

/** When vector layers are drawn on the GPU. */
export const glVector = {
  /**
   * `auto`: layers of more than `threshold` features, when the browser has a
   * GPU; `always` / `never` (`?vectorgl=` links).
   */
  mode: 'auto' as 'auto' | 'always' | 'never',
  threshold: 5_000,
  /** Whether WebGL runs on a GPU; found out when first needed ({@link hasFastGpu}). */
  fastGpu: undefined as boolean | undefined,
};

/**
 * Whether WebGL runs on a GPU. Where it is drawn in software (no GPU, a
 * blocked driver, some virtual machines) the canvas is faster.
 */
export function hasFastGpu(): boolean {
  if (glVector.fastGpu === undefined) {
    try {
      const canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
      const gl = canvas?.getContext('webgl2', { failIfMajorPerformanceCaveat: true });
      glVector.fastGpu = !!gl;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      glVector.fastGpu = false;
    }
  }
  return glVector.fastGpu;
}

/** Whether a layer of `count` features drawn with `spec` is drawn on the GPU. */
export function drawsOnGpu(spec: VectorStyleSpec, count: number): boolean {
  if (spec.mode === 'own' || glVector.mode === 'never') return false;
  return glVector.mode === 'always' || (count > glVector.threshold && hasFastGpu());
}

/** The colors (`[r, g, b, a]`) and line width a feature is drawn with. */
export interface Paint {
  fill: number[];
  stroke: number[];
  width: number;
}

const none = [0, 0, 0, 0];
type Kind = 'point' | 'line' | 'area';

function kindOf(geometry: Geometry | undefined): Kind {
  const type = geometry?.getType();
  if (type === 'Point' || type === 'MultiPoint') return 'point';
  return isLine(type) ? 'line' : 'area';
}

/**
 * The paint of each feature under `spec` (null: not drawn): the colors of the
 * canvas style's symbols, so both draw a feature alike whatever the mode.
 */
export function painter(spec: VectorStyleSpec): (feature: Feature) => Paint | null {
  const symbols = styleFunction({ ...spec, label: { ...spec.label, field: null } });
  return (feature) => {
    const out = symbols(feature, 1);
    const style = Array.isArray(out) ? out[0] : out;
    if (!style) return null;
    // Points: the marker (a circle or a regular shape, both with a fill and a stroke).
    const shape = kindOf(feature.getGeometry()) === 'point' ? (style.getImage() as RegularShape | null) : style;
    if (!shape) return null;
    const stroke = shape.getStroke();
    const width = stroke?.getWidth() ?? 0;
    return { fill: colorOf(shape.getFill()?.getColor()), stroke: width > 0 ? colorOf(stroke?.getColor()) : none, width };
  };
}

function colorOf(color: unknown): number[] {
  return typeof color === 'string' || Array.isArray(color) ? [...asArray(color as string | number[])] : none;
}

const dashes: Record<LineDash, number[] | undefined> = { solid: undefined, dash: [10, 6], dot: [1, 5], dashdot: [10, 5, 1, 5] };

/** The point symbol (sizes in CSS pixels) and line dash pattern of `spec`, as the canvas style draws them. */
export function glSymbol(spec: VectorStyleSpec): { symbol: GlSymbol; dash: number[] } {
  const s = spec.symbol;
  const radius = Math.max(1, s.size / 2);
  const dash = dashes[s.dash] ?? [];
  switch (s.shape) {
    case 'square':
      return { symbol: { kind: 'polygon', points: 4, radius: radius * Math.SQRT2, angle: Math.PI / 4 }, dash };
    case 'triangle':
      return { symbol: { kind: 'polygon', points: 3, radius: radius * 1.2, angle: 0 }, dash };
    case 'diamond':
      return { symbol: { kind: 'polygon', points: 4, radius: radius * 1.2, angle: 0 }, dash };
    case 'star':
      return { symbol: { kind: 'polygon', points: 5, radius: radius * 1.3, radius2: radius * 0.55, angle: 0 }, dash };
    case 'cross':
    case 'x':
      // Two lines in the outline color.
      return { symbol: { kind: 'cross', arm: radius * 1.2, line: Math.max(2, s.size / 5), angle: s.shape === 'x' ? Math.PI / 4 : 0 }, dash };
    default:
      return { symbol: { kind: 'circle', radius }, dash };
  }
}

/** Properties of the canvas layer the WebGL layer follows. */
const followed = ['visible', 'opacity', 'extent', 'minResolution', 'maxResolution', 'minZoom', 'maxZoom'];

/**
 * The WebGL drawing of one vector layer. It is on the map while the layer
 * is, just under it (so the labels are on top), and follows its visibility
 * and opacity. The features' shapes go to the GPU once; restyling, hiding
 * and the timeline's window change only what each is drawn in (see
 * {@link GlVectorLayer}).
 */
export class GlVector {
  /** The paint of each feature drawn (hidden ones are kept by the WebGL layer, unpainted). */
  private readonly paints_ = new globalThis.Map<Feature, Paint>();
  private readonly drawn_: GlVectorLayer;
  private attached_ = false;
  private paint_: (feature: Feature) => Paint | null;
  private radius_: number;
  private readonly keys_: EventsKey[];
  private time_: TimeFilter | null;
  private filter_: ((feature: Feature) => boolean) | null;

  constructor(
    readonly layer: VectorLayer,
    spec: VectorStyleSpec,
    time: TimeFilter | null = null,
    filter: ((feature: Feature) => boolean) | null = null,
  ) {
    this.time_ = time;
    this.filter_ = filter;
    this.paint_ = painter(spec);
    this.radius_ = spec.symbol.size / 2;
    this.drawn_ = new GlVectorLayer({ className: 'ol-layer gl-vector' });
    this.applySymbol_(spec);
    this.drawn_.setTimeWindow(time ? windowOf(time.window) : null);
    const source = this.source_();
    for (const feature of source.getFeatures()) this.draw_(feature);
    this.keys_ = [
      source.on('addfeature', (e: VectorSourceEvent<Feature>) => this.draw_(e.feature!)),
      source.on('removefeature', (e: VectorSourceEvent<Feature>) => this.removed_(e.feature!)),
      source.on('changefeature', (e: VectorSourceEvent<Feature>) => this.draw_(e.feature!)),
      source.on('clear', () => {
        this.paints_.clear();
        this.drawn_.clearFeatures();
      }),
      layer.on('propertychange', (e) => {
        // Added to or taken off the map.
        if (e.key === 'map') return this.attach_();
        if (e.key === 'zIndex') this.drawn_.setZIndex(this.zIndex_());
        else if (followed.includes(e.key)) this.drawn_.set(e.key, layer.get(e.key));
      }),
    ];
    for (const key of followed) {
      const value = layer.get(key);
      if (value !== undefined) this.drawn_.set(key, value);
    }
    this.drawn_.setZIndex(this.zIndex_());
    this.idle_(!spec.label.field);
    this.attach_();
  }

  /** Draws with `spec` from now on. */
  setSpec(spec: VectorStyleSpec): void {
    this.paint_ = painter(spec);
    this.radius_ = spec.symbol.size / 2;
    this.applySymbol_(spec);
    this.idle_(!spec.label.field);
    this.repaint_();
  }

  /**
   * Whether the canvas layer skips drawing (no labels to draw). Without a
   * style it would still go through every feature in view each frame, a
   * tenth of a second for 200,000 features.
   */
  private idle_(idle: boolean): void {
    const layer = this.layer as unknown as { render?: () => null };
    if (idle) layer.render = () => null;
    else delete layer.render;
  }

  /**
   * Draws only the features whose time span meets the window (null: all).
   * The same `span` function with another window only moves the window.
   */
  setTime(time: TimeFilter | null): void {
    if (!time && !this.time_) return;
    const same = !!time && !!this.time_ && time.span === this.time_.span;
    this.time_ = time;
    this.drawn_.setTimeWindow(time ? windowOf(time.window) : null);
    if (!same) this.repaint_();
  }

  /** Draws only the features `filter` passes (null: all). */
  setFilter(filter: ((feature: Feature) => boolean) | null): void {
    this.filter_ = filter;
    this.repaint_();
  }

  /** What each feature is drawn in, worked out again (their shapes stay on the GPU). */
  private repaint_(): void {
    for (const feature of this.source_().getFeatures()) this.draw_(feature);
  }

  private applySymbol_(spec: VectorStyleSpec): void {
    const { symbol, dash } = glSymbol(spec);
    this.drawn_.setSymbol(symbol, dash);
  }

  /** The time attributes of a feature. */
  private timeOf_(feature: Feature): { t0: number; t1: number } | null {
    if (!this.time_) return null;
    const span = this.time_.span(feature);
    return span ? { t0: glMinutes(span[0]), t1: glMinutes(span[1]) } : { t0: NEVER, t1: -NEVER };
  }

  /**
   * The feature drawn at `pixel` (within `tolerance` pixels of a point or
   * line, or inside a polygon); points first, then lines, then the smallest
   * polygon.
   */
  featureAt(map: Map, pixel: Pixel, tolerance = 4): Feature | undefined {
    const resolution = map.getView().getResolution();
    const at = map.getCoordinateFromPixel(pixel);
    if (!resolution || !at) return undefined;
    const reach = (tolerance + this.radius_ + 2) * resolution;
    let best: { feature: Feature; rank: number; score: number } | undefined;
    for (const feature of this.source_().getFeaturesInExtent([at[0] - reach, at[1] - reach, at[0] + reach, at[1] + reach])) {
      const paint = this.paints_.get(feature);
      const geometry = feature.getGeometry();
      if (!paint || !geometry || !this.inWindow_(feature)) continue;
      const kind = kindOf(geometry);
      const width = paint.width / 2;
      let score: number;
      if (kind === 'area' && geometry.intersectsCoordinate(at)) score = areaOf(geometry);
      else {
        const pad = (kind === 'point' ? this.radius_ : width) + tolerance;
        const distance = distanceTo(geometry, at) / resolution;
        if (distance > pad) continue;
        score = distance;
      }
      const rank = kind === 'point' ? 0 : kind === 'line' ? 1 : 2;
      if (!best || rank < best.rank || (rank === best.rank && score < best.score)) best = { feature, rank, score };
    }
    return best?.feature;
  }

  /** Takes the drawing off the map and lets go of the features. */
  dispose(): void {
    this.idle_(false);
    unByKey(this.keys_);
    this.detach_();
    this.paints_.clear();
    this.drawn_.clearFeatures();
    this.drawn_.dispose();
  }

  /** Whether `feature` is inside the timeline's window (always, without one). */
  private inWindow_(feature: Feature): boolean {
    if (!this.time_) return true;
    const span = this.time_.span(feature);
    return !!span && span[0] <= this.time_.window[1] && span[1] >= this.time_.window[0];
  }

  private source_(): VectorSource<Feature> {
    return this.layer.getSource() as VectorSource<Feature>;
  }

  private zIndex_(): number {
    // Just under the layer, above the layer under it (z-indexes of the list are whole numbers).
    return (this.layer.getZIndex() ?? 0) - 0.5;
  }

  private attach_(): void {
    const map = this.layer.getMapInternal();
    if (!map) return this.detach_();
    this.drawn_.setMap(map);
    this.attached_ = true;
  }

  private detach_(): void {
    if (!this.attached_) return;
    this.attached_ = false;
    this.drawn_.setMap(null);
    // A WebGL context is kept until it is let go; the shapes are kept for when the layer is back.
    this.drawn_.release();
  }

  /** Gives the WebGL layer `feature` as it is now: its shape (when changed) and what it is drawn in. */
  private draw_(feature: Feature): void {
    const paint = this.filter_ && !this.filter_(feature) ? null : this.paint_(feature);
    if (paint) this.paints_.set(feature, paint);
    else this.paints_.delete(feature);
    this.drawn_.draw(feature, paint, this.timeOf_(feature));
  }

  private removed_(feature: Feature): void {
    this.paints_.delete(feature);
    this.drawn_.remove(feature);
  }
}

/** The timeline window in minutes. */
function windowOf(window: TimeFilter['window']): [number, number] {
  const v = timeVariables(window);
  return [v.timeStart, v.timeEnd];
}

function distanceTo(geometry: Geometry, at: Coordinate): number {
  const closest = geometry.getClosestPoint(at);
  return Math.hypot(closest[0] - at[0], closest[1] - at[1]);
}

function areaOf(geometry: Geometry): number {
  const area = (geometry as Geometry & { getArea?: () => number }).getArea;
  return area ? area.call(geometry) : 0;
}
