/**
 * Vector layers with many features drawn on the GPU. A layer of more than
 * {@link glVector}`.threshold` features, drawn with one symbol or colored by
 * an attribute, gets a WebGL layer next to it that draws its points, lines
 * and polygons; the layer itself (a canvas layer) then draws only the labels,
 * so they keep their halo and are still left out where they overlap.
 *
 * The WebGL layer draws stand-ins of the features: each shares the geometry
 * of its feature (so edits move it too) and carries the colors it is drawn
 * in, worked out from the style. Features hidden by their category have no
 * stand-in. Layers drawn in the service's own style (Esri renderers) stay on
 * the canvas.
 *
 * Clicks are matched to features by their geometry ({@link GlVector.featureAt}),
 * with the same tolerance as the canvas layers.
 *
 * The timeline's filter ({@link TimeFilter}) is a filter of the WebGL style:
 * each stand-in carries the time span of its feature, and moving the window
 * only updates two style variables, so the buffers are not built again.
 */
import Feature from 'ol/Feature.js';
import type Map from 'ol/Map.js';
import { unByKey } from 'ol/Observable.js';
import type { EventsKey } from 'ol/events.js';
import type { Coordinate } from 'ol/coordinate.js';
import type Geometry from 'ol/geom/Geometry.js';
import type VectorLayer from 'ol/layer/Vector.js';
import WebGLVectorLayer from 'ol/layer/WebGLVector.js';
import VectorSource, { type VectorSourceEvent } from 'ol/source/Vector.js';
import type { FlatStyle, FlatStyleLike } from 'ol/style/flat.js';
import type { Pixel } from 'ol/pixel.js';
import { asArray } from 'ol/color.js';
import type RegularShape from 'ol/style/RegularShape.js';
import { isLine, styleFunction, type LineDash, type VectorStyleSpec } from './vector-style.js';
import type { TimeFilter } from './time.js';

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

/** The WebGL style: colors and widths come from each stand-in, the shape of points from `spec`. */
export function glStyle(spec: VectorStyleSpec): FlatStyle {
  const s = spec.symbol;
  const radius = Math.max(1, s.size / 2);
  const fill = ['get', 'fill'];
  const stroke = ['get', 'stroke'];
  const width = ['get', 'width'];
  const style: FlatStyle = { 'fill-color': fill, 'stroke-color': stroke, 'stroke-width': width, 'stroke-line-join': 'round' };
  const dash = dashes[s.dash];
  if (dash) style['stroke-line-dash'] = dash;
  if (s.dash === 'dot') style['stroke-line-cap'] = 'round';
  const shape = (points: number, r: number, angle = 0, r2?: number): FlatStyle => ({
    'shape-points': points,
    'shape-radius': r,
    ...(r2 !== undefined ? { 'shape-radius2': r2 } : {}),
    'shape-angle': angle,
    'shape-fill-color': fill,
    'shape-stroke-color': stroke,
    'shape-stroke-width': width,
  });
  switch (s.shape) {
    case 'square':
      return { ...style, ...shape(4, radius * Math.SQRT2, Math.PI / 4) };
    case 'triangle':
      return { ...style, ...shape(3, radius * 1.2) };
    case 'diamond':
      return { ...style, ...shape(4, radius * 1.2) };
    case 'star':
      return { ...style, ...shape(5, radius * 1.3, 0, radius * 0.55) };
    case 'cross':
    case 'x': {
      // Two lines: a white picture tinted with the point's color (WebGL shapes are filled).
      const arm = radius * 1.2;
      const line = Math.max(2, s.size / 5);
      const size = Math.ceil(2 * arm + line);
      const c = size / 2;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><path d="M${c - arm} ${c}H${c + arm}M${c} ${c - arm}V${c + arm}" stroke="white" stroke-width="${line}" fill="none"/></svg>`;
      return {
        ...style,
        'icon-src': `data:image/svg+xml,${encodeURIComponent(svg)}`,
        'icon-width': size,
        'icon-height': size,
        'icon-color': stroke,
        'icon-rotation': s.shape === 'x' ? Math.PI / 4 : 0,
      };
    }
    default:
      return { ...style, 'circle-radius': radius, 'circle-fill-color': fill, 'circle-stroke-color': stroke, 'circle-stroke-width': width };
  }
}

/** Properties of the canvas layer the WebGL layer follows. */
const followed = ['visible', 'opacity', 'extent', 'minResolution', 'maxResolution', 'minZoom', 'maxZoom'];

/**
 * The WebGL drawing of one vector layer. It is on the map while the layer
 * is, just under it (so the labels are on top), and follows its visibility
 * and opacity.
 */
export class GlVector {
  private readonly proxies_ = new globalThis.Map<Feature, Feature>();
  private readonly drawn_ = new VectorSource<Feature>();
  private gl_: WebGLVectorLayer<VectorSource<Feature>> | null = null;
  private paint_: (feature: Feature) => Paint | null;
  private style_: FlatStyle;
  private radius_: number;
  private readonly keys_: EventsKey[];
  private time_: TimeFilter | null;

  constructor(
    readonly layer: VectorLayer,
    spec: VectorStyleSpec,
    time: TimeFilter | null = null,
  ) {
    this.time_ = time;
    this.paint_ = painter(spec);
    this.style_ = glStyle(spec);
    this.radius_ = spec.symbol.size / 2;
    const source = this.source_();
    this.drawn_.addFeatures(this.proxiesOf_(source.getFeatures()));
    this.keys_ = [
      source.on('addfeature', (e: VectorSourceEvent<Feature>) => this.added_(e.feature!)),
      source.on('removefeature', (e: VectorSourceEvent<Feature>) => this.removed_(e.feature!)),
      source.on('changefeature', (e: VectorSourceEvent<Feature>) => this.changed_(e.feature!)),
      source.on('clear', () => {
        this.proxies_.clear();
        this.drawn_.clear(true);
      }),
      layer.on('propertychange', (e) => {
        // Added to or taken off the map.
        if (e.key === 'map') return this.attach_();
        if (!this.gl_) return;
        if (e.key === 'zIndex') this.gl_.setZIndex(this.zIndex_());
        else if (followed.includes(e.key)) this.gl_.set(e.key, layer.get(e.key));
      }),
    ];
    this.attach_();
  }

  /** Draws with `spec` from now on. */
  setSpec(spec: VectorStyleSpec): void {
    this.paint_ = painter(spec);
    this.style_ = glStyle(spec);
    this.radius_ = spec.symbol.size / 2;
    this.rebuild_();
  }

  /**
   * Draws only the features whose time span meets the window (null: all).
   * The same `span` function with another window only moves the window.
   */
  setTime(time: TimeFilter | null): void {
    const same = !!time && !!this.time_ && time.span === this.time_.span;
    this.time_ = time;
    if (same) this.gl_?.updateStyleVariables(timeVariables(time.window));
    else this.rebuild_();
  }

  /** A new style or new stand-ins: the buffers are built again from the stand-ins on the next frame. */
  private rebuild_(): void {
    this.gl_?.setStyle(this.styleLike_());
    if (this.time_) this.gl_?.updateStyleVariables(timeVariables(this.time_.window));
    const features = this.source_().getFeatures();
    this.proxies_.clear();
    this.drawn_.clear(true);
    this.drawn_.addFeatures(this.proxiesOf_(features));
  }

  /** The style, under the time filter when there is one. */
  private styleLike_(): FlatStyleLike {
    if (!this.time_) return this.style_;
    return [{ filter: ['all', ['<=', ['get', 't0'], ['var', 'timeEnd']], ['>=', ['get', 't1'], ['var', 'timeStart']]], style: this.style_ }];
  }

  /** The time attributes of a stand-in. */
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
      const proxy = this.proxies_.get(feature);
      const geometry = feature.getGeometry();
      if (!proxy || !geometry) continue;
      const kind = kindOf(geometry);
      const width = (proxy.get('width') as number) / 2;
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

  /** Takes the drawing off the map and lets go of the stand-ins. */
  dispose(): void {
    unByKey(this.keys_);
    this.detach_();
    this.proxies_.clear();
    this.drawn_.clear(true);
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
    if (!this.gl_) {
      this.gl_ = new WebGLVectorLayer({
        source: this.drawn_,
        style: this.styleLike_(),
        variables: timeVariables(this.time_?.window ?? [-Infinity, Infinity]),
        disableHitDetection: true,
        className: 'ol-layer gl-vector',
      });
      for (const key of followed) {
        const value = this.layer.get(key);
        if (value !== undefined) this.gl_.set(key, value);
      }
      this.gl_.setZIndex(this.zIndex_());
    }
    this.gl_.setMap(map);
  }

  private detach_(): void {
    if (!this.gl_) return;
    this.gl_.setMap(null);
    // A WebGL layer keeps its context until it is disposed.
    this.gl_.dispose();
    this.gl_ = null;
  }

  private proxiesOf_(features: Feature[]): Feature[] {
    const out: Feature[] = [];
    for (const feature of features) {
      const paint = this.paint_(feature);
      if (!paint) continue;
      const proxy = new Feature({ geometry: feature.getGeometry(), ...paint, ...this.timeOf_(feature) });
      this.proxies_.set(feature, proxy);
      out.push(proxy);
    }
    return out;
  }

  private added_(feature: Feature): void {
    if (!this.proxies_.has(feature)) this.drawn_.addFeatures(this.proxiesOf_([feature]));
  }

  private removed_(feature: Feature): void {
    const proxy = this.proxies_.get(feature);
    if (!proxy) return;
    this.proxies_.delete(feature);
    if (this.drawn_.hasFeature(proxy)) this.drawn_.removeFeature(proxy);
  }

  /** A feature reshaped, given another geometry or other values (its category may change). */
  private changed_(feature: Feature): void {
    const proxy = this.proxies_.get(feature);
    const paint = this.paint_(feature);
    if (!paint) return this.removed_(feature);
    if (!proxy) return this.added_(feature);
    const geometry = feature.getGeometry();
    const time = this.timeOf_(feature);
    const same = proxy.getGeometry() === geometry && samePaint(proxy, paint) && (!time || (proxy.get('t0') === time.t0 && proxy.get('t1') === time.t1));
    // A geometry changed in place has moved its stand-in already.
    if (same) return;
    proxy.setGeometry(geometry);
    for (const [key, value] of Object.entries({ ...paint, ...time })) proxy.set(key, value, true);
    proxy.changed();
  }
}

function samePaint(proxy: Feature, paint: Paint): boolean {
  const eq = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  return proxy.get('width') === paint.width && eq(proxy.get('fill') as number[], paint.fill) && eq(proxy.get('stroke') as number[], paint.stroke);
}

function distanceTo(geometry: Geometry, at: Coordinate): number {
  const closest = geometry.getClosestPoint(at);
  return Math.hypot(closest[0] - at[0], closest[1] - at[1]);
}

function areaOf(geometry: Geometry): number {
  const area = (geometry as Geometry & { getArea?: () => number }).getArea;
  return area ? area.call(geometry) : 0;
}
