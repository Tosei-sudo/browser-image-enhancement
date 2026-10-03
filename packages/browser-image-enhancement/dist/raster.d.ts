import { AutoStretchOptions, Rect } from "./types.js";
//#region src/raster.d.ts
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
/**
 * Smallest and largest value of the picture bands, skipping transparent,
 * no-data and NaN pixels; null when there is none.
 */
export declare function rasterRange(raster: Raster, rect?: Rect): [number, number] | null;
/** Value counts of the picture bands over `range` (default: the raster's own range). */
export declare function rasterHistogram(raster: Raster, options?: RasterHistogramOptions): RasterHistogram;
/** Adds raster histograms taken with the same range and bin count (of tiles of one picture). */
export declare function mergeRasterHistograms(histograms: readonly RasterHistogram[]): RasterHistogram;
/**
 * The raw values that become black and white for an automatic stretch of a
 * raster with this histogram (one pair per picture band; the same pair for
 * all with `linked: true`).
 */
export declare function computeRasterStretch(stats: RasterHistogram, options?: AutoStretchOptions): RasterStretchRange;
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
export declare function rasterToImageData(raster: Raster, options?: RasterToImageDataOptions): ImageData;
//#endregion
//# sourceMappingURL=raster.d.ts.map