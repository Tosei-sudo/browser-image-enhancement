/**
 * Functional API: one synchronous correction per call, on the calling thread.
 *
 * Each call returns a new ImageData and leaves its input untouched. Chaining
 * calls rounds to 8 bits after every step; use `pipeline()` to chain without
 * intermediate rounding.
 */
import { createImageData, assertImageData } from './core/image.js';
import { compile, processPixels, resolveMode } from './core/process.js';
import { resolveForPixels } from './core/histogram.js';
import { normalizeOp } from './ops/index.js';
import type { AutoStretchOptions, ColorOptions, ImageDataLike, LevelsOptions, OpSpec, StretchOptions } from './types.js';
import { warn } from './warn.js';

/** Runs normalized-or-raw ops on an image synchronously. Shared by the pipeline's sync path. */
export function applySync(image: ImageDataLike, ops: readonly OpSpec[], options: ColorOptions = {}): ImageData {
  assertImageData(image);
  const mode = resolveMode(image.data, options.colorMode);
  const resolved = resolveForPixels(ops.map(normalizeOp), image.data, mode);
  if (mode === 'gray') warnColorOnly(resolved);
  const out = new Uint8ClampedArray(image.data.length);
  processPixels(image.data, out, compile(resolved, mode));
  return createImageData(out, image.width, image.height);
}

/**
 * Warns when color-only corrections are requested for an image computed as
 * gray: saturation, temperature, and a stretch with different points per channel.
 */
export function warnColorOnly(ops: readonly OpSpec[]): void {
  const ignored = ops
    .filter((op) => (op.op === 'saturation' || op.op === 'temperature') && op.amount !== 0)
    .map((op) => op.op);
  if (ignored.length > 0) {
    warn(
      `${ignored.join(', ')} has no effect on a monochrome image. ` + "Pass colorMode: 'rgb' to tint it.",
    );
  }
  if (ops.some((op) => op.op === 'stretch' && !(sameChannels(op.black) && sameChannels(op.white)))) {
    warn("A per-channel stretch uses the mean of its R, G, B points on a monochrome image. Pass colorMode: 'rgb' to tint it.");
  }
}

function sameChannels(v: readonly number[]): boolean {
  return v[0] === v[1] && v[1] === v[2];
}

/** Brightness, -1 to 1. Positive moves toward white, negative toward black. */
export function brightness(image: ImageDataLike, amount: number, options?: ColorOptions): ImageData {
  return applySync(image, [{ op: 'brightness', amount }], options);
}

/** Contrast around mid-gray, -1 (flat gray) to 1 (threshold). */
export function contrast(image: ImageDataLike, amount: number, options?: ColorOptions): ImageData {
  return applySync(image, [{ op: 'contrast', amount }], options);
}

/** Exposure in EV stops, -10 to 10. +1 doubles the light. */
export function exposure(image: ImageDataLike, ev: number, options?: ColorOptions): ImageData {
  return applySync(image, [{ op: 'exposure', ev }], options);
}

/** Gamma, 0.1 to 10. Values above 1 brighten midtones. */
export function gamma(image: ImageDataLike, value: number, options?: ColorOptions): ImageData {
  return applySync(image, [{ op: 'gamma', gamma: value }], options);
}

/** Saturation, -1 (grayscale) to 1 (double). No effect on monochrome images. */
export function saturation(image: ImageDataLike, amount: number, options?: ColorOptions): ImageData {
  return applySync(image, [{ op: 'saturation', amount }], options);
}

/** Color temperature, -1 (cooler/bluer) to 1 (warmer/yellower). No effect on monochrome images. */
export function temperature(image: ImageDataLike, amount: number, options?: ColorOptions): ImageData {
  return applySync(image, [{ op: 'temperature', amount }], options);
}

/** Levels: input/output black and white points (0-1, sRGB-encoded) and midtone gamma. */
export function levels(image: ImageDataLike, params: LevelsOptions, options?: ColorOptions): ImageData {
  return applySync(image, [{ op: 'levels', ...params } as OpSpec], options);
}

/**
 * Stretches the range black..white (sRGB-encoded, one number or [R, G, B]) to
 * full black..white, clipping values outside it.
 */
export function stretch(image: ImageDataLike, params: StretchOptions, options?: ColorOptions): ImageData {
  return applySync(image, [{ op: 'stretch', ...params } as OpSpec], options);
}

/**
 * Automatic stretch (dynamic range adjustment): picks the range from the
 * image's own pixel distribution, ignoring transparent pixels.
 */
export function autoStretch(image: ImageDataLike, params?: AutoStretchOptions, options?: ColorOptions): ImageData {
  return applySync(image, [{ op: 'autoStretch', ...params } as OpSpec], options);
}
