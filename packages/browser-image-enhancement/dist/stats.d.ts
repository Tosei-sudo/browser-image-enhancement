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
/** Options for {@link sampleColor}. */
export interface SampleColorOptions {
  /** Pixels around the point that are averaged too (a square of side `2 * radius + 1`). Default 2. */
  radius?: number;
}
/**
 * The average color around pixel (`x`, `y`), as sRGB-encoded `[R, G, B]` in
 * 0-1, averaged in linear light and skipping transparent pixels. Pass it to
 * `whiteBalance` to make that spot neutral gray. Null when every pixel there
 * is transparent or the point is outside the image.
 *
 * @example
 * ```ts
 * canvas.onclick = (e) => {
 *   const [r, g, b] = sampleColor(image, e.offsetX, e.offsetY) ?? [0.5, 0.5, 0.5];
 *   p = p.set('whiteBalance', { r, g, b });
 * };
 * ```
 */
export declare function sampleColor(image: ImageDataLike, x: number, y: number, options?: SampleColorOptions): RGBValues | null;
//#endregion
export { mergeHistograms };
//# sourceMappingURL=stats.d.ts.map