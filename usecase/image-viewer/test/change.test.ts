import { describe, expect, it } from 'vitest';
import { changeMask, meanAndDeviation, spreadOf, thresholdsOf } from '../src/change.js';

describe('change', () => {
  it('takes the mean ± 2σ, or center ± a typed threshold', () => {
    const values = Float32Array.from([0, 0, 0, 0, 10, NaN]);
    const { mean, deviation, count } = meanAndDeviation(values);
    expect(count).toBe(5);
    expect(mean).toBe(2);
    expect(deviation).toBeCloseTo(4);
    expect(thresholdsOf(values, 0, null)).toEqual({ low: 2 - 8, high: 2 + 8 });
    expect(thresholdsOf(values, 1, 0.5)).toEqual({ low: 0.5, high: 1.5 });
    expect(thresholdsOf([NaN], 0, null)).toEqual({ low: -Infinity, high: Infinity });
  });

  it('marks the pixels that changed one way', () => {
    const values = [-5, 0, 5, NaN];
    expect(Array.from(changeMask(values, { low: -1, high: 1 }, 'increase'))).toEqual([0, 0, 1, 0]);
    expect(Array.from(changeMask(values, { low: -1, high: 1 }, 'decrease'))).toEqual([1, 0, 0, 0]);
  });

  it('spreads the colors over most of the distances from no change', () => {
    const values = Array.from({ length: 100 }, (_, i) => (i % 2 ? i : -i));
    expect(spreadOf(values, 0)).toBe(98);
    expect(spreadOf([1, 1, NaN], 1)).toBe(1);
  });
});
