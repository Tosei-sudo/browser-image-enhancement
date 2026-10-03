/**
 * Band assignment: which band of an image goes to R, G and B. A multiband
 * raster (multispectral imagery, a GeoTIFF with more bands than a screen has
 * channels) shows any three of its bands as a color composite, for example
 * near-infrared, red and green as a false-color image; one band given to all
 * three channels shows it in gray.
 */
import { createImageData } from './core/image.js';
import type { ImageDataLike } from './types.js';
import type { Raster } from './raster.js';

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

function sameKind<T extends ArrayLike<number>>(like: T, length: number): T & { [i: number]: number } {
  const Ctor = (like as unknown as { constructor: new (n: number) => T }).constructor;
  if (ArrayBuffer.isView(like)) return new Ctor(length) as T & { [i: number]: number };
  return new Array<number>(length).fill(0) as unknown as T & { [i: number]: number };
}

function checkSelect(select: readonly number[], bands: number, alpha: number): void {
  if (select.length === 0 || select.some((b) => !Number.isInteger(b) || b < 0 || b >= bands || b === alpha)) {
    throw new RangeError(`Bands must be value bands of the ${bands} (0-based${alpha >= 0 ? `, ${alpha} is alpha` : ''}), got ${JSON.stringify(select)}.`);
  }
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
export function selectBands<T extends ArrayLike<number>>(raster: Raster & { data: T }, select: readonly number[]): SelectedBands<T> {
  const bands = raster.bands ?? 1;
  if (!Number.isInteger(bands) || bands < 1) throw new RangeError(`bands must be a positive integer, got ${String(raster.bands)}.`);
  const pixels = raster.width * raster.height;
  if (raster.data.length < pixels * bands) {
    throw new RangeError(`A ${raster.width}x${raster.height} raster with ${bands} bands needs ${pixels * bands} values, got ${raster.data.length}.`);
  }
  const alpha = raster.alpha ? bands - 1 : -1;
  checkSelect(select, bands, alpha);
  const from = alpha >= 0 ? [...select, alpha] : [...select];
  const n = from.length;
  const src = raster.data;
  const out = sameKind(src, pixels * n);
  for (let p = 0, i = 0, o = 0; p < pixels; p++, i += bands, o += n) {
    for (let c = 0; c < n; c++) out[o + c] = src[i + from[c]];
  }
  return {
    data: out,
    width: raster.width,
    height: raster.height,
    bands: n,
    alpha: alpha >= 0,
    ...(raster.noData !== undefined ? { noData: raster.noData } : {}),
  };
}

/**
 * Gives R, G and B the channels `bands` names (0 = R, 1 = G, 2 = B, 3 = A) of
 * an 8-bit RGBA image: `[2, 1, 0]` swaps red and blue, `[1, 1, 1]` shows the
 * green channel in gray. Alpha is kept. For rasters with more bands, use
 * {@link selectBands} or the `select` of `rasterToImageData`.
 */
export function assignBands(image: ImageDataLike, bands: BandSelection): ImageData {
  const [r, g, b] = bands.length === 1 ? [bands[0], bands[0], bands[0]] : bands;
  checkSelect([r, g, b], 4, -1);
  const src = image.data;
  const pixels = image.width * image.height;
  if (src.length < pixels * 4) throw new RangeError(`A ${image.width}x${image.height} image needs ${pixels * 4} values, got ${src.length}.`);
  const out = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = src[i + r];
    out[i + 1] = src[i + g];
    out[i + 2] = src[i + b];
    out[i + 3] = src[i + 3];
  }
  return createImageData(out, image.width, image.height);
}

/** Whether a selection shows one band in gray (one index, or three equal ones). */
export function isGraySelection(select: BandSelection): boolean {
  return select.length === 1 || (select[0] === select[1] && select[1] === select[2]);
}
