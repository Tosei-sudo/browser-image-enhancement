/**
 * Contour lines of an elevation grid (marching squares), traced over a window
 * of the grid at a stride, so a view only traces about as many posts as it
 * has pixels.
 */
import { DTED_VOID, type Dted } from './dted.js';

/** Elevation posts on a regular longitude / latitude grid, north up. */
export interface ElevationGrid {
  /** Posts across. */
  width: number;
  /** Posts down. */
  height: number;
  /** Elevations, row by row from north to south. */
  data: ArrayLike<number>;
  /** Value of posts with no data (NaN always counts as no data). */
  noData: number | null;
  /** Longitude of the westernmost posts, degrees. */
  west: number;
  /** Latitude of the northernmost posts, degrees. */
  north: number;
  /** Spacing between posts, degrees. */
  spacing: [lon: number, lat: number];
}

/** What part of the grid to trace, and how. */
export interface ContourRequest {
  /** Posts `[x0, y0, x1, y1]` (inclusive) to trace within. */
  window: [number, number, number, number];
  /** Every `stride`-th post is used (1: all of them). */
  stride: number;
  /** Elevation between lines. */
  interval: number;
  /** Stop after about this many points (default: 2,000,000). */
  maxPoints?: number;
}

/** One contour line. */
export interface ContourLine {
  /** Its elevation. */
  level: number;
  /** Longitude, latitude pairs. */
  coordinates: Float64Array;
}

export interface ContourResult {
  lines: ContourLine[];
  /** Whether tracing stopped at `maxPoints` (the interval is too fine for the view). */
  truncated: boolean;
}

/** A DTED cell as an elevation grid. */
export function gridOfDted(cell: Dted): ElevationGrid {
  const [dLon, dLat] = cell.spacing;
  return {
    width: cell.width,
    height: cell.height,
    data: cell.data,
    noData: DTED_VOID,
    west: cell.west,
    north: cell.south + (cell.height - 1) * dLat,
    spacing: [dLon, dLat],
  };
}

/** A round interval (1, 2 or 5 × 10ⁿ m, at least 1 m) giving about `lines` lines over `[min, max]`. */
export function niceInterval(min: number, max: number, lines = 20): number {
  const raw = Math.max((max - min) / lines, 1);
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5]) if (m * p >= raw) return m * p;
  return 10 * p;
}

/** Whether lines at `level` are index contours (every 5th line, labelled). */
export function isIndexContour(level: number, interval: number): boolean {
  const k = Math.round(level / interval);
  return k % 5 === 0;
}

/*
 * Marching squares: corners top-left 8, top-right 4, bottom-right 2,
 * bottom-left 1 (set when at or above the level) give the case, and each case
 * joins two of the cell's edges (top, right, bottom, left). The saddles (5 and
 * 10) are decided by the cell's center.
 */

/** A line being joined, as the edges it crosses: `front` reversed, then `back`. */
interface Chain {
  front: number[];
  back: number[];
  /** Edge at the start and at the end. */
  a: number;
  b: number;
  dead: boolean;
}

/** Traces the contour lines of `grid` within a window. */
export function traceContours(grid: ElevationGrid, request: ContourRequest): ContourResult {
  const { width, data, noData } = grid;
  const { stride, interval } = request;
  const maxPoints = request.maxPoints ?? 2_000_000;
  const x0 = Math.max(0, request.window[0]);
  const y0 = Math.max(0, request.window[1]);
  const x1 = Math.min(grid.width - 1, request.window[2]);
  const y1 = Math.min(grid.height - 1, request.window[3]);
  const nx = Math.floor((x1 - x0) / stride) + 1;
  const ny = Math.floor((y1 - y0) / stride) + 1;
  if (!(interval > 0) || nx < 2 || ny < 2) return { lines: [], truncated: false };

  // The posts used, with no data as NaN.
  const v = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const row = (y0 + j * stride) * width + x0;
    for (let i = 0; i < nx; i++) {
      const value = data[row + i * stride];
      v[j * nx + i] = value === noData ? NaN : value;
    }
  }

  // Edges: horizontal ones (between (i, j) and (i + 1, j)) are j·nx + i,
  // vertical ones (between (i, j) and (i, j + 1)) are nx·ny + j·nx + i.
  const vertical = nx * ny;
  // Open line ends by level (index from the lowest level of the window), each a
  // map from edge to the line ending there.
  let lo = Infinity;
  for (let k = 0; k < v.length; k++) if (v[k] < lo) lo = v[k];
  const kBase = Math.floor(lo / interval) + 1;
  const chains: Array<Map<number, Chain> | undefined> = [];
  const all: Array<{ level: number; chain: Chain }> = [];
  let points = 0;
  let truncated = false;

  const add = (k: number, e1: number, e2: number) => {
    let ends = chains[k - kBase];
    if (!ends) chains[k - kBase] = ends = new Map();
    const c1 = ends.get(e1);
    const c2 = ends.get(e2);
    points++;
    if (!c1 && !c2) {
      const chain: Chain = { front: [], back: [e1, e2], a: e1, b: e2, dead: false };
      ends.set(e1, chain);
      ends.set(e2, chain);
      all.push({ level: k * interval, chain });
      points++;
    } else if (c1 && !c2) {
      extend(c1, e1, e2);
      ends.delete(e1);
      ends.set(e2, c1);
    } else if (c2 && !c1) {
      extend(c2, e2, e1);
      ends.delete(e2);
      ends.set(e1, c2);
    } else if (c1 === c2) {
      // Closes a ring.
      extend(c1!, e1, e2);
      ends.delete(e1);
      ends.delete(e2);
    } else {
      // Joins two lines: c1 ends at e1, c2 starts at e2.
      ends.delete(e1);
      ends.delete(e2);
      const first = c1!;
      const second = c2!;
      if (first.b !== e1) reverse(first);
      if (second.a !== e2) reverse(second);
      // The shorter one is copied onto the longer one.
      if (first.front.length + first.back.length >= second.front.length + second.back.length) {
        for (let k = second.front.length - 1; k >= 0; k--) first.back.push(second.front[k]);
        for (const e of second.back) first.back.push(e);
        first.b = second.b;
        second.dead = true;
        ends.set(first.b, first);
      } else {
        for (let k = first.back.length - 1; k >= 0; k--) second.front.push(first.back[k]);
        for (const e of first.front) second.front.push(e);
        second.a = first.a;
        first.dead = true;
        ends.set(second.a, second);
      }
    }
  };

  outer: for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const tl = v[j * nx + i];
      const tr = v[j * nx + i + 1];
      const br = v[(j + 1) * nx + i + 1];
      const bl = v[(j + 1) * nx + i];
      // A cell with any post missing has no lines (NaN fails both comparisons).
      const min = tl < tr ? (bl < br ? (tl < bl ? tl : bl) : tl < br ? tl : br) : bl < br ? (tr < bl ? tr : bl) : tr < br ? tr : br;
      const max = tl > tr ? (bl > br ? (tl > bl ? tl : bl) : tl > br ? tl : br) : bl > br ? (tr > bl ? tr : bl) : tr > br ? tr : br;
      if (!(min < max) || tl !== tl || tr !== tr || br !== br || bl !== bl) continue;
      const k0 = Math.floor(min / interval) + 1;
      const last = Math.floor(max / interval);
      if (k0 > last) continue;
      // Edges: top, right, bottom, left.
      const eT = j * nx + i;
      const eR = vertical + j * nx + i + 1;
      const eB = (j + 1) * nx + i;
      const eL = vertical + j * nx + i;
      for (let k = k0; k <= last; k++) {
        const level = k * interval;
        const index = (tl >= level ? 8 : 0) | (tr >= level ? 4 : 0) | (br >= level ? 2 : 0) | (bl >= level ? 1 : 0);
        switch (index) {
          case 1: case 14: add(k, eL, eB); break;
          case 2: case 13: add(k, eB, eR); break;
          case 3: case 12: add(k, eL, eR); break;
          case 4: case 11: add(k, eT, eR); break;
          case 6: case 9: add(k, eT, eB); break;
          case 7: case 8: add(k, eL, eT); break;
          case 5: case 10: {
            const center = (tl + tr + br + bl) / 4 >= level;
            // Inside corners joined through the center: the lines cut off the outside corners.
            if ((index === 5) === center) {
              add(k, eL, eT);
              add(k, eB, eR);
            } else {
              add(k, eT, eR);
              add(k, eL, eB);
            }
          }
        }
        if (points > maxPoints) {
          truncated = true;
          break outer;
        }
      }
    }
  }

  // Where each edge crosses its level, in degrees.
  const [dLon, dLat] = grid.spacing;
  const lonOf = (gx: number) => grid.west + (x0 + gx * stride) * dLon;
  const latOf = (gy: number) => grid.north - (y0 + gy * stride) * dLat;
  const lines: ContourLine[] = [];
  for (const { level, chain } of all) {
    if (chain.dead) continue;
    const n = chain.front.length + chain.back.length;
    const coordinates = new Float64Array(n * 2);
    let o = 0;
    const put = (e: number) => {
      let gx: number;
      let gy: number;
      if (e < vertical) {
        const i = e % nx;
        gy = (e - i) / nx;
        const a = v[e];
        const t = (level - a) / (v[e + 1] - a);
        gx = i + t;
      } else {
        const f = e - vertical;
        const i = f % nx;
        const jj = (f - i) / nx;
        const a = v[f];
        const t = (level - a) / (v[f + nx] - a);
        gx = i;
        gy = jj + t;
      }
      coordinates[o++] = lonOf(gx);
      coordinates[o++] = latOf(gy);
    };
    for (let k = chain.front.length - 1; k >= 0; k--) put(chain.front[k]);
    for (const e of chain.back) put(e);
    lines.push({ level, coordinates });
  }
  return { lines, truncated };
}

/** Adds edge `next` at the end of `chain` that is edge `at`. */
function extend(chain: Chain, at: number, next: number): void {
  if (chain.b === at) {
    chain.back.push(next);
    chain.b = next;
  } else {
    chain.front.push(next);
    chain.a = next;
  }
}

function reverse(chain: Chain): void {
  [chain.front, chain.back] = [chain.back, chain.front];
  [chain.a, chain.b] = [chain.b, chain.a];
}
