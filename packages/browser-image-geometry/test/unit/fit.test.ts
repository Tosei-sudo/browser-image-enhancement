import { describe, expect, it } from 'vitest';
import {
  affine,
  applyTransform,
  DegenerateError,
  fitTransform,
  invertTransform,
  projective,
  type ControlPoint,
  type Point,
  type Transform,
} from '../../src/index.js';

function pointsFor(t: Transform, pixels: Point[]): ControlPoint[] {
  return pixels.map((pixel) => ({ pixel, world: applyTransform(t, pixel) }));
}

const grid: Point[] = [];
for (let y = 0; y <= 4; y++) for (let x = 0; x <= 4; x++) grid.push([x * 500 + 13, y * 400 + 7]);
const spread = [grid[0], grid[4], grid[12], grid[20], grid[24], grid[7]];

describe('fitTransform', () => {
  it('recovers an affine georeference in degrees exactly', () => {
    // About 1e-4 degrees per pixel around Tokyo, slightly rotated.
    const truth = affine([1e-4, 1e-6, 139.7, 2e-6, -9e-5, 35.69]);
    const fit = fitTransform(pointsFor(truth, spread), { model: 'affine' });
    expect(fit.rms).toBeLessThan(1e-10);
    expect(fit.transform.yUp).toBe(true);
    const m = (fit.transform as typeof truth).matrix;
    truth.matrix.forEach((v, i) => expect(m[i]).toBeCloseTo(v, 12));
  });

  it('recovers a projective transform from four points', () => {
    const truth = projective([1.1, 0.2, 30, -0.1, 0.95, 12, 1e-4, -5e-5, 1]);
    const fit = fitTransform(pointsFor(truth, [grid[0], grid[4], grid[20], grid[24]]), { model: 'projective', target: 'image' });
    expect(fit.rms).toBeLessThan(1e-8);
    expect(fit.transform.yUp).toBeUndefined();
    for (const p of grid) {
      const a = applyTransform(fit.transform, p);
      const b = applyTransform(truth, p);
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-7);
    }
  });

  it('fits polynomials in both directions', () => {
    // A gentle quadratic warp.
    const f = (x: number, y: number): Point => [x + 1e-5 * x * y + 0.5 * y, y - 5e-6 * x * x + 100];
    const points = grid.map((pixel) => ({ pixel, world: f(...pixel) }));
    for (const model of ['polynomial2', 'polynomial3'] as const) {
      const fit = fitTransform(points, { model });
      expect(fit.rms).toBeLessThan(1e-6);
      expect(fit.transform.type).toBe('polynomial');
      // The fitted inverse takes target points back to their pixels.
      const back = invertTransform(fit.transform);
      for (const p of points) {
        const q = applyTransform(back, p.world);
        expect(Math.hypot(q[0] - p.pixel[0], q[1] - p.pixel[1])).toBeLessThan(0.1);
      }
    }
  });

  it('reports residuals for redundant, noisy points', () => {
    const truth = affine([2, 0, 0, 0, 2, 0]);
    const points = pointsFor(truth, spread);
    const noisy = points.map((p, i) => (i === 2 ? { ...p, world: [p.world[0] + 3, p.world[1]] as Point } : p));
    const fit = fitTransform(noisy, { model: 'affine' });
    expect(fit.residuals).toHaveLength(6);
    expect(fit.rms).toBeGreaterThan(0.5);
    const worst = fit.residuals.reduce((a, r, i) => (r.distance > fit.residuals[a].distance ? i : a), 0);
    expect(worst).toBe(2);
    expect(fit.rms).toBeCloseTo(Math.sqrt(fit.residuals.reduce((s, r) => s + r.distance ** 2, 0) / 6), 12);
  });

  it('rejects too few or degenerate points', () => {
    const t = affine([1, 0, 0, 0, 1, 0]);
    expect(() => fitTransform(pointsFor(t, grid.slice(0, 2)))).toThrow(DegenerateError);
    expect(() => fitTransform(pointsFor(t, spread.slice(0, 5)), { model: 'polynomial2' })).toThrow(/at least 6/);
    // grid[0..4] all share one y: a line.
    expect(() => fitTransform(pointsFor(t, grid.slice(0, 5)), { model: 'affine' })).toThrow(DegenerateError);
    const line: Point[] = [[0, 0], [1, 1], [2, 2], [3, 3]];
    expect(() => fitTransform(pointsFor(t, line), { model: 'affine' })).toThrow(DegenerateError);
    expect(() => fitTransform(pointsFor(t, line), { model: 'projective' })).toThrow(DegenerateError);
    expect(() => fitTransform([{ pixel: [0, 0] } as never])).toThrow(TypeError);
  });
});
