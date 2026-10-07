import { describe, expect, it } from 'vitest';
import { colorModeFor, fromRGBA, maskNoData, selectRGBA, toRgb, toRGBA, toSelectedTile } from '../../src/openlayers/tile-pixels.js';

describe('tile pixel conversions', () => {
  it('turns 1 to 4 band tiles into RGBA and back', () => {
    const tiles: Record<number, number[]> = {
      1: [10, 20],
      2: [10, 255, 20, 0],
      3: [1, 2, 3, 4, 5, 6],
      4: [1, 2, 3, 255, 4, 5, 6, 0],
    };
    expect(Array.from(toRGBA(tiles[1], 1, 2))).toEqual([10, 10, 10, 255, 20, 20, 20, 255]);
    expect(Array.from(toRGBA(tiles[2], 2, 2))).toEqual([10, 10, 10, 255, 20, 20, 20, 0]);
    expect(Array.from(toRGBA(tiles[3], 3, 2))).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
    for (const bands of [1, 2, 3, 4]) {
      expect(Array.from(fromRGBA(toRGBA(tiles[bands], bands, 2), bands, 2))).toEqual(tiles[bands]);
    }
  });

  it('picks three bands as RGB, with alpha from the alpha band', () => {
    // Two pixels of 5 value bands and an alpha band.
    const tile = [0, 1, 2, 3, 4, 200, 10, 11, 12, 13, 14, 0];
    expect(Array.from(selectRGBA(tile, 6, [4, 2, 0], 5, 2))).toEqual([4, 2, 0, 200, 14, 12, 10, 0]);
    expect(Array.from(selectRGBA(tile, 6, [1, 1, 1], -1, 2))).toEqual([1, 1, 1, 255, 11, 11, 11, 255]);
    expect(Array.from(toSelectedTile(new Uint8ClampedArray([4, 2, 0, 200, 14, 12, 10, 0]), 6, true, 2))).toEqual([4, 2, 0, 200, 0, 200, 14, 12, 10, 0, 0, 0]);
  });

  it('reads one band index as gray and checks indexes', () => {
    expect(toRgb([2])).toEqual([2, 2, 2]);
    expect(toRgb([3, 2, 1])).toEqual([3, 2, 1]);
    expect(() => toRgb([1.5] as unknown as [number])).toThrow(RangeError);
    expect(colorModeFor(2)).toBe('gray');
    expect(colorModeFor(4)).toBe('rgb');
  });

  it('makes no-data pixels of a float tile transparent', () => {
    const tile = new Float32Array([-9999, -9999, 1, 5, -9999, 1, -9999, -9999, 0]);
    expect(Array.from(maskNoData(tile, 3, (v) => v === -9999) as Float32Array)).toEqual([0, 0, 0, 5, -9999, 1, -9999, -9999, 0]);
    const bytes = new Uint8Array([0, 0, 255]);
    expect(maskNoData(bytes, 3, () => true)).toBe(bytes); // only float tiles carry no-data values
  });
});
