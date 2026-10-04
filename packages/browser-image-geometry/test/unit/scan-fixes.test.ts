import { describe, expect, it } from 'vitest';
import { DegenerateError, fitTransform, identity, projective, resize, warpImageData } from '../../src/index.js';
import { makeImage } from '../helpers.js';

describe('degenerate input is refused, not turned into a wild result', () => {
  it('a projective fit with three of four points on a line throws', () => {
    const pixels: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 1],
    ];
    const points = pixels.map((pixel, i) => ({ pixel, world: [i * 3, i * i] as [number, number] }));
    expect(() => fitTransform(points, { model: 'projective' })).toThrow(DegenerateError);
  });

  it('a projective horizon inside the image needs an explicit extent', () => {
    const img = makeImage(100, 100, () => [255, 255, 255, 255]);
    expect(() => warpImageData(img, projective([1, 0, 0, 0, 1, 0, 0.01, 0, -0.5005]))).toThrow(/horizon/);
  });

  it('outputs too large to allocate are refused', () => {
    const img = makeImage(10, 10, () => [0, 0, 0, 255]);
    expect(() => warpImageData(img, identity(), { pixelSize: 1e-4 })).toThrow(/more than/);
  });

  it('a width that rounds to 0 is refused', () => {
    const img = makeImage(10, 10, () => [0, 0, 0, 255]);
    expect(() => warpImageData(img, identity(), { width: 0.4 })).toThrow(RangeError);
  });

  it('background channels above 255 are refused', () => {
    const img = makeImage(4, 4, () => [0, 0, 0, 255]);
    expect(() => warpImageData(img, identity(), { background: [0, 0, 0, 300] })).toThrow(TypeError);
  });
});

describe('resize', () => {
  it('keeps an opaque image opaque up to its border', () => {
    const img = makeImage(4, 4, () => [200, 100, 50, 255]);
    for (const resample of ['bilinear', 'bicubic'] as const) {
      const out = resize(img, 8, 8, { resample });
      for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(255);
      expect([...out.data.slice(0, 3)]).toEqual([200, 100, 50]);
    }
  });

  it('does not blur the axis that is not shrunk', () => {
    // Alternating black and white rows, narrowed 10× but kept at 10 rows.
    const img = makeImage(1000, 10, (_x, y) => (y % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const out = resize(img, 100, 10);
    for (let y = 0; y < 10; y++) expect(out.data[(y * 100 + 50) * 4]).toBe(y % 2 ? 255 : 0);
  });
});
