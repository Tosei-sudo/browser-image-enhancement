import { ImageDataLike } from "./workers/src/image.js";
import { AutoStretchOptions, ColorOptions, Histogram, RGBValues, Rect } from "./types.js";
import { mergeHistograms } from "./core/histogram.js";
//#region src/stats.d.ts
export interface HistogramOptions extends ColorOptions {
  /** Count only this rectangle (clipped to the image). Default: the whole image. */
  rect?: Rect;
}
/**
 * Histogram of 8-bit sRGB codes, skipping transparent pixels (alpha 0).
 * Monochrome images (or `colorMode: 'gray'`) give one luminance channel.
 */
export declare function histogram(image: ImageDataLike, options?: HistogramOptions): Histogram;
/**
 * The black and white points (sRGB-encoded, per channel) `autoStretch` would
 * use for an image with this histogram, as the first step of a pipeline.
 */
export declare function computeStretch(stats: Histogram, options?: AutoStretchOptions): {
  /** Per-channel input value that becomes black. */
  black: RGBValues;
  /** Per-channel input value that becomes white. */
  white: RGBValues;
};
//#endregion
export { mergeHistograms };
//# sourceMappingURL=stats.d.ts.map