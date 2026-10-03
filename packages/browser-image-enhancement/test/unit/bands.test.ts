import { describe, expect, it } from 'vitest';
import { assignBands, isGraySelection, rasterToImageData, selectBands } from '../../src/index.js';

/** Two pixels of a 4-band raster: band b of pixel p holds 1000 * (p + 1) + b. */
const raster = (alpha = false) => ({
  data: Uint16Array.from({ length: 8 }, (_, i) => 1000 * (Math.floor(i / 4) + 1) + (i % 4)),
  width: 2,
  height: 1,
  bands: 4,
  alpha,
});

describe('band assignment', () => {
  it('takes bands out of a raster in the given order, keeping its array type', () => {
    const out = selectBands(raster(), [3, 2, 1]);
    expect(out.data).toBeInstanceOf(Uint16Array);
    expect([...out.data]).toEqual([1003, 1002, 1001, 2003, 2002, 2001]);
    expect(out).toMatchObject({ width: 2, height: 1, bands: 3, alpha: false });
    expect([...selectBands(raster(), [2]).data]).toEqual([1002, 2002]);
    expect([...selectBands({ data: [1, 2, 3, 4], width: 2, height: 1, bands: 2 }, [1, 0, 1]).data]).toEqual([2, 1, 2, 4, 3, 4]);
  });

  it('keeps the alpha band last and never selects it', () => {
    const out = selectBands(raster(true), [2, 0]);
    expect([...out.data]).toEqual([1002, 1000, 1003, 2002, 2000, 2003]);
    expect(out).toMatchObject({ bands: 3, alpha: true });
    expect(() => selectBands(raster(true), [3])).toThrow(RangeError);
    expect(() => selectBands(raster(), [4])).toThrow(RangeError);
    expect(() => selectBands(raster(), [])).toThrow(RangeError);
  });

  it('feeds rasterToImageData, which also takes the selection directly', () => {
    const stretch = { black: 1000, white: 2000 };
    const viaSelect = rasterToImageData({ ...raster(), select: [3, 2, 1] }, { stretch });
    const viaBands = rasterToImageData(selectBands(raster(), [3, 2, 1]), { stretch });
    expect([...viaBands.data]).toEqual([...viaSelect.data]);
  });

  it('assigns channels of an RGBA image to R, G and B, keeping alpha', () => {
    const img = { data: new Uint8ClampedArray([10, 20, 30, 40, 50, 60, 70, 80]), width: 2, height: 1 };
    expect([...assignBands(img, [2, 1, 0]).data]).toEqual([30, 20, 10, 40, 70, 60, 50, 80]);
    expect([...assignBands(img, [1]).data]).toEqual([20, 20, 20, 40, 60, 60, 60, 80]);
    expect([...assignBands(img, [3, 3, 0]).data]).toEqual([40, 40, 10, 40, 80, 80, 50, 80]);
    expect(() => assignBands(img, [0, 1, 4])).toThrow(RangeError);
  });

  it('tells gray selections apart', () => {
    expect(isGraySelection([2])).toBe(true);
    expect(isGraySelection([2, 2, 2])).toBe(true);
    expect(isGraySelection([2, 1, 2])).toBe(false);
  });
});
