/**
 * Reprojects data tiles on the CPU instead of in a WebGL context.
 *
 * When the map's projection differs from the image's (a UTM satellite image
 * on a Web Mercator map), OpenLayers reprojects every tile in a WebGL
 * context of its own: it compiles shaders, uploads the source tiles, draws
 * the triangulation and reads the result back with `readPixels`, which
 * stalls until the GPU is done. For each tile, on the main thread. That
 * dominated the time tiles took to appear.
 *
 * Here the same triangulation is drawn in plain JS: the source tiles are
 * copied into one buffer around the area the tile needs, and every target
 * pixel inside a triangle is sampled through that triangle's affine map,
 * bilinear (`interpolate`) or nearest, clamped at the edges, like the GPU
 * did. The result is the same: the bands as read, plus a coverage band when
 * the source has no alpha (opaque where the image is, 0 elsewhere).
 *
 * Tiles it cannot handle (images instead of arrays, wrapping across the
 * date line) keep OpenLayers' own reprojection.
 */
import type DataTileSource from 'ol/source/DataTile.js';
import type TileGrid from 'ol/tilegrid/TileGrid.js';
import type { Extent } from 'ol/extent.js';

const LOADED = 2;
const ERROR = 3;

type Coord = number[];
interface Triangle {
  source: Coord[];
  target: Coord[];
}
interface SourceTile {
  tile: { getState(): number; getSize(): number[]; getData(): unknown; tileCoord: number[] };
  offset: number;
}
/** The fields of OpenLayers' `ReprojDataTile` read here (private there, stable across 10.x). */
interface ReprojTile {
  state: number;
  interpolate: boolean;
  changed(): void;
  sourceTiles_: SourceTile[];
  gutter_: number;
  pixelRatio_: number;
  hasAlpha_: boolean;
  sourceTileGrid_: TileGrid;
  targetTileGrid_: TileGrid;
  wrappedTileCoord_: number[];
  clipExtent_?: Extent;
  triangulation_: { getTriangles(): Triangle[] };
  reprojData_: Float32Array | Uint8ClampedArray | null;
  reprojSize_: number[] | undefined;
  reproject_: () => void;
}

type Pixels = Float32Array | Uint8ClampedArray;

/** Makes `source` reproject its tiles on the CPU; tiles it cannot handle keep OpenLayers' way. */
export function reprojectOnCpu(source: DataTileSource): void {
  const host = source as unknown as { getReprojTile_?: (...args: unknown[]) => ReprojTile };
  const original = host.getReprojTile_;
  if (typeof original !== 'function') return; // another OpenLayers: leave it alone
  host.getReprojTile_ = function (this: unknown, ...args: unknown[]) {
    const tile = original.apply(this, args);
    if (tile && typeof tile.reproject_ === 'function') {
      const gpu = tile.reproject_;
      tile.reproject_ = () => {
        let done: boolean;
        try {
          done = reprojectTile(tile);
        } catch {
          done = false;
        }
        if (!done) gpu.call(tile);
      };
    }
    return tile;
  };
}

/** Scratch buffers kept between tiles, so reprojecting allocates only the result. */
let scratchFloat = new Float32Array(0);
let scratchByte = new Uint8ClampedArray(0);
let scratchDone = new Uint8Array(0);

/**
 * Reprojects `tile` from its loaded source tiles; false when it cannot (the
 * caller then lets OpenLayers do it). Sets the tile loaded (or failed) itself.
 */
export function reprojectTile(tile: ReprojTile): boolean {
  const sources = tile.sourceTiles_.filter((s) => s.tile && s.tile.getState() === LOADED);
  if (sources.some((s) => s.offset !== 0 || !isPixels(s.tile.getData()))) return false;
  if (sources.length === 0) {
    tile.sourceTiles_.length = 0;
    tile.state = ERROR;
    tile.changed();
    return true;
  }

  // The source tiles' data: pixel-interleaved bands, with `gutter` pixels around.
  const gutter = tile.gutter_;
  const first = sources[0].tile;
  const float = first.getData() instanceof Float32Array;
  const grid = tile.sourceTileGrid_;
  const firstExtent = grid.getTileCoordExtent(first.tileCoord);
  const firstSize = first.getSize();
  // Map units per source pixel, and the pixel lattice all tiles of this level share.
  const res = (firstExtent[2] - firstExtent[0]) / firstSize[0];
  const x0 = firstExtent[0];
  const y0 = firstExtent[3];
  const tiles = sources.map(({ tile: t }) => {
    const size = t.getSize();
    const w = size[0] + 2 * gutter;
    const h = size[1] + 2 * gutter;
    const raw = t.getData() as Pixels;
    const data = float ? new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4) : new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength);
    const bands = Math.floor(data.length / (w * h));
    const extent = grid.getTileCoordExtent(t.tileCoord);
    return {
      data,
      w,
      h,
      bands,
      // The tile's first pixel (inside the gutter) on the lattice.
      px: Math.round((extent[0] - x0) / res) - gutter,
      py: Math.round((y0 - extent[3]) / res) - gutter,
    };
  });
  const bandCount = tiles[0].bands;
  if (tiles.some((t) => t.bands !== bandCount || (t.data instanceof Float32Array) !== float)) return false;

  // The target tile.
  const z = tile.wrappedTileCoord_[0];
  const size = tile.targetTileGrid_.getTileSize(z);
  const targetWidth = typeof size === 'number' ? size : size[0];
  const targetHeight = typeof size === 'number' ? size : size[1];
  const ratio = tile.pixelRatio_;
  const outWidth = Math.round(targetWidth * ratio);
  const outHeight = Math.round(targetHeight * ratio);
  const targetResolution = tile.targetTileGrid_.getResolution(z);
  const targetExtent = tile.targetTileGrid_.getTileCoordExtent(tile.wrappedTileCoord_);
  const tx0 = targetExtent[0];
  const ty0 = targetExtent[3];

  const coverage = !tile.hasAlpha_;
  const outBands = coverage ? bandCount + 1 : bandCount;
  const opaque = float ? 1 : 255;

  // The source area the triangles reach, in lattice pixels, with one pixel around for the bilinear taps.
  const triangles = tile.triangulation_.getTriangles();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { source } of triangles) {
    for (const [sx, sy] of source) {
      const gx = (sx - x0) / res;
      const gy = (y0 - sy) / res;
      if (gx < minX) minX = gx;
      if (gx > maxX) maxX = gx;
      if (gy < minY) minY = gy;
      if (gy > maxY) maxY = gy;
    }
  }
  // Only where the image is: outside its extent the source tiles hold padding.
  const clip = tile.clipExtent_;
  let cx0 = -Infinity;
  let cy0 = -Infinity;
  let cx1 = Infinity;
  let cy1 = Infinity;
  if (clip) {
    cx0 = Math.round((clip[0] - x0) / res);
    cx1 = Math.round((clip[2] - x0) / res);
    cy0 = Math.round((y0 - clip[3]) / res);
    cy1 = Math.round((y0 - clip[1]) / res);
  }
  let ux0 = Infinity;
  let uy0 = Infinity;
  let ux1 = -Infinity;
  let uy1 = -Infinity;
  for (const t of tiles) {
    ux0 = Math.min(ux0, t.px + gutter);
    uy0 = Math.min(uy0, t.py + gutter);
    ux1 = Math.max(ux1, t.px + t.w - gutter);
    uy1 = Math.max(uy1, t.py + t.h - gutter);
  }
  const sx0 = Math.max(Math.floor(minX) - 1, ux0);
  const sy0 = Math.max(Math.floor(minY) - 1, uy0);
  const sx1 = Math.min(Math.ceil(maxX) + 1, ux1);
  const sy1 = Math.min(Math.ceil(maxY) + 1, uy1);
  const sw = sx1 - sx0;
  const sh = sy1 - sy0;
  if (!(sw > 0 && sh > 0) || sw * sh > 1 << 26) return false;

  // Stitch the source tiles into one buffer (`outBands` per pixel, the coverage band last).
  const stitchLength = sw * sh * outBands;
  let stitch: Pixels;
  if (float) {
    if (scratchFloat.length < stitchLength) scratchFloat = new Float32Array(stitchLength);
    stitch = scratchFloat;
  } else {
    if (scratchByte.length < stitchLength) scratchByte = new Uint8ClampedArray(stitchLength);
    stitch = scratchByte;
  }
  stitch.fill(0, 0, stitchLength);
  for (const t of tiles) {
    // Copy only the tile's own pixels (not its gutter), inside the image.
    const ax = Math.max(sx0, t.px + gutter, cx0);
    const bx = Math.min(sx1, t.px + t.w - gutter, cx1);
    const ay = Math.max(sy0, t.py + gutter, cy0);
    const by = Math.min(sy1, t.py + t.h - gutter, cy1);
    if (ax >= bx || ay >= by) continue;
    const src = t.data;
    for (let y = ay; y < by; y++) {
      let s = ((y - t.py) * t.w + (ax - t.px)) * bandCount;
      let d = ((y - sy0) * sw + (ax - sx0)) * outBands;
      if (!coverage) {
        stitch.set(src.subarray(s, s + (bx - ax) * bandCount), d);
        continue;
      }
      for (let x = ax; x < bx; x++) {
        for (let b = 0; b < bandCount; b++) stitch[d + b] = src[s + b];
        stitch[d + bandCount] = opaque;
        s += bandCount;
        d += outBands;
      }
    }
  }

  // Draw the triangles.
  const out: Pixels = float ? new Float32Array(outWidth * outHeight * outBands) : new Uint8ClampedArray(outWidth * outHeight * outBands);
  const pixels = outWidth * outHeight;
  if (scratchDone.length < pixels) scratchDone = new Uint8Array(pixels);
  const done = scratchDone;
  done.fill(0, 0, pixels);
  const linear = tile.interpolate;
  // The source tiles' area, in stitch pixels.
  const bx0 = ux0 - sx0;
  const bx1 = ux1 - sx0;
  const by0 = uy0 - sy0;
  const by1 = uy1 - sy0;
  const tScale = ratio / targetResolution;
  for (const { source, target } of triangles) {
    // Target pixel coordinates of the corners, and their source (stitch) pixel coordinates.
    const u0 = (target[0][0] - tx0) * tScale;
    const v0 = (ty0 - target[0][1]) * tScale;
    const u1 = (target[1][0] - tx0) * tScale;
    const v1 = (ty0 - target[1][1]) * tScale;
    const u2 = (target[2][0] - tx0) * tScale;
    const v2 = (ty0 - target[2][1]) * tScale;
    const s0 = (source[0][0] - x0) / res - sx0;
    const t0 = (y0 - source[0][1]) / res - sy0;
    const s1 = (source[1][0] - x0) / res - sx0;
    const t1 = (y0 - source[1][1]) / res - sy0;
    const s2 = (source[2][0] - x0) / res - sx0;
    const t2 = (y0 - source[2][1]) / res - sy0;
    const det = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
    if (det === 0) continue;
    // Affine map from target pixel to source pixel: s = a*u + b*v + c, t = d*u + e*v + f.
    const a = ((s1 - s0) * (v2 - v0) - (s2 - s0) * (v1 - v0)) / det;
    const b = ((s2 - s0) * (u1 - u0) - (s1 - s0) * (u2 - u0)) / det;
    const c = s0 - a * u0 - b * v0;
    const d = ((t1 - t0) * (v2 - v0) - (t2 - t0) * (v1 - v0)) / det;
    const e = ((t2 - t0) * (u1 - u0) - (t1 - t0) * (u2 - u0)) / det;
    const f = t0 - d * u0 - e * v0;
    const sign = det > 0 ? 1 : -1;
    // A little slack, so pixels on an edge two triangles share are not lost to rounding.
    const eps = -1e-7 * Math.abs(det);
    const ya = Math.max(0, Math.floor(Math.min(v0, v1, v2)));
    const yb = Math.min(outHeight - 1, Math.ceil(Math.max(v0, v1, v2)));
    // Each edge function is linear along a row: k * pu + m(pv), inside where it is >= eps.
    const edges = [
      [u1, v1, u2, v2],
      [u2, v2, u0, v0],
      [u0, v0, u1, v1],
    ];
    for (let y = ya; y <= yb; y++) {
      const pv = y + 0.5;
      // The pixel centers of this row inside the triangle: [lo, hi].
      let lo = 0;
      let hi = outWidth - 1;
      for (const [pa, qa, pb, qb] of edges) {
        // sign * ((pa - pu) * (qb - pv) - (pb - pu) * (qa - pv)) = k * pu + m
        const k = sign * (qa - qb);
        const m = sign * (pa * (qb - pv) - pb * (qa - pv));
        if (k === 0) {
          if (m < eps) hi = -1;
        } else if (k > 0) {
          lo = Math.max(lo, Math.ceil((eps - m) / k - 0.5));
        } else {
          hi = Math.min(hi, Math.floor((eps - m) / k - 0.5));
        }
      }
      let sx = a * (lo + 0.5) + b * pv + c;
      let sy = d * (lo + 0.5) + e * pv + f;
      for (let x = lo; x <= hi; x++, sx += a, sy += d) {
        const index = y * outWidth + x;
        if (done[index]) continue;
        // Nothing where the source tiles end (the GPU discards these too).
        if (sx < bx0 || sx > bx1 || sy < by0 || sy > by1) continue;
        done[index] = 1;
        const o = index * outBands;
        if (linear) {
          // Texel centers are at +0.5; clamp to the edge like CLAMP_TO_EDGE.
          let fx = sx - 0.5;
          let fy = sy - 0.5;
          if (fx < 0) fx = 0;
          else if (fx > sw - 1) fx = sw - 1;
          if (fy < 0) fy = 0;
          else if (fy > sh - 1) fy = sh - 1;
          const ix = Math.floor(fx);
          const iy = Math.floor(fy);
          const ix1 = ix + 1 < sw ? ix + 1 : ix;
          const iy1 = iy + 1 < sh ? iy + 1 : iy;
          const ax = fx - ix;
          const ay = fy - iy;
          const p00 = (iy * sw + ix) * outBands;
          const p10 = (iy * sw + ix1) * outBands;
          const p01 = (iy1 * sw + ix) * outBands;
          const p11 = (iy1 * sw + ix1) * outBands;
          const w00 = (1 - ax) * (1 - ay);
          const w10 = ax * (1 - ay);
          const w01 = (1 - ax) * ay;
          const w11 = ax * ay;
          for (let k = 0; k < outBands; k++) {
            out[o + k] = stitch[p00 + k] * w00 + stitch[p10 + k] * w10 + stitch[p01 + k] * w01 + stitch[p11 + k] * w11;
          }
        } else {
          let ix = Math.floor(sx);
          let iy = Math.floor(sy);
          if (ix < 0) ix = 0;
          else if (ix > sw - 1) ix = sw - 1;
          if (iy < 0) iy = 0;
          else if (iy > sh - 1) iy = sh - 1;
          const p = (iy * sw + ix) * outBands;
          for (let k = 0; k < outBands; k++) out[o + k] = stitch[p + k];
        }
      }
    }
  }

  tile.sourceTiles_.length = 0;
  tile.reprojData_ = out;
  tile.reprojSize_ = [outWidth, outHeight];
  tile.state = LOADED;
  tile.changed();
  return true;
}

function isPixels(data: unknown): data is Pixels {
  return data instanceof Float32Array || data instanceof Uint8Array || data instanceof Uint8ClampedArray;
}
