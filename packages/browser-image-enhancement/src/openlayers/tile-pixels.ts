/** Pixel conversions between OpenLayers' tiles (1 to n bands) and RGBA. */
import type { Data } from 'ol/DataTile.js';
import type { BandSelection } from '../bands.js';
import type { ColorMode } from '../types.js';

/** Makes transparent the pixels of a raw tile (alpha last) whose value bands all match `isNoData`, as OpenLayers does for no data. */
export function maskNoData(data: Data, bands: number, isNoData: (v: number) => boolean): Data {
  if (!(data instanceof Float32Array) || bands < 2) return data;
  for (let p = 0; p < data.length; p += bands) {
    if (data[p + bands - 1] === 0) continue;
    let all = true;
    for (let b = 0; b < bands - 1 && all; b++) all = isNoData(data[p + b]);
    if (!all) continue;
    for (let b = 0; b < bands; b++) data[p + b] = 0;
  }
  return data;
}

/** 1 band = gray, 2 = gray + alpha, 3 = RGB, 4 = RGB + alpha (OpenLayers adds alpha for nodata). */
export function colorModeFor(bands: number): ColorMode {
  return bands <= 2 ? 'gray' : 'rgb';
}

export function toRGBA(src: ArrayLike<number>, bands: number, pixels: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels * 4);
  for (let p = 0, i = 0, o = 0; p < pixels; p++, i += bands, o += 4) {
    if (bands <= 2) {
      out[o] = out[o + 1] = out[o + 2] = src[i];
      out[o + 3] = bands === 2 ? src[i + 1] : 255;
    } else {
      out[o] = src[i];
      out[o + 1] = src[i + 1];
      out[o + 2] = src[i + 2];
      out[o + 3] = bands === 4 ? src[i + 3] : 255;
    }
  }
  return out;
}

export function fromRGBA(rgba: Uint8ClampedArray, bands: number, pixels: number): Uint8Array {
  if (bands === 4) return new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.length);
  const out = new Uint8Array(pixels * bands);
  for (let p = 0, i = 0, o = 0; p < pixels; p++, i += 4, o += bands) {
    for (let b = 0; b < bands; b++) out[o + b] = bands <= 2 && b === 1 ? rgba[i + 3] : rgba[i + b];
  }
  return out;
}

/**
 * Three band indexes from a selection (one index means that band in all three).
 * Indexes that can never be a band throw at once, even before the band count is
 * known, so they cannot read the neighbouring pixel's values later.
 */
export function toRgb(select: BandSelection): readonly [number, number, number] {
  if ((select.length !== 1 && select.length !== 3) || select.some((b) => !Number.isInteger(b) || b < 0)) {
    throw new RangeError(`A band selection is 1 or 3 band indexes, each an integer from 0 (0-based), got ${JSON.stringify(select)}.`);
  }
  return select.length === 1 ? [select[0], select[0], select[0]] : [select[0], select[1], select[2]];
}

/** RGBA from three bands of a tile; alpha from the alpha band (`alpha` index, -1 for none) or opaque. */
export function selectRGBA(src: ArrayLike<number>, bands: number, select: readonly number[], alpha: number, pixels: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels * 4);
  const [r, g, b] = select;
  for (let p = 0, i = 0, o = 0; p < pixels; p++, i += bands, o += 4) {
    out[o] = src[i + r];
    out[o + 1] = src[i + g];
    out[o + 2] = src[i + b];
    out[o + 3] = alpha >= 0 ? src[i + alpha] : 255;
  }
  return out;
}

/**
 * A tile of `bands` bands that OpenLayers draws as the RGBA pixels: R, G, B
 * in the first three bands, alpha in the fourth (its first texture), and
 * alpha again in the last band when that is the nodata band it discards on.
 */
export function toSelectedTile(rgba: Uint8ClampedArray, bands: number, hasAlpha: boolean, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels * bands);
  const n = Math.min(bands, 4);
  for (let p = 0, i = 0, o = 0; p < pixels; p++, i += 4, o += bands) {
    for (let c = 0; c < n; c++) out[o + c] = rgba[i + c];
    if (hasAlpha) out[o + bands - 1] = rgba[i + 3];
  }
  return out;
}
