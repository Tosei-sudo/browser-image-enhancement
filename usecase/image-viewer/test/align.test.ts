import { describe, expect, it } from 'vitest';
import { applyAffine, fft, fitAffine, invertAffine, phaseCorrelate, robustFit, type TiePoint } from '../src/align.js';

/** Seeded noise, a little smoothed, like the texture of an image; read between pixels bilinearly. */
const SIZE = 256;
const noise = (() => {
  let seed = 12345;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const raw = Float64Array.from({ length: SIZE * SIZE }, random);
  const out = new Float64Array(SIZE * SIZE);
  for (let y = 1; y < SIZE - 1; y++) for (let x = 1; x < SIZE - 1; x++) out[y * SIZE + x] = (raw[y * SIZE + x] * 4 + raw[y * SIZE + x - 1] + raw[y * SIZE + x + 1] + raw[(y - 1) * SIZE + x] + raw[(y + 1) * SIZE + x]) / 8;
  return out;
})();
const scene = (x: number, y: number) => {
  x += 64;
  y += 64;
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const v = (a: number, b: number) => noise[b * SIZE + a];
  return (v(i, j) * (1 - fx) + v(i + 1, j) * fx) * (1 - fy) + (v(i, j + 1) * (1 - fx) + v(i + 1, j + 1) * fx) * fy;
};

const grid = (n: number, f: (x: number, y: number) => number) => {
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[y * n + x] = f(x, y);
  return out;
};

describe('FFT', () => {
  it('goes there and back', () => {
    const re = Float64Array.from([1, 2, 3, 4, 0, -1, 5, 2]);
    const im = new Float64Array(8);
    fft(re, im);
    expect(re[0]).toBeCloseTo(16);
    fft(re, im, true);
    expect(Array.from(re).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([1, 2, 3, 4, 0, -1, 5, 2]);
  });
});

describe('phase correlation', () => {
  it('finds a whole-pixel shift: b(x) = a(x − d)', () => {
    const a = grid(64, scene);
    const b = grid(64, (x, y) => scene(x - 5, y + 3));
    const c = phaseCorrelate(a, b, 64)!;
    expect(c.dx).toBeCloseTo(5, 1);
    expect(c.dy).toBeCloseTo(-3, 1);
    expect(c.strength).toBeGreaterThan(1.5);
  });

  it('finds a fraction of a pixel, whatever the brightness', () => {
    const a = grid(128, scene);
    const b = grid(128, (x, y) => 3 * scene(x - 2.4, y - 1.3) + 100);
    const c = phaseCorrelate(a, b, 128)!;
    expect(c.dx).toBeCloseTo(2.4, 0);
    expect(Math.abs(c.dx - 2.4)).toBeLessThan(0.25);
    expect(Math.abs(c.dy - 1.3)).toBeLessThan(0.25);
  });

  it('gives up on a flat grid or one mostly without data', () => {
    expect(phaseCorrelate(new Float32Array(64), grid(8, scene).subarray(0, 64), 8)).toBeNull();
    expect(phaseCorrelate(grid(8, scene), new Float32Array(64).fill(NaN), 8)).toBeNull();
  });
});

describe('fitting tie points', () => {
  const t = [10, 1.001, 0.002, -5, -0.002, 0.999] as const;
  const points: TiePoint[] = [];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const x = i * 100;
      const y = j * 100;
      const [u, v] = applyAffine([...t], x, y);
      points.push({ x, y, u, v });
    }
  }

  it('fits an affine exactly, and inverts it', () => {
    const fit = fitAffine(points)!;
    fit.forEach((v, i) => expect(v).toBeCloseTo(t[i], 6));
    const back = invertAffine(fit)!;
    const [x, y] = applyAffine(back, ...applyAffine(fit, 12, 34));
    expect(x).toBeCloseTo(12, 6);
    expect(y).toBeCloseTo(34, 6);
  });

  it('drops an outlier, and fits a shift by the median', () => {
    const bad = [...points, { x: 50, y: 50, u: 500, v: 500 }];
    const fit = robustFit(bad, 'affine')!;
    expect(fit.kept).toHaveLength(points.length);
    expect(fit.rms).toBeLessThan(1e-6);
    const shift = robustFit(bad, 'shift')!;
    expect(shift.transform[1]).toBe(1);
    expect(shift.transform[0]).toBeCloseTo(10, 0);
  });
});
