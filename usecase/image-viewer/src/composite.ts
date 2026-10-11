/**
 * Color composites of separate images: a band of one image in red, a band of
 * another in green, a third in blue, for example two or three dates of a SAR
 * or monochrome scene, so what changed between them shows in color.
 *
 * The images need not share a grid, a CRS or even a map projection: the
 * result is made on one grid (the reference image's, or Web Mercator around
 * an image placed by its sensor model), and each output pixel is looked up
 * in each image through the map's projections. The lookup is computed
 * exactly on a coarse mesh of output pixels ({@link meshOf}) and interpolated
 * between its nodes, in workers ({@link resampleMesh}); the projections
 * themselves stay on the main thread.
 *
 * The result keeps each image's values (a common sample type, else 32-bit
 * float), so it is stretched, band by band, like any other image.
 */
import type { Grid } from './pansharpen.js';
import { cutTiles, type Tile, type TileSamples } from './tiff-stream.js';

/** Output pixels between the nodes of the lookup mesh. */
export const MESH_STEP = 32;

/** Maps output pixel positions (x right, y down, in output pixels) to an image's pixel positions, in place in `xy` (pairs); NaN where it has none. */
export type PixelLookup = (xy: Float64Array) => void;

/**
 * Where output pixels `[x0, y0, x0 + width, y0 + height)` fall in an image:
 * its pixel position (a pixel covers `[i, i + 1)`) at the centre of every
 * `step`-th output pixel across and down, the last node at or past the
 * block's last pixel. `cols` × `rows` nodes, x then y.
 */
export function meshOf(
  lookup: PixelLookup,
  x0: number,
  y0: number,
  width: number,
  height: number,
  step = MESH_STEP,
): { mesh: Float64Array; cols: number; rows: number } {
  const cols = Math.floor((width - 1) / step) + 2;
  const rows = Math.floor((height - 1) / step) + 2;
  const mesh = new Float64Array(cols * rows * 2);
  for (let r = 0, k = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++, k += 2) {
      mesh[k] = x0 + c * step + 0.5;
      mesh[k + 1] = y0 + r * step + 0.5;
    }
  }
  lookup(mesh);
  return { mesh, cols, rows };
}

/** The pixel window `[x0, y0, x1, y1]` of an image (`width` × `height`) a mesh falls in, with `margin` pixels around, or null when it falls outside. */
export function meshWindow(mesh: Float64Array, width: number, height: number, margin = 2): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let k = 0; k < mesh.length; k += 2) {
    const x = mesh[k];
    const y = mesh[k + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const x0 = Math.max(0, Math.floor(minX) - margin);
  const y0 = Math.max(0, Math.floor(minY) - margin);
  const x1 = Math.min(width, Math.ceil(maxX) + margin);
  const y1 = Math.min(height, Math.ceil(maxY) + margin);
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

/** One band of an image as read for a block: `width` × `height` samples of `window` (full-resolution pixels). */
export interface ChannelRead {
  data: ArrayLike<number>;
  width: number;
  height: number;
  window: readonly [number, number, number, number];
  /** The image's no-data value (null: none). NaN always counts as no data. */
  noData: number | null;
  mesh: Float64Array;
  cols: number;
  rows: number;
}

export type Resampling = 'bilinear' | 'nearest';

/**
 * Fills band `band` of `out` (`bands` interleaved, `width` × `height`) from
 * one image read for the block, looking each output pixel up through the
 * mesh. Pixels outside the image, or on its no data, get `fill`; values are
 * rounded for an integer `out`. Returns how many pixels got a value.
 */
export function resampleMesh(
  read: ChannelRead,
  out: { [i: number]: number; length: number },
  width: number,
  height: number,
  band: number,
  bands: number,
  resample: Resampling,
  fill: number,
  step = MESH_STEP,
): number {
  const round = !(out instanceof Float32Array || out instanceof Float64Array);
  const { data, mesh, cols } = read;
  const [wx0, wy0, wx1, wy1] = read.window;
  const sx = read.width / (wx1 - wx0);
  const sy = read.height / (wy1 - wy0);
  const rw = read.width;
  const rh = read.height;
  const noData = read.noData;
  const valid = (v: number) => v === v && v !== noData;
  let count = 0;
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
      // The image pixel position, interpolated between the four nodes, in read pixels.
      const top = mesh[k00] + (mesh[k10] - mesh[k00]) * fx;
      const bottom = mesh[k01] + (mesh[k11] - mesh[k01]) * fx;
      const u = (top + (bottom - top) * fy - wx0) * sx;
      const topY = mesh[k00 + 1] + (mesh[k10 + 1] - mesh[k00 + 1]) * fx;
      const bottomY = mesh[k01 + 1] + (mesh[k11 + 1] - mesh[k01 + 1]) * fx;
      const v = (topY + (bottomY - topY) * fy - wy0) * sy;
      const o = (y * width + x) * bands + band;
      let value = fill;
      let got = false;
      if (u >= 0 && v >= 0 && u < rw && v < rh) {
        if (resample === 'nearest') {
          const s = data[Math.floor(v) * rw + Math.floor(u)];
          if (valid(s)) {
            value = s;
            got = true;
          }
        } else {
          // Bilinear between the four nearest pixel centres; no data left out (and the weights of the rest renormalized).
          const px = Math.min(Math.max(u - 0.5, 0), rw - 1);
          const py = Math.min(Math.max(v - 0.5, 0), rh - 1);
          const i0 = Math.floor(px);
          const j0 = Math.floor(py);
          const i1 = Math.min(i0 + 1, rw - 1);
          const j1 = Math.min(j0 + 1, rh - 1);
          const ax = px - i0;
          const ay = py - j0;
          let sum = 0;
          let weight = 0;
          const add = (i: number, j: number, w: number) => {
            const s = data[j * rw + i];
            if (w > 0 && valid(s)) {
              sum += s * w;
              weight += w;
            }
          };
          add(i0, j0, (1 - ax) * (1 - ay));
          add(i1, j0, ax * (1 - ay));
          add(i0, j1, (1 - ax) * ay);
          add(i1, j1, ax * ay);
          if (weight > 1e-9) {
            value = sum / weight;
            got = true;
          }
        }
      }
      out[o] = got && round ? Math.round(value) : value;
      if (got) count++;
    }
  }
  return count;
}

/** A sample type, as TIFF describes it. */
export interface SampleType {
  /** 1 unsigned, 2 signed integer, 3 float. */
  format: number;
  bits: number;
}

/** The sample type every input shares, else 32-bit float. */
export function commonSampleType(types: readonly SampleType[]): SampleType {
  const [first] = types;
  if (first && types.every((t) => t.format === first.format && t.bits === first.bits) && [8, 16, 32, 64].includes(first.bits)) return first;
  return { format: 3, bits: 32 };
}

type SampleArray = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;

/** An array of `length` samples of `type`. */
export function samplesOf(type: SampleType, length: number): SampleArray {
  if (type.format === 3) return type.bits === 64 ? new Float64Array(length) : new Float32Array(length);
  const signed = type.format === 2;
  if (type.bits === 8) return signed ? new Int8Array(length) : new Uint8Array(length);
  if (type.bits === 16) return signed ? new Int16Array(length) : new Uint16Array(length);
  return signed ? new Int32Array(length) : new Uint32Array(length);
}

/** The output's no-data value: NaN for floats, 0 for integers. */
export const fillOf = (type: SampleType): number => (type.format === 3 ? NaN : 0);

/** An extent `[minX, minY, maxX, maxY]`. */
export type Box = [number, number, number, number];

/** The intersection of extents (null when empty), or their union. */
export function combine(boxes: readonly Box[], how: 'intersection' | 'union'): Box | null {
  if (!boxes.length) return null;
  const pick = how === 'intersection' ? [Math.max, Math.max, Math.min, Math.min] : [Math.min, Math.min, Math.max, Math.max];
  const out = boxes.reduce((a, b) => a.map((v, i) => pick[i](v, b[i])) as Box);
  return out[2] > out[0] && out[3] > out[1] ? out : null;
}

/**
 * The output grid covering `box` on the lattice of `origin` and `size`
 * (pixel corners at `origin + k * size`), north up.
 */
export function gridOver(box: Box, origin: readonly [number, number], size: readonly [number, number]): Grid {
  const sx = Math.abs(size[0]);
  const sy = Math.abs(size[1]);
  const x0 = origin[0] + Math.floor((box[0] - origin[0]) / sx + 1e-6) * sx;
  const y0 = origin[1] + Math.ceil((box[3] - origin[1]) / sy - 1e-6) * sy;
  const width = Math.max(1, Math.ceil((box[2] - x0) / sx - 1e-6));
  const height = Math.max(1, Math.ceil((y0 - box[1]) / sy - 1e-6));
  return { width, height, origin: [x0, y0], resolution: [sx, -sy] };
}

export interface CompositeTask {
  width: number;
  height: number;
  /** One per output band; null leaves the band empty (no data). */
  channels: Array<ChannelRead | null>;
  type: SampleType;
  resample: Resampling;
  tileSize: number;
  /** The block's first tile, in tiles. */
  tx0: number;
  ty0: number;
}

/** A made block: its tiles, each band's lowest and highest value (no data left out), and how many pixels have a value in some band. */
export interface CompositeBlock {
  tiles: Tile[];
  min: number[];
  max: number[];
  covered: number;
}

/** Makes one block of a composite: each band looked up in its image, then cut into tiles. */
export function makeBlock(task: CompositeTask): CompositeBlock {
  const { width, height, channels, type } = task;
  const bands = channels.length;
  const fill = fillOf(type);
  const data = samplesOf(type, width * height * bands) as TileSamples;
  if (fill !== 0) data.fill(fill);
  channels.forEach((read, band) => {
    if (read) resampleMesh(read, data, width, height, band, bands, task.resample, fill);
  });
  const min = new Array<number>(bands).fill(Infinity);
  const max = new Array<number>(bands).fill(-Infinity);
  let covered = 0;
  for (let i = 0; i < data.length; i += bands) {
    let any = false;
    for (let b = 0; b < bands; b++) {
      const v = data[i + b];
      if (v !== v || v === fill || !channels[b]) continue;
      any = true;
      if (v < min[b]) min[b] = v;
      if (v > max[b]) max[b] = v;
    }
    if (any) covered++;
  }
  const tiles = cutTiles(data, width, height, bands, task.tileSize, task.tx0, task.ty0, fill);
  return { tiles, min, max, covered };
}
