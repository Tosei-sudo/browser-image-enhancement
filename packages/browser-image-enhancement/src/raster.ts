/**
 * Rasters with values beyond 8 bits (16-bit integers, floats: GeoTIFF
 * bands, scientific data). Corrections work on 8-bit images, so a raster is
 * first stretched from its own value range to 0-255; the statistics for that
 * stretch are taken on the raw values, so nothing is lost to an early 8-bit
 * rounding. The 8-bit image then goes through a pipeline like any other.
 */
import { createImageData } from './core/image.js';
import { rangeOf, type Distribution } from './core/histogram.js';
import { normalizeAutoStretch } from './ops/index.js';
import type { AutoStretchOptions, Rect } from './types.js';

/**
 * Raster pixels, band-interleaved: `bands` values per pixel, row by row from
 * the top left (the layout of a GeoTIFF read with `interleave: true` and of
 * OpenLayers data tiles).
 */
export interface Raster {
  /** `width * height * bands` values, of any numeric type. */
  data: ArrayLike<number>;
  /** Width in pixels. */
  width: number;
  /** Height in pixels. */
  height: number;
  /** Values per pixel, alpha included. Default 1. */
  bands?: number;
  /**
   * Which bands make the picture: one index for a gray image, three for
   * R, G, B (0-based). Default: band 0 when there is one color band, else
   * bands 0, 1, 2.
   */
  select?: readonly [number] | readonly [number, number, number];
  /** True when the last band is alpha: 0 is transparent, any other value opaque. Default false. */
  alpha?: boolean;
  /** Value that marks pixels with no data; they become transparent. NaN always does. */
  noData?: number | null;
}

/**
 * Value counts of a raster's picture bands over a fixed value range, so the
 * histograms of tiles taken with the same `range` and bin count can be added
 * with {@link mergeRasterHistograms}.
 */
export interface RasterHistogram {
  /** The value range the bins cover: bin 0 is `min`, the last bin is `max`. */
  range: readonly [number, number];
  /** Counts per picture band (1 or 3), each with the same number of bins. */
  bins: Float64Array[];
  /** Pixels counted (transparent and no-data pixels are not). */
  count: number;
}

/** Options for {@link rasterHistogram}. */
export interface RasterHistogramOptions {
  /** Value range to count over. Default: the raster's own range ({@link rasterRange}). Give one range to tiles that will be merged. */
  range?: readonly [number, number];
  /** Number of bins. Default 4096. */
  bins?: number;
  /** Count only this rectangle (clipped to the raster). */
  rect?: Rect;
}

/** A fixed raw-value stretch: the value that becomes black and the one that becomes white, one number or one per picture band. */
export interface RasterStretch {
  /** Raw value that becomes 0. */
  black: number | readonly number[];
  /** Raw value that becomes 255. */
  white: number | readonly number[];
}

/** A computed raw-value stretch: one black and one white value per picture band. */
export interface RasterStretchRange {
  /** Raw values that become 0, one per picture band. */
  black: number[];
  /** Raw values that become 255, one per picture band. */
  white: number[];
}

/** Options for {@link rasterToImageData}. */
export interface RasterToImageDataOptions {
  /**
   * How raw values become 0-255: a fixed {@link RasterStretch}, or the
   * options of an automatic stretch computed from the raster itself
   * (default: `percentClip`, 0.5 % at each end). For tiles of one picture,
   * compute one stretch from merged histograms and pass it to every tile.
   */
  stretch?: RasterStretch | AutoStretchOptions;
}

interface Layout {
  bands: number;
  picture: number[];
  alpha: number;
  noData: number | null;
}

function layout(r: Raster): Layout {
  const bands = r.bands ?? 1;
  if (!Number.isInteger(bands) || bands < 1) throw new RangeError(`bands must be a positive integer, got ${String(r.bands)}.`);
  if (r.data.length < r.width * r.height * bands) {
    throw new RangeError(`A ${r.width}x${r.height} raster with ${bands} bands needs ${r.width * r.height * bands} values, got ${r.data.length}.`);
  }
  const alpha = r.alpha ? bands - 1 : -1;
  const color = r.alpha ? bands - 1 : bands;
  const picture = r.select ? [...r.select] : color >= 3 ? [0, 1, 2] : [0];
  if ((picture.length !== 1 && picture.length !== 3) || picture.some((b) => !Number.isInteger(b) || b < 0 || b >= bands || b === alpha)) {
    throw new RangeError(`select must name 1 or 3 value bands of ${bands}, got ${JSON.stringify(r.select)}.`);
  }
  return { bands, picture, alpha, noData: r.noData ?? null };
}

/** Whether pixel `p` (index of its first value) is transparent or has no data (or a non-finite value) in a picture band. */
function hidden(data: ArrayLike<number>, p: number, l: Layout): boolean {
  if (l.alpha >= 0 && data[p + l.alpha] === 0) return true;
  for (const b of l.picture) {
    const v = data[p + b];
    // NaN and ±Infinity count as no data: one infinite value would otherwise make the whole range infinite.
    if (v - v !== 0 || v === l.noData) return true;
  }
  return false;
}

function clip(rect: Rect | undefined, width: number, height: number): [number, number, number, number] {
  if (!rect) return [0, 0, width, height];
  return [
    Math.max(0, Math.floor(rect.x)),
    Math.max(0, Math.floor(rect.y)),
    Math.min(width, Math.ceil(rect.x + rect.width)),
    Math.min(height, Math.ceil(rect.y + rect.height)),
  ];
}

/**
 * Smallest and largest value of the picture bands, skipping transparent,
 * no-data and NaN pixels; null when there is none.
 */
export function rasterRange(raster: Raster, rect?: Rect): [number, number] | null {
  const l = layout(raster);
  const [x0, y0, x1, y1] = clip(rect, raster.width, raster.height);
  let min = Infinity;
  let max = -Infinity;
  const d = raster.data;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * raster.width + x) * l.bands;
      if (hidden(d, p, l)) continue;
      for (const b of l.picture) {
        const v = d[p + b];
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  return min <= max ? [min, max] : null;
}

/** Value counts of the picture bands over `range` (default: the raster's own range). */
export function rasterHistogram(raster: Raster, options: RasterHistogramOptions = {}): RasterHistogram {
  const l = layout(raster);
  const n = Math.max(2, Math.floor(options.bins ?? 4096));
  const range = options.range ?? rasterRange(raster, options.rect) ?? [0, 1];
  const [min, max] = range;
  const bins = l.picture.map(() => new Float64Array(n));
  const scale = max > min ? (n - 1) / (max - min) : 0;
  const [x0, y0, x1, y1] = clip(options.rect, raster.width, raster.height);
  const d = raster.data;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * raster.width + x) * l.bands;
      if (hidden(d, p, l)) continue;
      for (let c = 0; c < l.picture.length; c++) {
        const k = Math.round((d[p + l.picture[c]] - min) * scale);
        bins[c][k < 0 ? 0 : k >= n ? n - 1 : k]++;
      }
      count++;
    }
  }
  return { range: [min, max], bins, count };
}

/** Adds raster histograms taken with the same range and bin count (of tiles of one picture). */
export function mergeRasterHistograms(histograms: readonly RasterHistogram[]): RasterHistogram {
  if (histograms.length === 0) throw new RangeError('Nothing to merge.');
  const [first] = histograms;
  const out: RasterHistogram = { range: first.range, bins: first.bins.map((b) => new Float64Array(b.length)), count: 0 };
  for (const h of histograms) {
    if (h.range[0] !== first.range[0] || h.range[1] !== first.range[1] || h.bins.length !== first.bins.length || h.bins[0].length !== first.bins[0].length) {
      throw new RangeError('Raster histograms can only be merged when they have the same range, bands and bin count.');
    }
    h.bins.forEach((b, c) => {
      const o = out.bins[c];
      for (let k = 0; k < b.length; k++) o[k] += b[k];
    });
    out.count += h.count;
  }
  return out;
}

/**
 * The raw values that become black and white for an automatic stretch of a
 * raster with this histogram (one pair per picture band; the same pair for
 * all with `linked: true`).
 */
export function computeRasterStretch(stats: RasterHistogram, options: AutoStretchOptions = {}): RasterStretchRange {
  const o = normalizeAutoStretch(options);
  const [min, max] = stats.range;
  const toDistribution = (bins: readonly Float64Array[]): Distribution => {
    const d: Distribution = [];
    for (const b of bins) {
      const step = (max - min) / (b.length - 1);
      for (let k = 0; k < b.length; k++) if (b[k] > 0) d.push({ value: k === b.length - 1 ? max : min + k * step, count: b[k] });
    }
    return d.sort((a, b) => a.value - b.value);
  };
  const fallback: [number, number] = max > min ? [min, max] : [min, min + 1];
  if (o.linked || stats.bins.length === 1) {
    const r = rangeOf(toDistribution(stats.bins), o) ?? fallback;
    return { black: stats.bins.map(() => r[0]), white: stats.bins.map(() => r[1]) };
  }
  const ranges = stats.bins.map((b) => rangeOf(toDistribution([b]), o) ?? fallback);
  return { black: ranges.map((r) => r[0]), white: ranges.map((r) => r[1]) };
}

function isFixed(s: RasterStretch | AutoStretchOptions | undefined): s is RasterStretch {
  return !!s && 'black' in s && 'white' in s;
}

function perBand(v: number | readonly number[], n: number, name: string): number[] {
  const out = typeof v === 'number' ? new Array<number>(n).fill(v) : [...v];
  if (out.length !== n || out.some((x) => !Number.isFinite(x))) throw new RangeError(`${name} must be a number or ${n} numbers.`);
  return out;
}

/**
 * Stretches a raster to an 8-bit sRGB image (`ImageData`) that pipelines can
 * correct: raw values from black to white map linearly onto 0-255, values
 * outside are clipped, and transparent, no-data and NaN pixels become
 * transparent. One picture band gives a gray image, three give color.
 *
 * @example
 * ```ts
 * // A 16-bit, 4-band GeoTIFF: show bands 3, 2, 1 (red, green, blue), stretched on the raw values.
 * const data = await tiff.getImage().then((i) => i.readRasters({ interleave: true }));
 * const img = rasterToImageData({ data, width, height, bands: 4, select: [2, 1, 0], noData: 0 });
 * const out = await pipeline().contrast(0.1).sharpen().run(img);
 * ```
 */
export function rasterToImageData(raster: Raster, options: RasterToImageDataOptions = {}): ImageData {
  const l = layout(raster);
  const n = l.picture.length;
  const stretch = isFixed(options.stretch)
    ? { black: perBand(options.stretch.black, n, 'stretch.black'), white: perBand(options.stretch.white, n, 'stretch.white') }
    : computeRasterStretch(rasterHistogram(raster), options.stretch);
  const scale = stretch.black.map((b, c) => (stretch.white[c] > b ? 255 / (stretch.white[c] - b) : 0));
  const pixels = raster.width * raster.height;
  const out = new Uint8ClampedArray(pixels * 4);
  const d = raster.data;
  for (let i = 0, p = 0, o = 0; i < pixels; i++, p += l.bands, o += 4) {
    if (hidden(d, p, l)) continue; // stays transparent black
    for (let c = 0; c < 3; c++) {
      const b = n === 1 ? 0 : c;
      // Uint8ClampedArray rounds half to even and clips to 0..255.
      out[o + c] = (d[p + l.picture[b]] - stretch.black[b]) * scale[b];
    }
    out[o + 3] = 255;
  }
  return createImageData(out, raster.width, raster.height);
}
