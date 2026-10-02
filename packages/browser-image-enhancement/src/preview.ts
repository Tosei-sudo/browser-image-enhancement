/** Shrinking images for fast previews. */
import { createImageData } from './core/image.js';
import { createCanvas, toCanvas } from './io.js';
import type { ImageDataLike } from './types.js';

/** The size an image of `width` x `height` is shown at when its longer side may be at most `maxSize`. */
export function previewSize(width: number, height: number, maxSize: number): { width: number; height: number; scale: number } {
  const scale = Math.min(1, maxSize / Math.max(width, height));
  if (!(scale < 1)) return { width, height, scale: 1 };
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

/**
 * Returns `image` shrunk (with the browser's high-quality smoothing) so its
 * longer side is at most `maxSize`, or `image` itself when it already fits.
 */
export function downscale(image: ImageDataLike, maxSize: number): { image: ImageDataLike; scale: number } {
  const size = previewSize(image.width, image.height, maxSize);
  if (size.scale === 1) return { image, scale: 1 };
  const canvas = createCanvas(size.width, size.height);
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true }) as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('Could not get a 2D canvas context.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(toCanvas(image), 0, 0, size.width, size.height);
  const d = ctx.getImageData(0, 0, size.width, size.height);
  // Width and height actually used, in case the browser rounded differently.
  return { image: createImageData(d.data, d.width, d.height), scale: d.width / image.width };
}
