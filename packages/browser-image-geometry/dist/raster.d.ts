import { Transform } from "./types.js";
import { OutputOptions, WarpInfo } from "./plan.js";
//#region src/raster.d.ts
/** Pixel values {@link warpRaster} can warp. */
export type RasterSamples = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;
/** A raster: any number of bands of one sample type, pixel-interleaved. */
export interface Raster<T extends RasterSamples = RasterSamples> {
  /** Width in pixels. */
  width: number;
  /** Height in pixels. */
  height: number;
  /** Samples per pixel. */
  bands: number;
  /** `bands` values for each pixel, row by row. */
  data: T;
  /** Value of pixels with no data. Default: none (NaN still counts as no data). */
  noData?: number | null;
}
/** Options for {@link warpRaster}: those of the RGBA warp except `background`. */
export type RasterWarpOptions = Omit<OutputOptions, 'background'>;
/** A warped raster and where it sits in output coordinates. */
export interface RasterWarpResult<T extends RasterSamples = RasterSamples> extends WarpInfo {
  /** The output raster, same sample type and band count as the input. */
  readonly raster: Raster<T>;
}
/**
 * Applies `transform` to a raster on the calling thread, keeping its sample
 * type. Output pixels outside the source get the no-data value (0 when the
 * raster has none and the samples are integers, NaN for floats).
 *
 * @example
 * ```ts
 * const { raster, geoTransform } = warpRaster(
 *   { width, height, bands: 4, data: uint16, noData: 0 },
 *   fit.transform,
 *   { resample: 'bilinear', coordinateTransform: proj4('EPSG:4326', 'EPSG:3857') },
 * );
 * ```
 */
export declare function warpRaster<T extends RasterSamples>(raster: Raster<T>, transform: Transform, options?: RasterWarpOptions): RasterWarpResult<T>;
/** Halves a raster (2×2 average per band, leaving out no-data), for shrinking by more than 2× without aliasing. */
export declare function halveRaster<T extends RasterSamples>(src: Raster<T>): Raster<T>;
//#endregion
//# sourceMappingURL=raster.d.ts.map