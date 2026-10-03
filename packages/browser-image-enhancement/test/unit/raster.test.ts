import { describe, expect, it } from 'vitest';
import {
  computeRasterStretch,
  mergeRasterHistograms,
  rasterHistogram,
  rasterRange,
  rasterToImageData,
  type Raster,
} from '../../src/index.js';

/** A 16-bit-style gray ramp: values 1000..1000 + 10 * (n - 1). */
const ramp = (n: number): Raster => ({ data: Uint16Array.from({ length: n }, (_, i) => 1000 + 10 * i), width: n, height: 1 });

describe('raster input', () => {
  it('stretches raw values onto 0-255 without rounding them to 8 bits first', () => {
    const img = rasterToImageData(ramp(256), { stretch: { black: 1000, white: 3550 } });
    for (let x = 0; x < 256; x++) {
      expect(img.data[x * 4]).toBe(x);
      expect(img.data[x * 4 + 1]).toBe(x);
      expect(img.data[x * 4 + 3]).toBe(255);
    }
  });

  it('computes the automatic stretch on the raw values', () => {
    const h = rasterHistogram(ramp(1000));
    expect(h.range).toEqual([1000, 10990]);
    expect(h.count).toBe(1000);
    expect(computeRasterStretch(h, { method: 'minMax' })).toEqual({ black: [1000], white: [10990] });
    const clipped = computeRasterStretch(h, { lowPercent: 10, highPercent: 10 });
    expect(clipped.black[0]).toBeGreaterThan(1900);
    expect(clipped.black[0]).toBeLessThan(2100);
    expect(clipped.white[0]).toBeGreaterThan(9900);
    expect(clipped.white[0]).toBeLessThan(10100);
    // The default (0.5 % at each end) is what rasterToImageData uses without options.
    const auto = rasterToImageData(ramp(1000));
    expect(auto.data[0]).toBe(0);
    expect(auto.data[999 * 4]).toBe(255);
  });

  it('makes no-data, NaN and alpha-0 pixels transparent and leaves them out of statistics', () => {
    const r: Raster = { data: Float32Array.from([5, 255, -9999, 255, NaN, 255, 7, 0, 9, 255]), width: 5, height: 1, bands: 2, alpha: true, noData: -9999 };
    expect(rasterRange(r)).toEqual([5, 9]);
    expect(rasterHistogram(r).count).toBe(2);
    const img = rasterToImageData(r, { stretch: { black: 5, white: 9 } });
    expect(Array.from(img.data.filter((_, i) => i % 4 === 3))).toEqual([255, 0, 0, 0, 255]);
    expect(img.data[16]).toBe(255);
  });

  it('picks color bands with select and stretches them per band', () => {
    // 4 bands per pixel (e.g. B, G, R, NIR); show R, G, B = bands 2, 1, 0.
    const data = new Float32Array([0, 10, 100, 1, 50, 60, 200, 1]);
    const img = rasterToImageData({ data, width: 2, height: 1, bands: 4, select: [2, 1, 0] }, { stretch: { method: 'minMax' } });
    expect(Array.from(img.data)).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
    const linked = rasterToImageData({ data, width: 2, height: 1, bands: 4, select: [2, 1, 0] }, { stretch: { method: 'minMax', linked: true } });
    expect(Math.abs(linked.data[0] - 127.5)).toBe(0.5); // R 100 on the shared range 0..200
  });

  it('merges histograms of tiles taken over one range', () => {
    const a = ramp(100);
    const b: Raster = { data: Uint16Array.from({ length: 100 }, (_, i) => 2000 + 10 * i), width: 100, height: 1 };
    const range = [1000, 2990] as const;
    const merged = mergeRasterHistograms([rasterHistogram(a, { range }), rasterHistogram(b, { range })]);
    expect(merged.count).toBe(200);
    expect(computeRasterStretch(merged, { method: 'minMax' })).toEqual({ black: [1000], white: [2990] });
    expect(() => mergeRasterHistograms([rasterHistogram(a), rasterHistogram(b)])).toThrow(RangeError);
  });

  it('rejects inconsistent layouts', () => {
    expect(() => rasterToImageData({ data: [1, 2, 3], width: 2, height: 2 })).toThrow(RangeError);
    expect(() => rasterToImageData({ data: [1, 2, 3, 4], width: 2, height: 1, bands: 2, select: [0, 1] as never })).toThrow(RangeError);
  });
});
