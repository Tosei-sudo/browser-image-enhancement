/**
 * Color classes (discrete pseudo-color, as QGIS's "discrete" and "exact"
 * color ramps or its paletted renderer): pixel values are sorted into
 * classes and each class gets one flat color, instead of a smooth ramp.
 * Elevations in 100 m steps, an index cut at a few thresholds, or a land
 * cover map whose codes 1, 2, 3… each mean a class.
 *
 * Classes hold values of the image (raw values, not the 8-bit codes it is
 * shown with). {@link classPalette} turns them into a 256-entry RGBA table
 * for the codes `range` is shown over, the form `GpuRenderer.render` and
 * `GpuCorrectedTileLayer` take; {@link colorClasses} makes classes from a
 * value histogram: equal intervals, quantiles (classes of equal area), or
 * one class per value.
 */
import { colorScalePalette, type ColorScale } from './color-scale.js';
import type { RasterHistogram } from './raster.js';

/** One class: its bound or value, its color (`[r, g, b]` or `[r, g, b, a]`, 0-255), and a name for a legend. */
export interface ColorClass {
  /** `range`: the upper bound of the class (inclusive). `exact`: the value of the class. */
  value: number;
  /** The class's color, `[r, g, b]` or `[r, g, b, a]` in 0-255. */
  color: readonly number[];
  /** Its name in a legend ("100 – 200", "森林"). */
  label?: string;
}

/** Classes of values and their colors. */
export interface ColorClasses {
  /**
   * `range`: a value goes to the first class (by `value`) whose upper bound
   * it does not exceed, values above the last bound to the last class.
   * `exact`: a value goes to the class of that value; other values are
   * transparent.
   */
  kind: 'range' | 'exact';
  /** The classes, in any order. */
  classes: readonly ColorClass[];
  /** `range`: the lower bound of the first class (values below it still go to the first class). Default: shown from the first bound. */
  min?: number;
  /** How the classes were made, for an editor to offer the same again (`manual`: bounds set by hand). Not used to show them. */
  method?: ClassMethod | 'manual';
}

/** How {@link colorClasses} sorts values into classes. */
export type ClassMethod = 'equal' | 'quantile' | 'unique';

/** Options of {@link colorClasses}. */
export interface ColorClassesOptions {
  /** `equal` (default): classes of equal width between the smallest and the largest value. `quantile`: classes of about as many pixels each. `unique`: a class per value (see `maxValues`). */
  method?: ClassMethod;
  /** Number of classes (`equal`, `quantile`). Default 5. */
  count?: number;
  /** The scale the class colors are taken from, evenly from one end to the other. Default `turbo`. */
  scale?: ColorScale;
  /** Takes the colors from the other end of the scale. Default false. */
  reverse?: boolean;
  /** `unique`: at most this many values (more give null). Default 64. */
  maxValues?: number;
  /** The histogram's band the classes are made from. Default 0. */
  band?: number;
}

const sorted = (c: ColorClasses) => [...c.classes].sort((a, b) => a.value - b.value);

/**
 * The raw values that the 8-bit codes 0 and 255 should stand for to show
 * `classes` (an image stretched linearly from the first to the second):
 * integer values that span at most 255 one code each, else the classes'
 * whole range.
 */
export function classRange(classes: ColorClasses): [number, number] {
  const list = sorted(classes);
  if (list.length === 0) return [0, 255];
  const first = list[0].value;
  const last = list[list.length - 1].value;
  if (classes.kind === 'exact') {
    if (list.every((c) => Number.isInteger(c.value)) && last - first <= 255) return [first, first + 255];
    return last > first ? [first, last] : [first, first + 255];
  }
  const lo = Math.min(classes.min ?? first, first);
  return last > lo ? [lo, last] : [lo, lo + 1];
}

/**
 * The classes as a 256-entry RGBA table (1024 bytes) for an image shown
 * linearly from `range[0]` (code 0) to `range[1]` (code 255): entry `v` is
 * the color of the class of the value code `v` stands for.
 */
export function classPalette(classes: ColorClasses, range: readonly [number, number] = classRange(classes)): Uint8ClampedArray {
  const out = new Uint8ClampedArray(256 * 4);
  const list = sorted(classes);
  if (list.length === 0) return out;
  const [lo, hi] = range;
  const step = (hi - lo) / 255;
  const tolerance = Math.abs(step) * 1e-6;
  for (let v = 0; v < 256; v++) {
    const value = lo + step * v;
    let pick: ColorClass | null = null;
    if (classes.kind === 'range') {
      pick = list.find((c) => value <= c.value + tolerance) ?? list[list.length - 1];
    } else {
      let best = Infinity;
      for (const c of list) {
        const d = Math.abs(c.value - value);
        if (d < best) [best, pick] = [d, c];
      }
      if (best > Math.abs(step) / 2 + tolerance) pick = null;
    }
    if (!pick) continue;
    const [r = 0, g = 0, b = 0, a = 255] = pick.color;
    out.set([r, g, b, a], 4 * v);
  }
  return out;
}

/** The value of bin `k` of `hist`. */
const binValue = (hist: RasterHistogram, k: number, bins: number) => hist.range[0] + ((hist.range[1] - hist.range[0]) * k) / Math.max(1, bins - 1);

/** The smallest and largest value counted in `band` of `hist`; null when it counted nothing. */
export function histogramValueRange(hist: RasterHistogram, band = 0): [number, number] | null {
  const bins = hist.bins[band] ?? hist.bins[0];
  if (!bins) return null;
  let first = -1;
  let last = -1;
  for (let k = 0; k < bins.length; k++) {
    if (bins[k] <= 0) continue;
    if (first < 0) first = k;
    last = k;
  }
  return first < 0 ? null : [binValue(hist, first, bins.length), binValue(hist, last, bins.length)];
}

/** `count` upper bounds of classes of equal width from `min` to `max`. */
export function equalIntervalBreaks(min: number, max: number, count: number): number[] {
  const n = Math.max(1, Math.round(count));
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? max : min + ((max - min) * (i + 1)) / n));
}

/**
 * Upper bounds of classes of about as many pixels each (at most `count`;
 * fewer when many pixels share a value, as bounds that fall together are
 * merged).
 */
export function quantileBreaks(hist: RasterHistogram, count: number, band = 0): number[] {
  const bins = hist.bins[band] ?? hist.bins[0];
  const span = histogramValueRange(hist, band);
  if (!bins || !span) return [];
  const n = Math.max(1, Math.round(count));
  let total = 0;
  for (let k = 0; k < bins.length; k++) total += bins[k];
  const out: number[] = [];
  let cum = 0;
  let next = 1;
  for (let k = 0; k < bins.length && next < n; k++) {
    cum += bins[k];
    let crossed = false;
    while (next < n && cum >= (total * next) / n) {
      next++;
      crossed = true;
    }
    if (crossed) {
      const value = binValue(hist, k, bins.length);
      if (value < span[1] && out[out.length - 1] !== value) out.push(value);
    }
  }
  out.push(span[1]);
  return out;
}

/** A value of an image and the number of its pixels (see {@link uniqueValues}). */
export interface UniqueValue {
  /** The value. */
  value: number;
  /** Pixels with it. */
  count: number;
}

/**
 * The values counted in `band` of `hist` and how many pixels have each,
 * smallest first; null when there are more than `max`. Values of a
 * histogram of integers (bins no wider than 1 over an integer range) are
 * rounded to integers.
 */
export function uniqueValues(hist: RasterHistogram, max = 64, band = 0): UniqueValue[] | null {
  const bins = hist.bins[band] ?? hist.bins[0];
  if (!bins) return null;
  const [lo, hi] = hist.range;
  const width = (hi - lo) / Math.max(1, bins.length - 1);
  const integers = Number.isInteger(lo) && Number.isInteger(hi) && width <= 1;
  const out: UniqueValue[] = [];
  for (let k = 0; k < bins.length; k++) {
    if (bins[k] <= 0) continue;
    const raw = binValue(hist, k, bins.length);
    const value = integers ? Math.round(raw) : raw;
    const last = out[out.length - 1];
    if (last && last.value === value) last.count += bins[k];
    else {
      if (out.length >= max) return null;
      out.push({ value, count: bins[k] });
    }
  }
  return out;
}

/** `count` colors taken evenly along `scale`, from its dark end to its bright end (the other way with `reverse`). */
export function classColors(scale: ColorScale, count: number, reverse = false): number[][] {
  const palette = colorScalePalette(scale, { reverse });
  const n = Math.max(1, Math.round(count));
  return Array.from({ length: n }, (_, i) => {
    const v = n === 1 ? 128 : Math.round((255 * i) / (n - 1));
    return Array.from(palette.subarray(4 * v, 4 * v + 4));
  });
}

/** A value written with as many decimals as a class `width` needs (two digits finer than it, at most 6; trailing zeros dropped). */
export function formatClassValue(value: number, width: number): string {
  const decimals = width > 0 && Number.isFinite(width) ? Math.min(6, Math.max(0, Math.ceil(-Math.log10(width)) + 2)) : 0;
  const text = value.toFixed(Number.isInteger(value) && width >= 1 ? 0 : decimals);
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

/** Labels of range classes, "low – high" (the first from `min`). */
export function rangeLabels(min: number, bounds: readonly number[]): string[] {
  const width = bounds.length ? (bounds[bounds.length - 1] - min) / bounds.length : 1;
  return bounds.map((b, i) => `${formatClassValue(i === 0 ? min : bounds[i - 1], width)} – ${formatClassValue(b, width)}`);
}

/**
 * Classes for the values counted in `hist` (from `rasterHistogram`, or the
 * value histogram of an image), colored along a scale. Null when there is
 * nothing to class, or more distinct values than `maxValues` for `unique`.
 */
export function colorClasses(hist: RasterHistogram, options: ColorClassesOptions = {}): ColorClasses | null {
  const band = options.band ?? 0;
  const span = histogramValueRange(hist, band);
  if (!span) return null;
  const method = options.method ?? 'equal';
  const scale = options.scale ?? 'turbo';
  if (method === 'unique') {
    const values = uniqueValues(hist, options.maxValues ?? 64, band);
    if (!values?.length) return null;
    const colors = classColors(scale, values.length, options.reverse);
    const width = values.length > 1 ? (values[values.length - 1].value - values[0].value) / (values.length - 1) : 1;
    return { kind: 'exact', method, classes: values.map((v, i) => ({ value: v.value, color: colors[i], label: formatClassValue(v.value, width) })) };
  }
  const count = Math.max(1, Math.round(options.count ?? 5));
  const exact = method === 'quantile' ? quantileBreaks(hist, count, band) : equalIntervalBreaks(span[0], span[1], count);
  // Bounds as their labels write them (the last one stays the largest value, so that every value has a class).
  const width = (span[1] - span[0]) / Math.max(1, exact.length);
  const bounds = exact.map((b, i) => (i === exact.length - 1 ? b : Number(formatClassValue(b, width))));
  const colors = classColors(scale, bounds.length, options.reverse);
  const labels = rangeLabels(span[0], bounds);
  return { kind: 'range', method, min: span[0], classes: bounds.map((b, i) => ({ value: b, color: colors[i], label: labels[i] })) };
}

/** The share of the pixels counted in `hist` that each class gets (0-1, in the order of `classes.classes`). */
export function classShares(hist: RasterHistogram, classes: ColorClasses, band = 0): number[] {
  const bins = hist.bins[band] ?? hist.bins[0];
  const list = classes.classes;
  const counts = new Array<number>(list.length).fill(0);
  if (!bins || list.length === 0) return counts;
  const order = list.map((c, i) => [c.value, i] as const).sort((a, b) => a[0] - b[0]);
  const width = (hist.range[1] - hist.range[0]) / Math.max(1, bins.length - 1);
  let total = 0;
  for (let k = 0; k < bins.length; k++) {
    const n = bins[k];
    if (n <= 0) continue;
    total += n;
    const value = binValue(hist, k, bins.length);
    let pick = -1;
    if (classes.kind === 'range') pick = (order.find(([v]) => value <= v + width * 1e-6) ?? order[order.length - 1])[1];
    else {
      const near = order.reduce((best, o) => (Math.abs(o[0] - value) < Math.abs(best[0] - value) ? o : best));
      if (Math.abs(near[0] - value) <= Math.max(width, 0.5)) pick = near[1];
    }
    if (pick >= 0) counts[pick] += n;
  }
  return total > 0 ? counts.map((c) => c / total) : counts;
}
