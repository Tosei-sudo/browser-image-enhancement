import { describe, expect, it } from 'vitest';
import { isIndexContour, niceInterval, traceContours, type ElevationGrid } from '../src/contours.js';

/** A grid of `n` × `n` posts one degree apart, from 0°E, `n − 1`°N, with heights `f(column, row)`. */
function grid(n: number, f: (x: number, y: number) => number, noData: number | null = null): ElevationGrid {
  const data = new Float64Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data[y * n + x] = f(x, y);
  return { width: n, height: n, data, noData, west: 0, north: n - 1, spacing: [1, 1] };
}

const all = (n: number): [number, number, number, number] => [0, 0, n - 1, n - 1];
const points = (c: Float64Array) => Array.from({ length: c.length / 2 }, (_, i) => [c[2 * i], c[2 * i + 1]]);

describe('traceContours', () => {
  it('traces a slope as straight lines across the grid, one per level', () => {
    const { lines, truncated } = traceContours(grid(11, (x) => x * 10 + 3), { window: all(11), stride: 1, interval: 25 });
    expect(truncated).toBe(false);
    expect(lines.map((l) => l.level).sort((a, b) => a - b)).toEqual([25, 50, 75, 100]);
    for (const line of lines) {
      const ps = points(line.coordinates);
      expect(ps).toHaveLength(11);
      for (const [lon] of ps) expect(lon).toBeCloseTo((line.level - 3) / 10, 9);
      expect(ps.map(([, lat]) => lat).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    }
  });

  it('closes rings around a hill', () => {
    const { lines } = traceContours(grid(41, (x, y) => 100 - Math.hypot(x - 20, y - 20) * 5), { window: all(41), stride: 1, interval: 20 });
    // Rings where the hill is inside the grid (lower lines run off its edges).
    const rings = lines.filter((l) => l.level >= 20 && l.level < 100);
    expect(rings.map((l) => l.level).sort((a, b) => a - b)).toEqual([20, 40, 60, 80]);
    for (const line of rings) {
      const ps = points(line.coordinates);
      expect(ps[0]).toEqual(ps.at(-1));
      const radius = (100 - line.level) / 5;
      for (const [lon, lat] of ps) expect(Math.hypot(lon - 20, 40 - lat - 20)).toBeCloseTo(radius, 0);
    }
  });

  it('leaves out cells with missing posts', () => {
    const { lines } = traceContours(grid(11, (x, y) => (y === 5 ? -1 : x * 10 + 3), -1), { window: all(11), stride: 1, interval: 50 });
    // The row with no data cuts the line in two.
    const fifty = lines.filter((l) => l.level === 50);
    expect(fifty).toHaveLength(2);
    expect(fifty.every((l) => l.coordinates.length === 10)).toBe(true);
  });

  it('traces a window at a stride', () => {
    const { lines } = traceContours(grid(41, (x) => x + 0.5), { window: [10, 0, 30, 40], stride: 4, interval: 10 });
    expect(lines.map((l) => l.level).sort((a, b) => a - b)).toEqual([20, 30]);
    const ps = points(lines[0].coordinates);
    expect(ps).toHaveLength(11);
    for (const [lon] of ps) expect(lon).toBeCloseTo(19.5, 9);
  });

  it('stops at maxPoints', () => {
    const { lines, truncated } = traceContours(grid(101, (x, y) => x + y), { window: all(101), stride: 1, interval: 1, maxPoints: 500 });
    expect(truncated).toBe(true);
    expect(lines.reduce((n, l) => n + l.coordinates.length / 2, 0)).toBeLessThan(600);
  });

  it('traces a DTED level 2 sized view quickly', () => {
    const n = 2000;
    const g = grid(n, (x, y) => 1000 + 800 * Math.sin(x / 150) * Math.cos(y / 170) + 20 * Math.sin(x / 7 + y / 11));
    const start = performance.now();
    const { lines, truncated } = traceContours(g, { window: all(n), stride: 1, interval: 20 });
    const ms = performance.now() - start;
    expect(truncated).toBe(false);
    expect(lines.length).toBeGreaterThan(100);
    expect(ms).toBeLessThan(10_000);
  }, 30_000);
});

describe('contour intervals', () => {
  it('picks a round interval for about 20 lines', () => {
    expect(niceInterval(0, 2500)).toBe(200);
    expect(niceInterval(0, 3776)).toBe(200);
    expect(niceInterval(10, 300)).toBe(20);
    expect(niceInterval(5, 5)).toBe(1);
  });

  it('marks every 5th line as an index contour', () => {
    expect([0, 10, 50, 100, 150, -50].map((l) => isIndexContour(l, 10))).toEqual([true, false, true, true, true, true]);
    expect(isIndexContour(25, 5)).toBe(true);
    expect(isIndexContour(20, 5)).toBe(false);
  });
});
