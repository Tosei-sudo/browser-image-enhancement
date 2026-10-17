import { describe, expect, it } from 'vitest';
import { medianInPlace, selectInPlace } from '../src/select.js';

describe('selectInPlace', () => {
  it('finds what a sort puts at every index', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (const n of [1, 2, 3, 17, 100, 1001]) {
      for (const kind of ['random', 'few', 'sorted', 'reversed', 'equal']) {
        const values = Array.from({ length: n }, (_, i) =>
          kind === 'random' ? rnd() * 100 - 50 : kind === 'few' ? Math.floor(rnd() * 3) : kind === 'sorted' ? i : kind === 'reversed' ? n - i : 5,
        );
        const sorted = [...values].sort((a, b) => a - b);
        for (const k of [0, n >> 1, n - 1, Math.floor(n * 0.98)].filter((k) => k < n)) {
          const a = Float64Array.from(values);
          expect(selectInPlace(a, k)).toBe(sorted[k]);
          for (let i = 0; i < k; i++) expect(a[i]).toBeLessThanOrEqual(a[k]);
          for (let i = k + 1; i < n; i++) expect(a[i]).toBeGreaterThanOrEqual(a[k]);
        }
      }
    }
  });

  it('gives the median of odd and even counts', () => {
    expect(medianInPlace(Float64Array.from([3, 1, 2]))).toBe(2);
    expect(medianInPlace(Float64Array.from([4, 1, 3, 2]))).toBe(2.5);
    expect(medianInPlace(new Float64Array(0))).toBeNaN();
  });
});
