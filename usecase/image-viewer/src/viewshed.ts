/**
 * Viewshed (可視解析): which ground around an observer can be seen from it,
 * over the elevation data that is open (DTED).
 *
 * Every cell is tested on its own line of sight (the exact "R3" method, not
 * an approximation that reuses neighbouring rays): the terrain is sampled
 * (bilinear) at every cell the line crosses, and the cell is visible when no
 * sample rises above the line. Distances are on the WGS 84 ellipsoid around
 * the observer (meridian and prime vertical radii of curvature), and the
 * Earth's curvature lowers far terrain by d² / 2R, less the atmospheric
 * refraction (coefficient k, 0.13 by default): (1 − k) · d² / 2R.
 */
import type { Dted } from './dted.js';
import { elevationAt } from './dem.js';

/** WGS 84 semi-major axis and first eccentricity squared. */
const A = 6378137;
const E2 = 6.69437999014e-3;

/** Heights for a viewshed: a longitude / latitude grid, rows north to south; NaN where there is no data. */
export interface ViewshedGrid {
  /** Longitude and latitude of the centre of the top-left cell. */
  west: number;
  north: number;
  /** Cell size in degrees. */
  dLon: number;
  dLat: number;
  width: number;
  height: number;
  heights: Float32Array;
}

export interface ViewshedOptions {
  /** The observer, in degrees. */
  lon: number;
  lat: number;
  /** Height of the eye above the ground, metres. */
  observerHeight: number;
  /** Height above the ground of what is looked for, metres (0: the ground itself). */
  targetHeight: number;
  /** How far to look, metres. */
  radius: number;
  /** Refraction coefficient (0: none; 0.13: the usual for visible light). */
  refraction: number;
}

/** What {@link viewshed} gives each cell. */
export const VISIBLE = 1;
export const HIDDEN = 0;
export const OUTSIDE = 255;

/** Metres per degree of longitude and latitude at `lat`, and the mean radius of curvature there. */
export function metresPerDegree(lat: number): { x: number; y: number; radius: number } {
  const phi = (lat * Math.PI) / 180;
  const s = Math.sin(phi);
  const w = Math.sqrt(1 - E2 * s * s);
  const n = A / w; // prime vertical
  const m = (A * (1 - E2)) / (w * w * w); // meridian
  return { x: (n * Math.cos(phi) * Math.PI) / 180, y: (m * Math.PI) / 180, radius: Math.sqrt(m * n) };
}

/**
 * The elevation data around the observer on one grid at the data's own post
 * spacing (or coarser, so it has at most `maxCells` cells), the observer at
 * the centre of the middle cell.
 */
export function gridAround(cells: readonly Dted[], { lon, lat, radius }: Pick<ViewshedOptions, 'lon' | 'lat' | 'radius'>, maxCells = 4_000_000): ViewshedGrid {
  const here = cells.filter((c) => lon >= c.west && lon <= c.west + (c.width - 1) * c.spacing[0] && lat >= c.south && lat <= c.south + (c.height - 1) * c.spacing[1]);
  if (!here.length) throw new Error('観測点に標高データがありません');
  let dLon = Math.min(...here.map((c) => c.spacing[0]));
  let dLat = Math.min(...here.map((c) => c.spacing[1]));
  const m = metresPerDegree(lat);
  const half = () => [Math.ceil(radius / (dLon * m.x)), Math.ceil(radius / (dLat * m.y))];
  let [hx, hy] = half();
  const scale = Math.sqrt(((2 * hx + 1) * (2 * hy + 1)) / maxCells);
  if (scale > 1) {
    dLon *= scale;
    dLat *= scale;
    [hx, hy] = half();
  }
  const width = 2 * hx + 1;
  const height = 2 * hy + 1;
  const west = lon - hx * dLon;
  const north = lat + hy * dLat;
  const heights = new Float32Array(width * height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) heights[r * width + c] = elevationAt(cells, west + c * dLon, north - r * dLat) ?? NaN;
  }
  return { west, north, dLon, dLat, width, height, heights };
}

/**
 * Visibility of the rows `[rowStart, rowEnd)` of `grid` from the observer:
 * {@link VISIBLE}, {@link HIDDEN}, or {@link OUTSIDE} (beyond the radius or
 * without data). One byte a cell, the rows' cells in order.
 */
export function viewshed(grid: ViewshedGrid, options: ViewshedOptions, rowStart = 0, rowEnd = grid.height): Uint8Array {
  const { west, north, dLon, dLat, width, height, heights } = grid;
  const m = metresPerDegree(options.lat);
  const sx = dLon * m.x; // metres per cell
  const sy = dLat * m.y;
  const drop = (1 - options.refraction) / (2 * m.radius);
  const ox = (options.lon - west) / dLon;
  const oy = (north - options.lat) / dLat;
  const at = (x: number, y: number): number => {
    const i = Math.min(Math.max(Math.floor(x), 0), width - 2);
    const j = Math.min(Math.max(Math.floor(y), 0), height - 2);
    const tx = x - i;
    const ty = y - j;
    const k = j * width + i;
    return (heights[k] * (1 - tx) + heights[k + 1] * tx) * (1 - ty) + (heights[k + width] * (1 - tx) + heights[k + width + 1] * tx) * ty;
  };
  const ground = at(ox, oy);
  if (Number.isNaN(ground)) throw new Error('観測点に標高データがありません');
  const eye = ground + options.observerHeight;
  const r2 = options.radius * options.radius;
  const out = new Uint8Array((rowEnd - rowStart) * width).fill(OUTSIDE);
  for (let row = rowStart; row < rowEnd; row++) {
    for (let col = 0; col < width; col++) {
      const dx = (col - ox) * sx;
      const dy = (row - oy) * sy;
      const d2 = dx * dx + dy * dy;
      const o = (row - rowStart) * width + col;
      const h = heights[row * width + col];
      if (d2 > r2 || Number.isNaN(h)) continue;
      const d = Math.sqrt(d2);
      if (d < 1e-6) {
        out[o] = VISIBLE;
        continue;
      }
      const target = (h + options.targetHeight - drop * d2 - eye) / d;
      // One sample per cell crossed, the target's own cell left out.
      const steps = Math.ceil(Math.max(Math.abs(col - ox), Math.abs(row - oy)));
      let visible = true;
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const z = at(ox + (col - ox) * t, oy + (row - oy) * t);
        if (Number.isNaN(z)) continue;
        const ds = d * t;
        if ((z - drop * ds * ds - eye) / ds > target) {
          visible = false;
          break;
        }
      }
      out[o] = visible ? VISIBLE : HIDDEN;
    }
  }
  return out;
}

/** Visible area in square metres (each cell's area on the ellipsoid at its latitude). */
export function visibleArea(grid: ViewshedGrid, result: Uint8Array): number {
  let area = 0;
  for (let r = 0; r < grid.height; r++) {
    const m = metresPerDegree(grid.north - r * grid.dLat);
    const cell = grid.dLon * m.x * grid.dLat * m.y;
    for (let c = 0; c < grid.width; c++) if (result[r * grid.width + c] === VISIBLE) area += cell;
  }
  return area;
}

/**
 * {@link viewshed} of the whole grid on several workers at once (bands of
 * rows), calling `onProgress` with the share done.
 */
export async function runViewshed(grid: ViewshedGrid, options: ViewshedOptions, onProgress?: (done: number) => void): Promise<Uint8Array> {
  const count = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1));
  // Small bands, handed out as workers free up: rows near the observer are quicker than far ones.
  const band = Math.max(1, Math.ceil(grid.height / (count * 8)));
  const result = new Uint8Array(grid.width * grid.height);
  let next = 0;
  let done = 0;
  const workers = Array.from({ length: count }, () => new Worker(new URL('./viewshed-worker.ts', import.meta.url), { type: 'module' }));
  try {
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((resolve, reject) => {
            const send = () => {
              if (next >= grid.height) return resolve();
              const rowStart = next;
              next = Math.min(grid.height, next + band);
              worker.postMessage({ options, rowStart, rowEnd: next });
            };
            worker.onmessage = (e: MessageEvent<{ ok: true; rowStart: number; result: Uint8Array } | { ok: false; message: string }>) => {
              if (!e.data.ok) return reject(new Error(e.data.message));
              result.set(e.data.result, e.data.rowStart * grid.width);
              done += e.data.result.length / grid.width;
              onProgress?.(done / grid.height);
              send();
            };
            worker.onerror = (e) => reject(new Error(e.message || '可視解析のワーカーが止まりました'));
            worker.postMessage({ grid });
            send();
          }),
      ),
    );
  } finally {
    for (const w of workers) w.terminate();
  }
  return result;
}

/** RGBA pixels of a result: visible green, hidden red, outside clear. */
export function viewshedPixels(result: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const rgba = new Uint8ClampedArray(result.length * 4);
  for (let i = 0; i < result.length; i++) {
    const v = result[i];
    if (v === VISIBLE) rgba.set([20, 200, 80, 120], i * 4);
    else if (v === HIDDEN) rgba.set([220, 40, 40, 90], i * 4);
  }
  return rgba;
}
