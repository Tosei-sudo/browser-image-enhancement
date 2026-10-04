/**
 * Warping rasters of any band count and sample type (16-bit, float, ...),
 * such as satellite images and elevation models, keeping their values:
 * nothing is converted to 8-bit RGBA. Pixels whose first band is the no-data
 * value (or NaN) are left out of the interpolation, and output pixels outside the source
 * get the no-data value.
 */
import { planWarp, type OutputOptions, type Plan, type WarpInfo } from './plan.js';
import { rowMapper } from './resample.js';
import type { Transform } from './types.js';

/** Pixel values {@link warpRaster} can warp. */
export type RasterSamples = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;

/** A raster: any number of bands of one sample type, pixel-interleaved. */
export interface Raster<T extends RasterSamples = RasterSamples> {
  /** Width in pixels. */
  width: number;
  /** Height in pixels. */
  height: number;
  /** Samples per pixel. */
  bands: number;
  /** `bands` values for each pixel, row by row. */
  data: T;
  /** Value of pixels with no data. Default: none (NaN still counts as no data). */
  noData?: number | null;
}

/** Options for {@link warpRaster}: those of the RGBA warp except `background`. */
export type RasterWarpOptions = Omit<OutputOptions, 'background'>;

/** A warped raster and where it sits in output coordinates. */
export interface RasterWarpResult<T extends RasterSamples = RasterSamples> extends WarpInfo {
  /** The output raster, same sample type and band count as the input. */
  readonly raster: Raster<T>;
}

/**
 * Applies `transform` to a raster on the calling thread, keeping its sample
 * type. Output pixels outside the source get the no-data value (0 when the
 * raster has none and the samples are integers, NaN for floats).
 *
 * @example
 * ```ts
 * const { raster, geoTransform } = warpRaster(
 *   { width, height, bands: 4, data: uint16, noData: 0 },
 *   fit.transform,
 *   { resample: 'bilinear', coordinateTransform: proj4('EPSG:4326', 'EPSG:3857') },
 * );
 * ```
 */
export function warpRaster<T extends RasterSamples>(raster: Raster<T>, transform: Transform, options: RasterWarpOptions = {}): RasterWarpResult<T> {
  const { width, height, bands, data } = raster;
  if (!(width > 0 && height > 0 && bands > 0) || data.length !== width * height * bands) {
    throw new RangeError('A raster needs width × height × bands samples.');
  }
  const plan = planWarp(width, height, transform, options);
  let source: Raster<T> = raster;
  for (let i = 0; i < plan.levels; i++) source = halveRaster(source);
  const out = renderRaster(source, plan);
  return { raster: out, geoTransform: plan.geoTransform, extent: plan.extent };
}

function isFloat(data: RasterSamples): boolean {
  return data instanceof Float32Array || data instanceof Float64Array;
}

function fillValue(raster: Raster): number {
  return raster.noData ?? (isFloat(raster.data) ? NaN : 0);
}

/** Keys cubic convolution (a = -0.5), as for RGBA. */
function cubic(t: number): number {
  const x = Math.abs(t);
  if (x < 1) return (1.5 * x - 2.5) * x * x + 1;
  if (x < 2) return ((-0.5 * x + 2.5) * x - 4) * x + 2;
  return 0;
}

/** Rounds and clamps to the integer type's range; floats pass through. */
function storer(data: RasterSamples): (v: number) => number {
  if (isFloat(data)) return (v) => v;
  const [min, max] =
    data instanceof Uint8Array ? [0, 255]
    : data instanceof Int8Array ? [-128, 127]
    : data instanceof Uint16Array ? [0, 65535]
    : data instanceof Int16Array ? [-32768, 32767]
    : data instanceof Uint32Array ? [0, 4294967295]
    : [-2147483648, 2147483647];
  return (v) => Math.min(max, Math.max(min, Math.round(v)));
}

function renderRaster<T extends RasterSamples>(src: Raster<T>, plan: Plan): Raster<T> {
  const { width, height, mapping, resample } = plan;
  const { width: sw, height: sh, bands, data } = src;
  const noData = src.noData ?? null;
  const fill = fillValue(src);
  const store = storer(data);
  const out = new (data.constructor as new (n: number) => T)(width * height * bands);
  const map = rowMapper(mapping);
  const pos = new Float64Array(width * 2);
  const sum = new Float64Array(bands);
  const taps = resample === 'bicubic' ? 4 : 2;
  const first = resample === 'bicubic' ? -1 : 0;
  const wx = new Float64Array(4);
  const wy = new Float64Array(4);
  const valid = (v: number) => v === v && v !== noData;

  for (let y = 0; y < height; y++) {
    map(y, width, pos);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * bands;
      const sx = pos[x * 2];
      const sy = pos[x * 2 + 1];
      let written = false;
      if (Number.isFinite(sx) && Number.isFinite(sy) && sx >= 0 && sy >= 0 && sx <= sw && sy <= sh) {
        if (resample === 'nearest') {
          const i = Math.min(sw - 1, Math.floor(sx));
          const j = Math.min(sh - 1, Math.floor(sy));
          const s = (j * sw + i) * bands;
          if (valid(data[s])) {
            for (let b = 0; b < bands; b++) out[o + b] = data[s + b];
            written = true;
          }
        } else {
          // Pixel centers sit at half-integers. No-data neighbours are left out and the weights renormalized.
          const px = sx - 0.5;
          const py = sy - 0.5;
          const ix = Math.floor(px);
          const iy = Math.floor(py);
          const fx = px - ix;
          const fy = py - iy;
          if (taps === 2) {
            wx[0] = 1 - fx;
            wx[1] = fx;
            wy[0] = 1 - fy;
            wy[1] = fy;
          } else {
            for (let t = 0; t < 4; t++) {
              wx[t] = cubic(fx - (t - 1));
              wy[t] = cubic(fy - (t - 1));
            }
          }
          sum.fill(0);
          let weight = 0;
          for (let tj = 0; tj < taps; tj++) {
            // Edge pixels repeat outward, so the image reaches its border.
            const j = Math.min(sh - 1, Math.max(0, iy + first + tj));
            if (wy[tj] === 0) continue;
            for (let ti = 0; ti < taps; ti++) {
              const i = Math.min(sw - 1, Math.max(0, ix + first + ti));
              const w = wx[ti] * wy[tj];
              if (w === 0) continue;
              const s = (j * sw + i) * bands;
              if (!valid(data[s])) continue;
              for (let b = 0; b < bands; b++) sum[b] += data[s + b] * w;
              weight += w;
            }
          }
          if (weight > 1e-6) {
            for (let b = 0; b < bands; b++) out[o + b] = store(sum[b] / weight);
            written = true;
          }
        }
      }
      if (!written) for (let b = 0; b < bands; b++) out[o + b] = fill;
    }
  }
  return { width, height, bands, data: out, noData: src.noData };
}

/** Halves a raster (2×2 average per band, leaving out no-data), for shrinking by more than 2× without aliasing. */
export function halveRaster<T extends RasterSamples>(src: Raster<T>): Raster<T> {
  const { width: sw, height: sh, bands, data } = src;
  const w = Math.ceil(sw / 2);
  const h = Math.ceil(sh / 2);
  const noData = src.noData ?? null;
  const fill = fillValue(src);
  const store = storer(data);
  const out = new (data.constructor as new (n: number) => T)(w * h * bands);
  const sum = new Float64Array(bands);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      sum.fill(0);
      let n = 0;
      for (let dy = 0; dy < 2; dy++) {
        const j = 2 * y + dy;
        if (j >= sh) continue;
        for (let dx = 0; dx < 2; dx++) {
          const i = 2 * x + dx;
          if (i >= sw) continue;
          const s = (j * sw + i) * bands;
          const v = data[s];
          if (v !== v || v === noData) continue;
          for (let b = 0; b < bands; b++) sum[b] += data[s + b];
          n++;
        }
      }
      const o = (y * w + x) * bands;
      for (let b = 0; b < bands; b++) out[o + b] = n ? store(sum[b] / n) : fill;
    }
  }
  return { width: w, height: h, bands, data: out, noData: src.noData };
}
