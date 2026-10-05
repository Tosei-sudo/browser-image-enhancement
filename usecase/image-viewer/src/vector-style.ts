/**
 * Symbols and labels of vector layers, like QGIS's layer styling: one symbol
 * for every feature, or a color per value of an attribute (分類), and labels
 * from an attribute. A style is kept in the browser (localStorage) under a
 * key for the layer (its service URL, or its file), so the layer looks the
 * same when it is opened again.
 */
import type { default as Feature, FeatureLike } from 'ol/Feature.js';
import type OlMap from 'ol/Map.js';
import type VectorLayer from 'ol/layer/Vector.js';
import type { Pixel } from 'ol/pixel.js';
import type Geometry from 'ol/geom/Geometry.js';
import type MultiPolygon from 'ol/geom/MultiPolygon.js';
import type Polygon from 'ol/geom/Polygon.js';
import { Circle, Fill, RegularShape, Stroke, Style, Text } from 'ol/style.js';
import type ImageStyle from 'ol/style/Image.js';
import type { StyleFunction, StyleLike } from 'ol/style/Style.js';
import { asArray } from 'ol/color.js';
import { drawsOnGpu, GlVector } from './gl-vector.js';

/** Shapes of point symbols. */
export type PointShape = 'circle' | 'square' | 'triangle' | 'diamond' | 'star' | 'cross' | 'x';
export const pointShapes: Record<PointShape, string> = {
  circle: '円',
  square: '四角',
  triangle: '三角',
  diamond: 'ひし形',
  star: '星',
  cross: '十字',
  x: 'バツ',
};

/** Line patterns. */
export type LineDash = 'solid' | 'dash' | 'dot' | 'dashdot';
export const lineDashes: Record<LineDash, string> = { solid: '実線', dash: '破線', dot: '点線', dashdot: '一点鎖線' };

/** One symbol: points, lines and polygons. */
export interface SymbolSpec {
  /** Fill of polygons and points (`#rrggbb`). */
  fill: string;
  /** 0–1. */
  fillOpacity: number;
  /** Lines, outlines of polygons and points (`#rrggbb`). */
  stroke: string;
  /** Pixels; 0 draws no line. */
  strokeWidth: number;
  /** 0–1. */
  strokeOpacity: number;
  dash: LineDash;
  shape: PointShape;
  /** Point symbol size (diameter), pixels. */
  size: number;
}

/** One value of the attribute a categorized style colors by. */
export interface Category {
  value: string;
  color: string;
  visible: boolean;
}

/** Labels from an attribute. */
export interface LabelSpec {
  /** Attribute shown; null: no labels. */
  field: string | null;
  /** Pixels. */
  size: number;
  color: string;
  bold: boolean;
  /** Outline around the letters (`#rrggbb`), and its width in pixels (0: none). */
  halo: string;
  haloWidth: number;
  /** Show every label, even where they overlap (else overlapping ones are left out). */
  overlap: boolean;
}

/** How a vector layer is drawn. */
export interface VectorStyleSpec {
  /**
   * `own`: as the service draws it (Esri renderers); `single`: one symbol;
   * `categorized`: a color for each value of `field`.
   */
  mode: 'own' | 'single' | 'categorized';
  /** The symbol (`single`), and everything but the color of the categories (`categorized`). */
  symbol: SymbolSpec;
  /** The attribute categorized by. */
  field: string | null;
  categories: Category[];
  /** Whether features whose value is not listed are drawn (in the symbol's colors). */
  othersVisible: boolean;
  label: LabelSpec;
}

/** A spec with one symbol in `color` (the color the viewer gives each new layer). */
export function singleSpec(color: string): VectorStyleSpec {
  return {
    mode: 'single',
    symbol: { fill: color, fillOpacity: 0.25, stroke: color, strokeWidth: 2, strokeOpacity: 1, dash: 'solid', shape: 'circle', size: 10 },
    field: null,
    categories: [],
    othersVisible: true,
    label: { field: null, size: 13, color: '#222222', bold: false, halo: '#ffffff', haloWidth: 3, overlap: false },
  };
}

/** A spec drawing the layer in its own style (the service's), with nothing changed yet. */
export function ownSpec(): VectorStyleSpec {
  return { ...singleSpec('#4363d8'), mode: 'own' };
}

/** `spec` read back from storage: anything missing or of the wrong kind comes from `base`. */
export function normalizeSpec(spec: unknown, base: VectorStyleSpec): VectorStyleSpec {
  const s = (spec && typeof spec === 'object' ? spec : {}) as Partial<VectorStyleSpec>;
  const pick = <T extends object>(value: unknown, fallback: T): T => {
    const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const out = { ...fallback } as Record<string, unknown>;
    for (const [k, d] of Object.entries(fallback)) if (typeof v[k] === typeof d || (d === null && typeof v[k] === 'string')) out[k] = v[k];
    return out as T;
  };
  const symbol = pick(s.symbol, base.symbol);
  if (!(symbol.shape in pointShapes)) symbol.shape = base.symbol.shape;
  if (!(symbol.dash in lineDashes)) symbol.dash = base.symbol.dash;
  const mode = s.mode === 'own' || s.mode === 'single' || s.mode === 'categorized' ? s.mode : base.mode;
  return {
    mode: mode === 'own' && base.mode !== 'own' ? 'single' : mode,
    symbol,
    field: typeof s.field === 'string' ? s.field : null,
    categories: Array.isArray(s.categories)
      ? s.categories.filter((c): c is Category => !!c && typeof c.value === 'string' && typeof c.color === 'string').map((c) => ({ value: c.value, color: c.color, visible: c.visible !== false }))
      : [],
    othersVisible: typeof s.othersVisible === 'boolean' ? s.othersVisible : true,
    label: pick(s.label, base.label),
  };
}

/** `#rrggbb` with an opacity, as an OpenLayers color. */
export function withOpacity(hex: string, opacity: number): number[] {
  const [r, g, b] = asArray(hex);
  return [r, g, b, Math.max(0, Math.min(1, opacity))];
}

const dashes: Record<LineDash, number[] | undefined> = { solid: undefined, dash: [10, 6], dot: [1, 5], dashdot: [10, 5, 1, 5] };

function strokeOf(color: string, s: SymbolSpec): Stroke | undefined {
  if (s.strokeWidth <= 0 || s.strokeOpacity <= 0) return undefined;
  return new Stroke({ color: withOpacity(color, s.strokeOpacity), width: s.strokeWidth, lineDash: dashes[s.dash], lineCap: s.dash === 'dot' ? 'round' : undefined });
}

/** The point symbol: never hidden by labels, which keep clear of it. */
export function markerOf(fillColor: string, strokeColor: string, s: SymbolSpec): ImageStyle {
  const fill = new Fill({ color: withOpacity(fillColor, 1) });
  // An outline of points thinner than the lines, so small markers keep their color.
  const stroke = s.strokeWidth > 0 && s.strokeOpacity > 0 ? new Stroke({ color: withOpacity(strokeColor, s.strokeOpacity), width: Math.min(s.strokeWidth, Math.max(1, s.size / 5)) }) : undefined;
  const radius = Math.max(1, s.size / 2);
  // Drawn always, and labels keep clear of them.
  const declutterMode = 'obstacle' as const;
  switch (s.shape) {
    case 'square':
      return new RegularShape({ points: 4, radius: radius * Math.SQRT2, angle: Math.PI / 4, fill, stroke, declutterMode });
    case 'triangle':
      return new RegularShape({ points: 3, radius: radius * 1.2, fill, stroke, declutterMode });
    case 'diamond':
      return new RegularShape({ points: 4, radius: radius * 1.2, fill, stroke, declutterMode });
    case 'star':
      return new RegularShape({ points: 5, radius: radius * 1.3, radius2: radius * 0.55, fill, stroke, declutterMode });
    case 'cross':
    case 'x':
      // Lines only: drawn in the fill color, which is the point's color.
      return new RegularShape({
        points: 4,
        radius: radius * 1.2,
        radius2: 0,
        angle: s.shape === 'x' ? Math.PI / 4 : 0,
        stroke: new Stroke({ color: withOpacity(fillColor, 1), width: Math.max(2, s.size / 5) }),
        declutterMode,
      });
    default:
      return new Circle({ radius, fill, stroke, declutterMode });
  }
}

/**
 * The styles of one color: for points and polygons (filled in `color`, the
 * symbol's outline) and for lines (in `color`). With the symbol's own colors
 * when `color` is null.
 */
function symbolStyles(s: SymbolSpec, color: string | null): { area: Style; line: Style } {
  const fill = color ?? s.fill;
  const area = new Style({
    fill: s.fillOpacity > 0 ? new Fill({ color: withOpacity(fill, s.fillOpacity) }) : undefined,
    stroke: strokeOf(s.stroke, s),
    image: markerOf(fill, s.stroke, s),
  });
  // A line of a categorized layer takes its category's color; a line of one symbol the symbol's line color.
  const line = new Style({ stroke: strokeOf(color ?? s.stroke, { ...s, strokeWidth: Math.max(s.strokeWidth, color ? 1 : 0) }) });
  return { area, line };
}

/** Whether a geometry of `type` is drawn as a line. */
export const isLine = (type: string | undefined) => type === 'LineString' || type === 'MultiLineString' || type === 'LinearRing';

/** The text of a feature's label: its value, or null when it has none. */
export function labelText(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

/** The value a feature is categorized by, as listed. */
export function categoryValue(value: unknown): string {
  return value === null || value === undefined ? '' : value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

/** Where a polygon's label goes: inside it (the largest part of a multipolygon). */
function labelPoint(feature: FeatureLike): Geometry | undefined {
  const g = feature.getGeometry() as Geometry | undefined;
  const type = g?.getType();
  if (type === 'Polygon') return (g as Polygon).getInteriorPoint();
  if (type === 'MultiPolygon') {
    const parts = (g as MultiPolygon).getPolygons();
    let best = parts[0];
    for (const p of parts) if (p.getArea() > best.getArea()) best = p;
    return best?.getInteriorPoint();
  }
  return g;
}

/** The labels' styles, one per text (and kind of geometry), made as they are needed. */
function labelStyles(label: LabelSpec): (feature: FeatureLike) => Style | null {
  const cache = new Map<string, Style>();
  const font = `${label.bold ? 'bold ' : ''}${label.size}px system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif`;
  const fill = new Fill({ color: label.color });
  const halo = label.haloWidth > 0 ? new Stroke({ color: label.halo, width: label.haloWidth }) : undefined;
  return (feature) => {
    const text = labelText(feature.get(label.field!));
    if (text === null) return null;
    const type = feature.getGeometry()?.getType();
    const kind = isLine(type) ? 'line' : type === 'Polygon' || type === 'MultiPolygon' ? 'area' : 'point';
    const key = `${kind}\n${text}`;
    let style = cache.get(key);
    if (!style) {
      if (cache.size > 20_000) cache.clear();
      style = new Style({
        geometry: kind === 'area' ? labelPoint : undefined,
        text: new Text({
          text,
          font,
          fill,
          stroke: halo,
          placement: kind === 'line' ? 'line' : 'point',
          // Beside a point symbol, centered on lines and in polygons.
          offsetY: kind === 'point' ? -(label.size * 0.6 + 8) : 0,
          overflow: kind === 'area',
          declutterMode: label.overlap ? 'none' : 'declutter',
        }),
        zIndex: 1,
      });
      cache.set(key, style);
    }
    return style;
  };
}

/**
 * The style function of a spec; `own` is the layer's own style, for the `own`
 * mode. Without `symbols`, only the labels (of the features drawn).
 */
export function styleFunction(spec: VectorStyleSpec, own?: StyleLike, symbols = true): StyleFunction {
  const labels = spec.label.field ? labelStyles(spec.label) : null;
  let draw: (feature: FeatureLike, resolution: number) => Style | Style[] | void;
  if (spec.mode === 'own' && own) {
    const ownFn = typeof own === 'function' ? own : () => own;
    draw = (feature, resolution) => ownFn(feature, resolution) as Style | Style[] | void;
  } else if (spec.mode === 'categorized' && spec.field) {
    const field = spec.field;
    const styles = new Map(spec.categories.filter((c) => c.visible).map((c) => [c.value, symbolStyles(spec.symbol, c.color)]));
    const listed = new Set(spec.categories.map((c) => c.value));
    const others = spec.othersVisible ? symbolStyles(spec.symbol, null) : null;
    draw = (feature) => {
      const value = categoryValue(feature.get(field));
      const s = styles.get(value) ?? (listed.has(value) ? null : others);
      if (!s) return undefined;
      return isLine(feature.getGeometry()?.getType()) ? s.line : s.area;
    };
  } else {
    const s = symbolStyles(spec.symbol, null);
    draw = (feature) => (isLine(feature.getGeometry()?.getType()) ? s.line : s.area);
  }
  if (!labels) return draw;
  return (feature, resolution) => {
    const drawn = draw(feature, resolution);
    // A feature hidden by its category gets no label either.
    if (!drawn || (Array.isArray(drawn) && drawn.length === 0)) return undefined;
    const label = labels(feature);
    if (!symbols) return label ?? undefined;
    if (!label) return drawn;
    return [...(Array.isArray(drawn) ? drawn : [drawn]), label];
  };
}

/** Colors for categories: distinct ones first, then spread around the color wheel. */
const categoryPalette = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#469990', '#9a6324', '#800000', '#808000', '#000075', '#fabed4', '#dcbeff', '#ffd8b1'];
export function categoryColor(index: number): string {
  if (index < categoryPalette.length) return categoryPalette[index];
  const hue = (index * 137.508) % 360;
  return hslHex(hue, 0.65, 0.5);
}

function hslHex(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** The most categories listed; rarer values are drawn as 「その他」. */
export const MAX_CATEGORIES = 200;

/** The values of `field` among `features`, most frequent first (then in order), with how many have each. */
export function valuesOf(features: FeatureLike[], field: string): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const f of features) {
    const v = categoryValue(f.get(field));
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const collator = new Intl.Collator('ja', { numeric: true });
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || collator.compare(a.value, b.value));
}

/** Categories for the values of `field`: the ones already chosen keep their color and visibility. */
export function categoriesFor(features: FeatureLike[], field: string, earlier: Category[] = []): Category[] {
  const kept = new Map(earlier.map((c) => [c.value, c]));
  const values = valuesOf(features, field).slice(0, MAX_CATEGORIES);
  const collator = new Intl.Collator('ja', { numeric: true });
  values.sort((a, b) => collator.compare(a.value, b.value));
  return values.map(({ value }, i) => kept.get(value) ?? { value, color: categoryColor(i), visible: true });
}

/** Where styles are kept: one entry per layer key. */
export interface StyleStore {
  get(key: string): unknown;
  set(key: string, spec: VectorStyleSpec): void;
  delete(key: string): void;
}

const STORAGE_KEY = 'image-viewer.vector-styles';

/** The styles kept in localStorage (nothing is kept where it cannot be used: a private window, a sandbox). */
export function browserStyleStore(): StyleStore {
  const read = (): Record<string, unknown> => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const write = (all: Record<string, unknown>) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch {
      // Not kept: the style still applies until the page is closed.
    }
  };
  return {
    get: (key) => read()[key],
    set: (key, spec) => write({ ...read(), [key]: spec }),
    delete: (key) => {
      const all = read();
      delete all[key];
      write(all);
    },
  };
}

/** A store in memory (tests). */
export function memoryStyleStore(): StyleStore {
  const all = new Map<string, unknown>();
  return { get: (key) => structuredClone(all.get(key)), set: (key, spec) => void all.set(key, structuredClone(spec)), delete: (key) => void all.delete(key) };
}

let defaultStore: StyleStore | null = null;
const storeOf = () => (defaultStore ??= browserStyleStore());

/**
 * The style of one vector layer: what it is now, what it was made with (to
 * go back to), and the layer's own style for the `own` mode.
 */
export class LayerStyle {
  private spec_: VectorStyleSpec;
  private key_: string | null = null;
  private gl_: GlVector | null = null;

  /**
   * @param layer The layer drawn.
   * @param initial The style it is made with: one symbol in the layer's color, or `own`.
   * @param own The layer's own style (an Esri renderer), for `own`.
   */
  constructor(
    readonly layer: VectorLayer,
    readonly initial: VectorStyleSpec,
    readonly own?: StyleLike,
    private readonly store: StyleStore = storeOf(),
  ) {
    this.spec_ = structuredClone(initial);
    this.apply_();
  }

  /** Whether the layer has a style of its own to go back to. */
  hasOwn(): boolean {
    return this.own !== undefined;
  }

  /** The style now (a copy). */
  get(): VectorStyleSpec {
    return structuredClone(this.spec_);
  }

  /** Draws the layer with `spec`; kept for the next visit unless `keep` is false (a preview). */
  set(spec: VectorStyleSpec, keep = true): void {
    this.spec_ = structuredClone(spec);
    this.apply_();
    if (keep && this.key_) this.store.set(this.key_, this.spec_);
  }

  /** Back to the style the layer was made with, and forgets the kept one. */
  reset(): void {
    this.spec_ = structuredClone(this.initial);
    this.apply_();
    if (this.key_) this.store.delete(this.key_);
  }

  /** Names the layer for storage, and draws it with the style kept for it, when there is one. */
  restore(key: string): void {
    this.key_ = key;
    const kept = this.store.get(key);
    if (kept) {
      this.spec_ = normalizeSpec(kept, this.initial);
      this.apply_();
    }
  }

  /** Forgets the kept style (a temporary layer that is closed). */
  forget(): void {
    if (this.key_) this.store.delete(this.key_);
  }

  /** Whether the symbols are drawn on the GPU (a layer of many features); clicks then go to {@link featureAt}. */
  onGpu(): boolean {
    return this.gl_ !== null;
  }

  /** The feature drawn at `pixel`, when the symbols are drawn on the GPU. */
  featureAt(map: OlMap, pixel: Pixel, tolerance?: number): Feature | undefined {
    return this.gl_?.featureAt(map, pixel, tolerance);
  }

  private apply_(): void {
    const spec = this.spec_;
    const count = this.layer.getSource()?.getFeatures().length ?? 0;
    if (drawsOnGpu(spec, count)) {
      if (this.gl_) this.gl_.setSpec(spec);
      else this.gl_ = new GlVector(this.layer, spec);
      // The canvas layer draws only the labels.
      this.layer.setStyle(spec.label.field ? styleFunction(spec, this.own, false) : null);
    } else {
      this.gl_?.dispose();
      this.gl_ = null;
      this.layer.setStyle(styleFunction(spec, this.own));
    }
    // Labels that would overlap are left out; point symbols are always drawn (their declutterMode is `obstacle`).
    this.layer.setDeclutter(!!spec.label.field && !spec.label.overlap);
  }
}
