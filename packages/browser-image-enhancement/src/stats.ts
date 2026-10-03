/**
 * Public statistics API: histograms of images or parts of them, and the
 * stretch range they give.
 */
import { assertImageData } from './core/image.js';
import { linearToSrgb, SRGB_TO_LINEAR } from './color/srgb.js';
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
export function sampleColor(image: ImageDataLike, x: number, y: number, options: SampleColorOptions = {}): RGBValues | null {
  assertImageData(image);
  const r = Math.max(0, Math.floor(options.radius ?? 2));
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  const sum = [0, 0, 0];
  let n = 0;
  for (let py = Math.max(0, cy - r); py <= Math.min(image.height - 1, cy + r); py++) {
    for (let px = Math.max(0, cx - r); px <= Math.min(image.width - 1, cx + r); px++) {
      const i = (py * image.width + px) * 4;
      if (image.data[i + 3] === 0) continue;
      for (let c = 0; c < 3; c++) sum[c] += SRGB_TO_LINEAR[image.data[i + c]];
      n++;
    }
  }
  if (n === 0) return null;
  return sum.map((v) => linearToSrgb(v / n)) as RGBValues;
}
