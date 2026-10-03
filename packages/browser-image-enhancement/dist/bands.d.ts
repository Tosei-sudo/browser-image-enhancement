import { ImageDataLike } from "./workers/src/image.js";
import { Raster } from "./raster.js";
//#region src/bands.d.ts
/**
 * The band (0-based) each of R, G and B shows. One index, or three equal
 * ones, shows that band in gray.
 */
export type BandSelection = readonly [number] | readonly [number, number, number];
/** A band-interleaved raster whose `data` keeps the array type of the input. */
export interface SelectedBands<T extends ArrayLike<number>> extends Raster {
  data: T;
  bands: number;
}
/**
 * Takes the bands `select` names out of a band-interleaved raster, in that
 * order: `[3, 2, 1]` of a 4-band image gives a 3-band raster of bands 3, 2
 * and 1. The alpha band (`alpha: true`) is kept as the last band. Values are
 * copied as they are, into an array of the input's type, so 16-bit and float
 * data keep their precision; `rasterToImageData` then stretches them for
 * display (it also takes `select`, so the two steps can be one).
 *
 * @example
 * ```ts
 * // Sentinel-2 bands B2, B3, B4, B8 (blue, green, red, near-infrared): a false-color composite.
 * const falseColor = selectBands({ data, width, height, bands: 4 }, [3, 2, 1]);
 * ```
 */
export declare function selectBands<T extends ArrayLike<number>>(raster: Raster & {
  data: T;
}, select: readonly number[]): SelectedBands<T>;
/**
 * Gives R, G and B the channels `bands` names (0 = R, 1 = G, 2 = B, 3 = A) of
 * an 8-bit RGBA image: `[2, 1, 0]` swaps red and blue, `[1, 1, 1]` shows the
 * green channel in gray. Alpha is kept. For rasters with more bands, use
 * {@link selectBands} or the `select` of `rasterToImageData`.
 */
export declare function assignBands(image: ImageDataLike, bands: BandSelection): ImageData;
/** Whether a selection shows one band in gray (one index, or three equal ones). */
export declare function isGraySelection(select: BandSelection): boolean;
//#endregion
//# sourceMappingURL=bands.d.ts.map