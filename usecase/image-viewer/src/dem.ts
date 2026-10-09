/**
 * Elevation data: DTED cells opened in the viewer, sampled anywhere they
 * cover, and EGM96 geoid heights to turn their heights above mean sea level
 * into the heights above the WGS 84 ellipsoid that RPC models use.
 */
import { DTED_VOID, type Dted } from './dted.js';

/**
 * Height above mean sea level at `lon`, `lat` from the first cell that covers
 * it (bilinear between posts, voids left out), or null where no cell does.
 */
export function elevationAt(cells: readonly Dted[], lon: number, lat: number): number | null {
  for (const cell of cells) {
    const { west, south, width, height, data } = cell;
    const [dLon, dLat] = cell.spacing;
    const fx = (lon - west) / dLon;
    const fy = (south + (height - 1) * dLat - lat) / dLat; // rows run north to south
    if (!(fx >= 0 && fy >= 0 && fx <= width - 1 && fy <= height - 1)) continue;
    const i = Math.min(Math.floor(fx), width - 2);
    const j = Math.min(Math.floor(fy), height - 2);
    const tx = fx - i;
    const ty = fy - j;
    let sum = 0;
    let weight = 0;
    const add = (x: number, y: number, w: number) => {
      const v = data[y * width + x];
      if (v === DTED_VOID || w === 0) return;
      sum += v * w;
      weight += w;
    };
    add(i, j, (1 - tx) * (1 - ty));
    add(i + 1, j, tx * (1 - ty));
    add(i, j + 1, (1 - tx) * ty);
    add(i + 1, j + 1, tx * ty);
    if (weight > 0) return sum / weight;
  }
  return null;
}

/** Whether any cell covers part of `[west, south, east, north]` (degrees). */
export function coversAny(cells: readonly Dted[], [west, south, east, north]: readonly number[]): boolean {
  return cells.some((c) => {
    const e = c.west + (c.width - 1) * c.spacing[0];
    const n = c.south + (c.height - 1) * c.spacing[1];
    return c.west < east && e > west && c.south < north && n > south;
  });
}

/** The EGM96 geoid on a 0.5° grid: 361 rows from 90°N to 90°S, 720 columns from 180°W, in decimetres. */
export type GeoidGrid = Int16Array;

const GEOID_STEP = 0.5;
const GEOID_COLUMNS = 360 / GEOID_STEP;
const GEOID_ROWS = 180 / GEOID_STEP + 1;

let geoid: Promise<GeoidGrid> | null = null;

/** The EGM96 geoid grid (fetched once, from the site). */
export function loadGeoid(): Promise<GeoidGrid> {
  geoid ??= fetch(new URL('./egm96.bin', import.meta.url))
    .then((r) => {
      if (!r.ok) throw new Error('ジオイドのデータを読み込めませんでした');
      return r.arrayBuffer();
    })
    .then((b) => new Int16Array(b))
    .catch((error) => {
      geoid = null;
      throw error;
    });
  return geoid;
}

/** Height of the EGM96 geoid above the WGS 84 ellipsoid in metres (bilinear on the 0.5° grid: within about 0.1 m, rarely 3 m). */
export function geoidHeight(grid: GeoidGrid, lon: number, lat: number): number {
  const x = ((((lon + 180) % 360) + 360) % 360) / GEOID_STEP;
  const y = Math.min(180, Math.max(0, 90 - lat)) / GEOID_STEP;
  const i = Math.floor(x);
  const j = Math.min(Math.floor(y), GEOID_ROWS - 2);
  const tx = x - i;
  const ty = y - j;
  const g = (c: number, r: number) => grid[r * GEOID_COLUMNS + (c % GEOID_COLUMNS)] / 10;
  return (g(i, j) * (1 - tx) + g(i + 1, j) * tx) * (1 - ty) + (g(i, j + 1) * (1 - tx) + g(i + 1, j + 1) * tx) * ty;
}

/** Lowest and highest elevation of a cell (voids left out), or null when it is all void. */
export function elevationRange(cell: Dted): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (const v of cell.data) {
    if (v === DTED_VOID) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min <= max ? [min, max] : null;
}
