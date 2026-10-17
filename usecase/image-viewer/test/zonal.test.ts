import { describe, expect, it } from 'vitest';
import { pixelBounds, rasterizePolygon, statField, zoneStats } from '../src/zonal.js';

const square = (x0: number, y0: number, x1: number, y1: number): Array<[number, number]> => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];

const count = (mask: Uint8Array) => mask.reduce((s, v) => s + v, 0);

describe('rasterizePolygon', () => {
  it('takes the cells whose centres are inside', () => {
    const mask = rasterizePolygon([square(1, 1, 3, 4)], 0, 0, 5, 5);
    expect(count(mask)).toBe(6);
    expect(mask[1 * 5 + 1]).toBe(1);
    expect(mask[3 * 5 + 2]).toBe(1);
    expect(mask[4 * 5 + 2]).toBe(0);
    expect(mask[1 * 5 + 3]).toBe(0);
  });

  it('leaves holes out, and lines up with a grid read at half resolution', () => {
    expect(count(rasterizePolygon([square(0, 0, 6, 6), square(2, 2, 4, 4)], 0, 0, 6, 6))).toBe(32);
    // Cells of 2 × 2 pixels from (10, 20): the square covers two of them across and one down.
    expect(count(rasterizePolygon([square(10, 20, 14, 22)], 10, 20, 3, 3, 0.5))).toBe(2);
  });
});

describe('zoneStats', () => {
  it('sums up the masked cells, without no data', () => {
    const [z] = zoneStats([[1, 2, 3, 4, 0]], [1, 1, 1, 0, 1], (v) => v === 0, true);
    expect(z).toMatchObject({ mean: 2, min: 1, max: 3, count: 3, sum: 6, median: 2 });
    expect(zoneStats([[1, 2, 3, 4]], null, undefined, true)[0].median).toBe(2.5);
    expect(zoneStats([[0, 0]], null, (v) => v === 0)[0]).toMatchObject({ count: 0, sum: 0, mean: NaN });
  });
});

describe('pixelBounds', () => {
  it('is clipped to the image, and null for a polygon off it', () => {
    expect(pixelBounds([square(-2.5, 1.2, 3.4, 9)], 8, 8)).toEqual([0, 1, 4, 8]);
    expect(pixelBounds([square(10, 10, 12, 12)], 8, 8)).toBeNull();
  });
});

it('names a one-band image’s columns by the statistic alone', () => {
  expect(statField(3, 'mean', 4)).toBe('B4_mean');
  expect(statField(0, 'max', 1)).toBe('max');
});
