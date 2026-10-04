/**
 * Synchronous API: takes sRGB `ImageData`, returns new `ImageData`, runs on the
 * calling thread. Use `warp()` to run in workers.
 */
import { assertImageData, createImageData, type ImageDataLike } from '@browser-image/workers';
import { planWarp, type OutputOptions, type WarpInfo } from './plan.js';
import { renderPlan } from './render.js';
import { rotation, scaling } from './transform.js';
import type { RGBA, Resample, Transform } from './types.js';

const HINT = 'Use warp(), which converts other color spaces to sRGB.';

/** A warped image and where it sits in output coordinates. */
export interface WarpResult<I = ImageData> extends WarpInfo {
  /** The output image. */
  readonly image: I;
  /** Output width in pixels. */
  readonly width: number;
  /** Output height in pixels. */
  readonly height: number;
}

/** Applies `transform` to `image` on the calling thread. */
export function warpImageData(image: ImageDataLike, transform: Transform, options: OutputOptions = {}): WarpResult {
  assertImageData(image, HINT);
  const plan = planWarp(image.width, image.height, transform, options);
  return { image: renderPlan(image, plan), width: plan.width, height: plan.height, geoTransform: plan.geoTransform, extent: plan.extent };
}

/** Options for {@link rotate}. */
export interface RotateOptions {
  /** Default `bilinear`. Quarter turns are exact whatever the method. */
  resample?: Resample;
  /** Grow the canvas to fit the rotated image (default true), or keep the input size. */
  expand?: boolean;
  /** Fill for the corners. Default transparent. */
  background?: RGBA;
}

/** Rotates by `degrees`, clockwise, about the image center. */
export function rotate(image: ImageDataLike, degrees: number, options: RotateOptions = {}): ImageData {
  assertImageData(image, HINT);
  if (!Number.isFinite(degrees)) throw new RangeError('`degrees` must be a finite number.');
  const { width, height } = image;
  const t = rotation(degrees, [width / 2, height / 2]);
  const base = { resample: options.resample, background: options.background, yUp: false };
  const opts: OutputOptions =
    options.expand === false ? { ...base, extent: [0, 0, width, height], width, height } : { ...base, pixelSize: 1 };
  return warpImageData(image, t, opts).image;
}

/** Which way {@link flip} mirrors: `horizontal` swaps left and right, `vertical` top and bottom. */
export type FlipDirection = 'horizontal' | 'vertical' | 'both';

/** Mirrors the image. Exact: pixels are moved, not resampled. */
export function flip(image: ImageDataLike, direction: FlipDirection = 'horizontal'): ImageData {
  assertImageData(image, HINT);
  if (direction !== 'horizontal' && direction !== 'vertical' && direction !== 'both') {
    throw new TypeError(`Unknown flip direction: ${String(direction)}`);
  }
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data.length);
  const h = direction !== 'vertical';
  const v = direction !== 'horizontal';
  for (let y = 0; y < height; y++) {
    const sy = v ? height - 1 - y : y;
    for (let x = 0; x < width; x++) {
      const sx = h ? width - 1 - x : x;
      const s = (sy * width + sx) * 4;
      const o = (y * width + x) * 4;
      out[o] = data[s];
      out[o + 1] = data[s + 1];
      out[o + 2] = data[s + 2];
      out[o + 3] = data[s + 3];
    }
  }
  return createImageData(out, width, height);
}

/** A rectangle in whole pixels, for {@link crop}. */
export interface CropRect {
  /** Left edge. */
  x: number;
  /** Top edge. */
  y: number;
  /** Width, at least 1. */
  width: number;
  /** Height, at least 1. */
  height: number;
}

/** Cuts out a rectangle (whole pixels, inside the image). Exact. */
export function crop(image: ImageDataLike, rect: CropRect): ImageData {
  assertImageData(image, HINT);
  const { x, y, width, height } = rect ?? ({} as CropRect);
  if (![x, y, width, height].every(Number.isInteger) || width < 1 || height < 1) {
    throw new RangeError('The crop rectangle needs whole-pixel x, y, width and height (width and height at least 1).');
  }
  if (x < 0 || y < 0 || x + width > image.width || y + height > image.height) {
    throw new RangeError(`The crop rectangle ${width}x${height}+${x}+${y} is outside the ${image.width}x${image.height} image.`);
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let j = 0; j < height; j++) {
    const s = ((y + j) * image.width + x) * 4;
    out.set(image.data.subarray(s, s + width * 4), j * width * 4);
  }
  return createImageData(out, width, height);
}

/** Options for {@link resize}. */
export interface ResizeOptions {
  /** Default `bilinear`. Shrinking by more than 2× halves the image first to avoid aliasing. */
  resample?: Resample;
}

/** Scales to exactly `width` × `height` pixels. */
export function resize(image: ImageDataLike, width: number, height: number, options: ResizeOptions = {}): ImageData {
  assertImageData(image, HINT);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError('`width` and `height` must be whole numbers of at least 1.');
  }
  const t = scaling(width / image.width, height / image.height);
  return warpImageData(image, t, { resample: options.resample, extent: [0, 0, width, height], width, height, yUp: false, edges: 'clamp' }).image;
}
