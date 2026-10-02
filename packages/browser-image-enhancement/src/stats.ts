/**
 * Public statistics API: histograms of images or parts of them, and the
 * stretch range they give.
 */
import { assertImageData } from './core/image.js';
import { mergeHistograms, countPixels, stretchRange } from './core/histogram.js';
import { resolveMode } from './core/process.js';
import type { AutoStretchOptions, ColorOptions, Histogram, ImageDataLike, Rect, RGBValues } from './types.js';

export { mergeHistograms };

export interface HistogramOptions extends ColorOptions {
  /** Count only this rectangle (clipped to the image). Default: the whole image. */
  rect?: Rect;
}

/**
 * Histogram of 8-bit sRGB codes, skipping transparent pixels (alpha 0).
 * Monochrome images (or `colorMode: 'gray'`) give one luminance channel.
 */
export function histogram(image: ImageDataLike, options: HistogramOptions = {}): Histogram {
  assertImageData(image);
  return countPixels(image.data, image.width, resolveMode(image.data, options.colorMode), options.rect);
}

/**
 * The black and white points (sRGB-encoded, per channel) `autoStretch` would
 * use for an image with this histogram, as the first step of a pipeline.
 */
export function computeStretch(
  stats: Histogram,
  options?: AutoStretchOptions,
): {
  /** Per-channel input value that becomes black. */
  black: RGBValues;
  /** Per-channel input value that becomes white. */
  white: RGBValues;
} {
  return stretchRange(stats, options);
}
