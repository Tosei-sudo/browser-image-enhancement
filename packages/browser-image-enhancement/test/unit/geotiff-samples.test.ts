import { describe, expect, it } from 'vitest';
import type GeoTIFF from 'ol/source/GeoTIFF.js';
import { floatNoData, isEightBit, keepEightBitRange } from '../../src/openlayers/geotiff-samples.js';

/** A stand-in for an OpenLayers GeoTIFF source after it opened its images. */
function source(bits: number, format: number, nodata: number | null = null, levels = 1): GeoTIFF {
  const image = { getSamplesPerPixel: () => 3, getBitsPerSample: () => bits, getSampleFormat: () => format };
  return {
    sourceImagery_: [Array.from({ length: levels }, () => image)],
    nodataValues_: [[nodata]],
    sourceInfo_: [{}, { min: 5 }],
  } as unknown as GeoTIFF;
}

describe('GeoTIFF samples', () => {
  it('tells plain 8-bit images apart', () => {
    expect(isEightBit(source(8, 1))).toBe(true);
    expect(isEightBit(source(16, 1))).toBe(false);
    expect(isEightBit(source(8, 2))).toBe(false);
    expect(isEightBit({} as GeoTIFF)).toBe(false);
  });

  it('keeps 8-bit values at 0-255 unless a range is given', () => {
    const s = source(8, 1);
    keepEightBitRange(s);
    expect((s as unknown as { sourceInfo_: unknown }).sourceInfo_).toEqual([{ min: 0, max: 255 }, { min: 5, max: 255 }]);
  });

  it('matches a rounded lowest-float no-data value, as GDAL does', () => {
    const test = floatNoData(source(32, 3, -3.40282e38))!;
    expect(test(-3.4028234663852886e38)).toBe(true);
    expect(test(Math.fround(-3.40282e38))).toBe(true);
    expect(test(-1e30)).toBe(false);
  });

  it('matches a no-data value float32 cannot hold exactly, and needs no test otherwise', () => {
    const test = floatNoData(source(32, 3, 0.1))!;
    expect(test(Math.fround(0.1))).toBe(true);
    expect(test(0.2)).toBe(false);
    expect(floatNoData(source(32, 3, -9999))).toBeNull();
    expect(floatNoData(source(16, 1, 0.1))).toBeNull();
    expect(floatNoData(source(32, 3, null))).toBeNull();
  });
});
