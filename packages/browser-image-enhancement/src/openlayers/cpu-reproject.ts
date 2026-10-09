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
 * The triangles are drawn in the library's workers (the source tiles are
 * stitched here, a copy of rows, and the result comes back as the tile's
 * data), so panning a reprojected image keeps the main thread free; without
 * workers they are drawn here.
 *
 * Tiles it cannot handle (images instead of arrays, wrapping across the
 * date line) keep OpenLayers' own reprojection.
 */
import type DataTileSource from 'ol/source/DataTile.js';
import type TileGrid from 'ol/tilegrid/TileGrid.js';
import type { Extent } from 'ol/extent.js';
import { drawTriangles, type Pixels, type ReprojectJob } from './reproject-kernel.js';
import { drawInWorker } from './reproject-worker.js';

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
          done = reprojectInWorker(tile);
        } catch {
          done = false;
        }
        if (!done) gpu.call(tile);
      };
    }
    return tile;
  };
}

/** Scratch buffer for stitching on this thread, kept between tiles. */
let scratchFloat = new Float32Array(0);
let scratchByte = new Uint8ClampedArray(0);

/**
 * Reprojects `tile` from its loaded source tiles on this thread; false when
 * it cannot (the caller then lets OpenLayers do it). Sets the tile loaded
 * (or failed) itself.
 */
export function reprojectTile(tile: ReprojTile): boolean {
  const job = prepare(tile, false);
  if (job === null) return false;
  if (job !== 'error') finish(tile, job, drawTriangles(job));
  return true;
}

/**
 * Reprojects `tile` in a worker: the source tiles are stitched here (a copy
 * of rows) and the triangles drawn in the worker, off the main thread. Falls
 * back to this thread when no worker can run. False when the tile is not one
 * this can reproject.
 */
function reprojectInWorker(tile: ReprojTile): boolean {
  const job = prepare(tile, true);
  if (job === null) return false;
  if (job === 'error') return true;
  void drawInWorker(job).then(
    (out) => finish(tile, job, out ?? drawTriangles(job)),
    () => finish(tile, job, drawTriangles(job)),
  );
  return true;
}

/**
 * The work to reproject `tile`: its source tiles stitched into one buffer
 * (a buffer of its own with `own`, else a scratch one) and its triangles in
 * pixels. Null when it cannot; 'error' when it had no source tile (it is
 * then marked failed).
 */
function prepare(tile: ReprojTile, own: boolean): ReprojectJob | 'error' | null {
  const sources = tile.sourceTiles_.filter((s) => s.tile && s.tile.getState() === LOADED);
  if (sources.some((s) => s.offset !== 0 || !isPixels(s.tile.getData()))) return null;
  if (sources.length === 0) {
    tile.sourceTiles_.length = 0;
    tile.state = ERROR;
    tile.changed();
    return 'error';
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
  if (tiles.some((t) => t.bands !== bandCount || (t.data instanceof Float32Array) !== float)) return null;

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
  if (!(sw > 0 && sh > 0) || sw * sh > 1 << 26) return null;

  // Stitch the source tiles into one buffer (`outBands` per pixel, the coverage band last).
  const stitchLength = sw * sh * outBands;
  let stitch: Pixels;
  if (own) {
    stitch = float ? new Float32Array(stitchLength) : new Uint8ClampedArray(stitchLength);
  } else if (float) {
    if (scratchFloat.length < stitchLength) scratchFloat = new Float32Array(stitchLength);
    stitch = scratchFloat;
  } else {
    if (scratchByte.length < stitchLength) scratchByte = new Uint8ClampedArray(stitchLength);
    stitch = scratchByte;
  }
  if (!own) stitch.fill(0, 0, stitchLength);
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

  // The triangles, as target pixel corners and their source (stitch) pixel coordinates.
  const tScale = ratio / targetResolution;
  const corners = new Float64Array(triangles.length * 12);
  triangles.forEach(({ source, target }, i) => {
    const o = i * 12;
    for (let k = 0; k < 3; k++) {
      corners[o + k * 2] = (target[k][0] - tx0) * tScale;
      corners[o + k * 2 + 1] = (ty0 - target[k][1]) * tScale;
      corners[o + 6 + k * 2] = (source[k][0] - x0) / res - sx0;
      corners[o + 7 + k * 2] = (y0 - source[k][1]) / res - sy0;
    }
  });
  return {
    stitch,
    sw,
    sh,
    bands: outBands,
    width: outWidth,
    height: outHeight,
    corners,
    // The source tiles' area, in stitch pixels.
    bounds: [ux0 - sx0, ux1 - sx0, uy0 - sy0, uy1 - sy0],
    linear: tile.interpolate,
  };
}

/** Sets the reprojected pixels on `tile` and marks it loaded. */
function finish(tile: ReprojTile, job: ReprojectJob, out: Pixels): void {
  tile.sourceTiles_.length = 0;
  tile.reprojData_ = out;
  tile.reprojSize_ = [job.width, job.height];
  tile.state = LOADED;
  tile.changed();
}

function isPixels(data: unknown): data is Pixels {
  return data instanceof Float32Array || data instanceof Uint8Array || data instanceof Uint8ClampedArray;
}
