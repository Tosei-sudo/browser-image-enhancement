import { describe, expect, it } from 'vitest';
import {
  computeRasterStretch,
  mergeRasterHistograms,
  rasterHistogram,
  rasterRange,
  rasterToImageData,
  sampleRasterHistogram,
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

describe('non-finite values', () => {
  it('±Infinity counts as no data, so it does not flatten the rest to black', () => {
    const data = Float32Array.from([0, 10, 20, 30, 40, 50, 60, Infinity]);
    const img = rasterToImageData({ data, width: 8, height: 1 }, { stretch: { method: 'minMax' } });
    expect(img.data[4 * 6]).toBe(255);
    expect(img.data[0]).toBe(0);
    expect(img.data[4 * 7 + 3]).toBe(0);
  });
});

/**
 * A scene of reflectances 0.02-0.35 (a ramp) with `fill` around it in
 * `fillShare` of the pixels, like a rotated satellite scene whose corners
 * hold a fill value that is not tagged as no data, plus `edge` pixels
 * blending fill and scene (as averaged overviews have).
 */
function scene(fill: number, fillShare = 0.4, edge = 0): Raster {
  const n = 10000;
  const filled = Math.round(n * fillShare);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (i < filled) data[i] = fill;
    else if (i < filled + edge) data[i] = fill / 2 + 0.1;
    else data[i] = 0.02 + (0.33 * (i - filled - edge)) / (n - filled - edge - 1);
  }
  return { data, width: 100, height: 100 };
}

describe('real-world raw imagery', () => {
  it('leaves out a fill value that is not tagged as no data, instead of washing the scene out white', () => {
    for (const fill of [-9999, -3.4028234663852886e38, -32768]) {
      const raster = scene(fill, 0.4, 30);
      // A plain histogram puts black at the fill: the whole scene ends up white.
      expect(computeRasterStretch(rasterHistogram(raster), { lowPercent: 2, highPercent: 2 }).black[0]).toBe(fill);
      const s = computeRasterStretch(sampleRasterHistogram([{ raster }])!, { lowPercent: 2, highPercent: 2 });
      expect(s.black[0]).toBeGreaterThan(0.02);
      expect(s.black[0]).toBeLessThan(0.04);
      expect(s.white[0]).toBeGreaterThan(0.33);
      expect(s.white[0]).toBeLessThanOrEqual(0.35);
      const img = rasterToImageData(raster, { stretch: { lowPercent: 2, highPercent: 2 } });
      // The middle of the scene is mid-gray, not white.
      expect(img.data[4 * 7000]).toBeGreaterThan(80);
      expect(img.data[4 * 7000]).toBeLessThan(180);
    }
  });

  it('keeps a far outlier from squeezing the values into a few bins', () => {
    const raster = scene(0, 0);
    (raster.data as Float32Array)[0] = 1e30; // one hot pixel
    const s = computeRasterStretch(sampleRasterHistogram([{ raster }])!, { lowPercent: 2, highPercent: 2 });
    expect(s.black[0]).toBeGreaterThan(0.02);
    expect(s.white[0]).toBeLessThan(0.35);
    expect(s.white[0]).toBeGreaterThan(s.black[0] + 0.25);
  });

  it('gives imagery without fill or outliers the plain histogram', () => {
    const raster = ramp(1000);
    expect(sampleRasterHistogram([{ raster }])).toEqual(rasterHistogram(raster));
    // A dark band near the rest is data, not fill.
    const dark: Raster = { data: Uint16Array.from({ length: 1000 }, (_, i) => (i < 300 ? 0 : 150 + i)), width: 1000, height: 1 };
    expect(sampleRasterHistogram([{ raster: dark }])).toEqual(rasterHistogram(dark));
  });
});
