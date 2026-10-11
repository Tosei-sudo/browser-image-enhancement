/**
 * Mosaics: several images joined into one, on one grid (see composite.ts for
 * how each output pixel is looked up in each image). Where images overlap,
 * the first in priority order wins, or they are averaged; where an image has
 * no data (its no-data value, NaN, outside it, or optionally black), the
 * next one shows through. With feathering, each image fades out over the
 * last `feather` pixels before its edge or its no data into the images under
 * it (as if laid over them with that much transparency), so seams blend;
 * where nothing is under it, it is not faded.
 *
 * Blocks are made in workers ({@link makeMosaicBlock}). For feathering, each
 * block is looked up with a margin of `feather` pixels around it, so the
 * distance to an image's edge is the same on both sides of a block border.
 */
import { MESH_STEP, fillOf, samplesOf, type CompositeBlock, type Resampling, type SampleType } from './composite.js';
import { cutTiles, type TileSamples } from './tiff-stream.js';

/** All the bands of one image as read for a block: `width` × `height` pixels of `window` (full-resolution pixels), `bands` interleaved. */
export interface MosaicRead {
  data: ArrayLike<number>;
  bands: number;
  width: number;
  height: number;
  window: readonly [number, number, number, number];
  /** The image's no-data value (null: none). NaN always counts as no data. */
  noData: number | null;
  /** Whether a pixel 0 in every band (a black collar) counts as no data. */
  zeroIsEmpty: boolean;
  /** Lookup mesh over the block and its margin (see meshOf). */
  mesh: Float64Array;
  cols: number;
  rows: number;
}

/** How overlapping images are combined: the first in priority order, or the average of all. */
export type Overlap = 'priority' | 'average';

export interface MosaicTask {
  /** The block, in output pixels (without the margin). */
  width: number;
  height: number;
  /** Output pixels looked up around the block on each side (the feather width, else 0). */
  pad: number;
  bands: number;
  /** The images, first priority first; null where an image falls outside the block. */
  reads: Array<MosaicRead | null>;
  type: SampleType;
  resample: Resampling;
  overlap: Overlap;
  /** Fade width in output pixels; 0: hard edges. */
  feather: number;
  tileSize: number;
  /** The block's first tile, in tiles. */
  tx0: number;
  ty0: number;
}

/** Whether the pixel starting at `i` (bands interleaved) has no data. */
function empty(data: ArrayLike<number>, i: number, bands: number, noData: number | null, zero: boolean): boolean {
  for (let b = 0; b < bands; b++) {
    const s = data[i + b];
    if (s === s && s !== noData && !(zero && s === 0)) return false;
  }
  return true;
}

/**
 * Looks every pixel of a `width` × `height` window of output pixels up in
 * one image, all bands: `out` gets the values (NaN where a band has none),
 * `valid` 1 where the pixel has data. Returns how many pixels have data.
 */
export function resampleBands(
  read: MosaicRead,
  out: Float32Array,
  valid: Uint8Array,
  width: number,
  height: number,
  resample: Resampling,
  step = MESH_STEP,
): number {
  const { data, mesh, cols, bands, noData, zeroIsEmpty: zero } = read;
  const [wx0, wy0, wx1, wy1] = read.window;
  const sx = read.width / (wx1 - wx0);
  const sy = read.height / (wy1 - wy0);
  const rw = read.width;
  const rh = read.height;
  const sums = new Float64Array(bands);
  const weights = new Float64Array(bands);
  let count = 0;
  out.fill(NaN);
  valid.fill(0);
  for (let y = 0; y < height; y++) {
    const r = Math.floor(y / step);
    const fy = (y - r * step) / step;
    for (let x = 0; x < width; x++) {
      const c = Math.floor(x / step);
      const fx = (x - c * step) / step;
      const k00 = 2 * (r * cols + c);
      const k10 = k00 + 2;
      const k01 = k00 + 2 * cols;
      const k11 = k01 + 2;
      const top = mesh[k00] + (mesh[k10] - mesh[k00]) * fx;
      const bottom = mesh[k01] + (mesh[k11] - mesh[k01]) * fx;
      const u = (top + (bottom - top) * fy - wx0) * sx;
      const topY = mesh[k00 + 1] + (mesh[k10 + 1] - mesh[k00 + 1]) * fx;
      const bottomY = mesh[k01 + 1] + (mesh[k11 + 1] - mesh[k01 + 1]) * fx;
      const v = (topY + (bottomY - topY) * fy - wy0) * sy;
      if (!(u >= 0 && v >= 0 && u < rw && v < rh)) continue;
      const p = y * width + x;
      const o = p * bands;
      if (resample === 'nearest') {
        const i = (Math.floor(v) * rw + Math.floor(u)) * bands;
        if (empty(data, i, bands, noData, zero)) continue;
        for (let b = 0; b < bands; b++) out[o + b] = data[i + b];
      } else {
        // Bilinear between the four nearest pixel centres, pixels with no data left out (and the rest renormalized).
        const px = Math.min(Math.max(u - 0.5, 0), rw - 1);
        const py = Math.min(Math.max(v - 0.5, 0), rh - 1);
        const i0 = Math.floor(px);
        const j0 = Math.floor(py);
        const i1 = Math.min(i0 + 1, rw - 1);
        const j1 = Math.min(j0 + 1, rh - 1);
        const ax = px - i0;
        const ay = py - j0;
        sums.fill(0);
        weights.fill(0);
        let any = false;
        const add = (i: number, j: number, w: number) => {
          if (w <= 0) return;
          const at = (j * rw + i) * bands;
          if (empty(data, at, bands, noData, zero)) return;
          any = true;
          for (let b = 0; b < bands; b++) {
            const s = data[at + b];
            if (s !== s) continue;
            sums[b] += s * w;
            weights[b] += w;
          }
        };
        add(i0, j0, (1 - ax) * (1 - ay));
        add(i1, j0, ax * (1 - ay));
        add(i0, j1, (1 - ax) * ay);
        add(i1, j1, ax * ay);
        if (!any) continue;
        for (let b = 0; b < bands; b++) if (weights[b] > 1e-9) out[o + b] = sums[b] / weights[b];
      }
      valid[p] = 1;
      count++;
    }
  }
  return count;
}

/**
 * The distance, in pixels, from each pixel with data to the nearest pixel
 * without (a 3-4 chamfer distance, within about 8% of the straight one),
 * capped at `cap`; 0 where there is no data. Beyond the window counts as data.
 */
export function distanceToEmpty(valid: Uint8Array, width: number, height: number, cap: number): Float32Array {
  const big = 3 * cap + 3;
  const d = new Float32Array(width * height);
  for (let i = 0; i < d.length; i++) d[i] = valid[i] ? big : 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let v = d[i];
      if (!v) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      if (y > 0) {
        v = Math.min(v, d[i - width] + 3);
        if (x > 0) v = Math.min(v, d[i - width - 1] + 4);
        if (x < width - 1) v = Math.min(v, d[i - width + 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      let v = d[i];
      if (!v) continue;
      if (x < width - 1) v = Math.min(v, d[i + 1] + 3);
      if (y < height - 1) {
        v = Math.min(v, d[i + width] + 3);
        if (x < width - 1) v = Math.min(v, d[i + width + 1] + 4);
        if (x > 0) v = Math.min(v, d[i + width - 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let i = 0; i < d.length; i++) d[i] = Math.min(cap, d[i] / 3);
  return d;
}

/**
 * Makes one block of a mosaic: each image looked up in priority order and
 * laid under the ones before it (or averaged with them), then cut into tiles.
 */
export function makeMosaicBlock(task: MosaicTask): CompositeBlock {
  const { width, height, pad, bands, type, overlap, feather } = task;
  const pw = width + 2 * pad;
  const ph = height + 2 * pad;
  const n = width * height;
  const sums = new Float64Array(n * bands);
  const weights = new Float32Array(n * bands);
  // How much of each pixel the images before have left for the next ones (priority).
  const left = new Float32Array(n).fill(1);
  // The last image's values, which take whatever the images before it left: it is laid over nothing, so it is not faded.
  const last = overlap === 'priority' && feather > 0 ? new Float32Array(n * bands).fill(NaN) : null;
  let open = n;
  const values = new Float32Array(pw * ph * bands);
  const valid = new Uint8Array(pw * ph);
  for (const read of task.reads) {
    if (!read || (overlap === 'priority' && !open)) continue;
    if (!resampleBands(read, values, valid, pw, ph, task.resample)) continue;
    const distance = feather > 0 ? distanceToEmpty(valid, pw, ph, feather) : null;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const q = (y + pad) * pw + x + pad;
        if (!valid[q]) continue;
        const p = y * width + x;
        let w = distance ? distance[q] / feather : 1;
        if (overlap === 'priority') {
          if (left[p] <= 0) continue;
          w *= left[p];
          left[p] -= w;
          if (left[p] <= 1e-6) {
            left[p] = 0;
            open--;
          }
        }
        if (w <= 0) continue;
        for (let b = 0; b < bands; b++) {
          const v = values[q * bands + b];
          if (v !== v) continue;
          sums[p * bands + b] += v * w;
          weights[p * bands + b] += w;
          if (last) last[p * bands + b] = v;
        }
      }
    }
  }
  if (last) {
    for (let p = 0; p < n; p++) {
      if (left[p] <= 0) continue;
      for (let i = p * bands; i < (p + 1) * bands; i++) {
        if (last[i] !== last[i]) continue;
        sums[i] += last[i] * left[p];
        weights[i] += left[p];
      }
    }
  }

  const fill = fillOf(type);
  const round = type.format !== 3;
  const data = samplesOf(type, n * bands) as TileSamples;
  const min = new Array<number>(bands).fill(Infinity);
  const max = new Array<number>(bands).fill(-Infinity);
  let covered = 0;
  for (let p = 0; p < n; p++) {
    let any = false;
    for (let b = 0; b < bands; b++) {
      const i = p * bands + b;
      if (weights[i] <= 1e-9) {
        data[i] = fill;
        continue;
      }
      const v = round ? Math.round(sums[i] / weights[i]) : sums[i] / weights[i];
      data[i] = v;
      any = true;
      if (v < min[b]) min[b] = v;
      if (v > max[b]) max[b] = v;
    }
    if (any) covered++;
  }
  const tiles = cutTiles(data, width, height, bands, task.tileSize, task.tx0, task.ty0, fill);
  return { tiles, min, max, covered };
}
