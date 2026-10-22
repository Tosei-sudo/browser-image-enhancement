/**
 * A revisit map for the imaging plan: the area is cut into a grid of cells,
 * each cell's middle is planned as a point, and each cell is coloured by how
 * long it waits at most between two chances (how soon the chosen satellites
 * can answer a request there), with how often they come.
 */
import type { Opportunity, PlanTarget } from './imaging-plan.js';

/** One cell of the grid: its corners (lon, lat) and middle. */
export interface RevisitCell {
  ring: Array<[number, number]>;
  center: [number, number];
}

/** How often a cell is seen in the period. */
export interface RevisitStats {
  /** Chances in the period (several satellites over it within a minute count once). */
  count: number;
  /** The mean time between two chances, hours; null with fewer than two. */
  meanGap: number | null;
  /** The longest wait, from the start, between chances or until the end, hours. */
  maxGap: number;
}

/** The most cells a side. */
export const MAX_GRID = 30;

/** The box (west, south, east, north) around the targets, at least `min` degrees a side. */
export function boxOf(targets: readonly PlanTarget[], min = 0.5): [number, number, number, number] {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const t of targets) {
    for (const [x, y] of t.points.length ? t.points : [t.center]) {
      w = Math.min(w, x);
      e = Math.max(e, x);
      s = Math.min(s, y);
      n = Math.max(n, y);
    }
  }
  const grow = (lo: number, hi: number): [number, number] => (hi - lo >= min ? [lo, hi] : [(lo + hi) / 2 - min / 2, (lo + hi) / 2 + min / 2]);
  [w, e] = grow(w, e);
  [s, n] = grow(s, n);
  return [w, Math.max(-89, s), e, Math.min(89, n)];
}

/** The box cut into `n` × `n` cells (rows from the north). */
export function gridCells([w, s, e, n]: [number, number, number, number], size: number): RevisitCell[] {
  const k = Math.max(1, Math.min(MAX_GRID, Math.round(size)));
  const [dx, dy] = [(e - w) / k, (n - s) / k];
  const cells: RevisitCell[] = [];
  for (let j = 0; j < k; j++) {
    for (let i = 0; i < k; i++) {
      const [x0, y1] = [w + i * dx, n - j * dy];
      const [x1, y0] = [x0 + dx, y1 - dy];
      cells.push({ ring: [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], center: [(x0 + x1) / 2, (y0 + y1) / 2] });
    }
  }
  return cells;
}

/** The cells as point targets to plan for. */
export const cellTargets = (cells: readonly RevisitCell[]): PlanTarget[] => cells.map((c, i) => ({ label: `セル ${i + 1}`, center: c.center, points: [] }));

/** How often each of `cells` is seen, from the opportunities planned for {@link cellTargets} between `start` and `end`. */
export function revisitStats(ops: readonly Opportunity[], cells: number, start: number, end: number): RevisitStats[] {
  const times: number[][] = Array.from({ length: cells }, () => []);
  for (const op of ops) times[op.target]?.push(op.time);
  const hour = 3600000;
  return times.map((list) => {
    list.sort((a, b) => a - b);
    const distinct = list.filter((t, i) => i === 0 || t - list[i - 1] > 60000);
    const edges = [start, ...distinct, end];
    let maxGap = 0;
    for (let i = 1; i < edges.length; i++) maxGap = Math.max(maxGap, edges[i] - edges[i - 1]);
    const n = distinct.length;
    return { count: n, meanGap: n >= 2 ? (distinct[n - 1] - distinct[0]) / (n - 1) / hour : null, maxGap: maxGap / hour };
  });
}

/** Colours (r, g, b) from short waits (green) through yellow to long ones (red); grey for a cell never seen. */
export function revisitColor(stats: RevisitStats, longest: number): [number, number, number] {
  if (!stats.count) return [148, 163, 184];
  const f = longest > 0 ? Math.max(0, Math.min(1, stats.maxGap / longest)) : 0;
  const stops: Array<[number, number, number]> = [
    [22, 163, 74],
    [234, 179, 8],
    [220, 38, 38],
  ];
  const x = f * 2;
  const [a, b] = x <= 1 ? [stops[0], stops[1]] : [stops[1], stops[2]];
  const t = x <= 1 ? x : x - 1;
  return a.map((v, i) => Math.round(v + (b[i] - v) * t)) as [number, number, number];
}

/** Hours as days and hours (「2 日 5 時間」). */
export function hoursText(hours: number | null): string {
  if (hours === null) return '—';
  if (hours < 24) return `${hours < 10 ? Math.round(hours * 10) / 10 : Math.round(hours)} 時間`;
  const d = Math.floor(hours / 24);
  const h = Math.round(hours - d * 24);
  return h ? `${d} 日 ${h} 時間` : `${d} 日`;
}
