import { describe, expect, it } from 'vitest';
import {
  affine,
  applyTransform,
  composeTransforms,
  invertTransform,
  projective,
  rotation,
  scaling,
  translation,
} from '../../src/index.js';

const close = (a: number[], b: number[], eps = 1e-9) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], -Math.log10(eps)));

describe('transforms', () => {
  it('applies and inverts affine transforms', () => {
    const t = affine([2, 0.5, 10, -0.3, 1.5, -4]);
    const p = applyTransform(t, [3, 7]);
    expect(p).toEqual([2 * 3 + 0.5 * 7 + 10, -0.3 * 3 + 1.5 * 7 - 4]);
    close(applyTransform(invertTransform(t), p), [3, 7]);
  });

  it('applies and inverts projective transforms', () => {
    const t = projective([1.2, 0.1, 5, 0.05, 0.9, -3, 0.001, 0.002, 1]);
    const p = applyTransform(t, [40, 25]);
    close(applyTransform(invertTransform(t), p), [40, 25]);
  });

  it('rotates quarter turns exactly', () => {
    const t = rotation(90, [50, 25]);
    expect(applyTransform(t, [60, 25])).toEqual([50, 35]);
    expect(t.matrix).toEqual([0, -1, 75, 1, 0, -25]);
  });

  it('composes in application order', () => {
    const t = composeTransforms(scaling(2), translation(5, 1));
    expect(applyTransform(t, [3, 4])).toEqual([11, 9]);
    expect(t.type).toBe('affine');
    expect(composeTransforms(projective([1, 0, 0, 0, 1, 0, 0.01, 0, 1]), scaling(2)).type).toBe('projective');
  });

  it('rejects malformed matrices and singular inverses', () => {
    expect(() => affine([1, 2, 3] as never)).toThrow(TypeError);
    expect(() => affine([1, 0, 0, 0, NaN, 0])).toThrow(TypeError);
    expect(() => invertTransform(affine([1, 2, 0, 2, 4, 0]))).toThrow(/not invertible/);
  });
});
