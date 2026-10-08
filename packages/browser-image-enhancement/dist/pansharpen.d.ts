import { Raster } from "./raster.js";
//#region src/pansharpen.d.ts
/** How the panchromatic detail is put into the bands. */
export type PanSharpenMethod = 'gram-schmidt' | 'ihs' | 'brovey';
/** Options for {@link panSharpen}. */
export interface PanSharpenOptions {
  /** Default `gram-schmidt`. */
  method?: PanSharpenMethod;
  /**
   * Weight of each sharpened band in the intensity, in the order of `bands`;
   * `'auto'` (default) fits them to the panchromatic band, `'equal'` takes the plain mean.
   */
  weights?: 'auto' | 'equal' | readonly number[];
  /** Multispectral bands to sharpen (0-based). Default: every band but alpha. Other bands are copied. */
  bands?: readonly number[];
  /** Band of `pan` to use. Default 0. */
  panBand?: number;
  /** How much of the detail to add, 0 to 1 (or more). Default 1. */
  strength?: number;
  /**
   * Weights and gains fitted before (a result's `model`), used instead of
   * fitting them to this image; `weights` is then ignored. For sharpening
   * a large image piece by piece.
   */
  model?: PanSharpenModel;
}
/** What {@link panSharpen} fitted to the image: everything it needs to sharpen another piece of it the same way. */
export interface PanSharpenModel {
  /** Intensity weights of the sharpened bands. */
  weights: number[];
  /** Detail gains of the sharpened bands. */
  gains: number[];
  /** Gain of the panchromatic band matched to the intensity: `panGain · pan + panOffset`. */
  panGain: number;
  /** Offset of the panchromatic band matched to the intensity. */
  panOffset: number;
}
/** A pan-sharpened raster: the multispectral bands at the panchromatic resolution. */
export interface PanSharpenResult<T extends ArrayLike<number> = ArrayLike<number>> {
  /** `width * height * bands` values, of the multispectral raster's array type (Float64Array when it is not a typed array). */
  data: T;
  /** Width in pixels. */
  width: number;
  /** Height in pixels. */
  height: number;
  /** Values per pixel: every multispectral band, alpha included. */
  bands: number;
  /** The no-data value of the result: the multispectral one, else NaN for floats or 0 for integers. */
  noData: number | null;
  /** The intensity weights used, in the order of the sharpened bands (summing to 1). */
  weights: number[];
  /** Detail gains of the sharpened bands (1 for `ihs`, varying for `gram-schmidt`, 0 for `brovey`). */
  gains: number[];
  /** The fitted weights and gains, to sharpen other pieces of the same image with (see `options.model`). */
  model: PanSharpenModel;
}
/**
 * Pan-sharpens `ms` with `pan`. Both must have the same width and height:
 * resample the multispectral image onto the panchromatic grid first
 * (bilinear or bicubic). Pixels that are no data (or NaN) in either stay no data.
 *
 * @example
 * ```ts
 * const sharp = panSharpen(
 *   { data: pan, width, height, noData: 0 },
 *   { data: msOnPanGrid, width, height, bands: 4, noData: 0 },
 *   { method: 'gram-schmidt' },
 * );
 * ```
 */
export declare function panSharpen<T extends ArrayLike<number>>(pan: Raster, ms: Raster & {
  data: T;
}, options?: PanSharpenOptions): PanSharpenResult<T>;
//#endregion
//# sourceMappingURL=pansharpen.d.ts.map