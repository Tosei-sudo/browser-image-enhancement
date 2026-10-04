import { describe, expect, it } from 'vitest';
import { affine, halveRaster, identity, translation, warpRaster } from '../../src/index.js';

function ramp(width: number, height: number, bands = 1): Uint16Array {
  const data = new Uint16Array(width * height * bands);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let b = 0; b < bands; b++) data[(y * width + x) * bands + b] = 1000 + x * 10 + y * 100 + b;
  return data;
}

describe('warpRaster', () => {
  it('keeps the sample type and values under the identity', () => {
    const data = ramp(8, 6, 3);
    for (const resample of ['nearest', 'bilinear', 'bicubic'] as const) {
      const { raster } = warpRaster({ width: 8, height: 6, bands: 3, data }, identity(), { resample });
      expect(raster.data).toBeInstanceOf(Uint16Array);
      expect([raster.width, raster.height, raster.bands]).toEqual([8, 6, 3]);
      expect(Array.from(raster.data)).toEqual(Array.from(data));
    }
  });

  it('interpolates 16-bit values beyond 255', () => {
    const data = ramp(8, 8);
    // Half a pixel right: bilinear lands between two columns.
    const { raster } = warpRaster({ width: 8, height: 8, bands: 1, data }, translation(-0.5, 0), { extent: [0, 0, 6, 8], width: 6, height: 8 });
    expect(raster.data[0]).toBe(1005);
    expect(raster.data[8 * 0 + 3]).toBe(1035);
  });

  it('leaves out no-data and fills outside the source', () => {
    const data = new Float32Array([1, 2, -9999, 4]);
    const { raster } = warpRaster({ width: 2, height: 2, bands: 1, data, noData: -9999 }, translation(1, 0), { extent: [0, 0, 3, 2], width: 3, height: 2 });
    expect(raster.data[0]).toBe(-9999); // left of the source
    expect(raster.data[1]).toBe(1);
    expect(raster.data[2]).toBe(2);
    expect(raster.data[3]).toBe(-9999);
    expect(raster.data[4]).toBe(-9999); // the no-data pixel stays no-data
    expect(raster.data[5]).toBe(4);
  });

  it('places the output in map coordinates, north up', () => {
    const data = ramp(4, 4);
    const t = affine([10, 0, 500, 0, -10, 2000], { yUp: true });
    const { raster, geoTransform, extent } = warpRaster({ width: 4, height: 4, bands: 1, data }, t);
    expect(extent).toEqual([500, 1960, 540, 2000]);
    expect(geoTransform).toEqual([500, 10, 0, 2000, 0, -10]);
    expect(Array.from(raster.data)).toEqual(Array.from(data));
  });

  it('halves without the no-data pixels', () => {
    const half = halveRaster({ width: 2, height: 2, bands: 1, data: new Int16Array([10, -32767, 20, 30]), noData: -32767 });
    expect(Array.from(half.data)).toEqual([20]);
  });
});
