import { describe, expect, it } from 'vitest';
import { readDted } from '../src/dted.js';
import { fromMercator, toMercator, type OrthoResult } from '../src/ortho.js';
import { displacement, gridLookup, isImdName, sampleGrid, sensorViewFromText, simpleOrthorectify, type SensorView } from '../src/simple-ortho.js';
import { dted } from './fixtures.js';

describe('simple orthorectification', () => {
  // A 200 × 200 image in WGS 84 longitude / latitude, 0.001° pixels, a bright dot in the middle.
  const [lon0, lat0, step, size] = [139.4, 35.6, 0.001, 200];
  const dot = [100, 100];
  const image = () => {
    const data = new Uint8Array(size * size);
    data[dot[1] * size + dot[0]] = 255;
    return { width: size, height: size, bands: 1, data, noData: 0 };
  };
  const toMap = sampleGrid([0, 0, size, size], 33, 33, (x, y) => toMercator(lon0 + x * step, lat0 - y * step));
  const [minX, minY] = toMercator(lon0, lat0 - size * step);
  const [maxX, maxY] = toMercator(lon0 + size * step, lat0);
  const extent = [minX, minY, maxX, maxY] as const;
  const margin = 5000;
  const toRaster = sampleGrid([minX - margin, minY - margin, maxX + margin, maxY + margin], 65, 65, (x, y) => {
    const [lon, lat] = fromMercator(x, y);
    return [(lon - lon0) / step, (lat0 - lat) / step];
  });
  const pixelSize = Math.sqrt(((maxX - minX) * (maxY - minY)) / (size * size));
  const flat1000 = readDted(dted({ west: 139, south: 35, spacing: [30, 30], elevation: () => 1000 }));

  const run = (view: SensorView, cells = [flat1000], referenceHeight = 0) =>
    simpleOrthorectify({ raster: image(), toMap, toRaster, extent, pixelSize, cells, view, referenceHeight, resample: 'nearest' });

  /** Longitude and latitude of the brightest output pixel's center. */
  const brightest = ({ raster, geoTransform }: OrthoResult): [number, number] => {
    let best = 0;
    for (let i = 1; i < raster.data.length; i++) if (raster.data[i] > raster.data[best]) best = i;
    const x = best % raster.width;
    const y = Math.floor(best / raster.width);
    return fromMercator(geoTransform[0] + (x + 0.5) * geoTransform[1], geoTransform[3] + (y + 0.5) * geoTransform[5]);
  };
  const dotLon = lon0 + (dot[0] + 0.5) * step;
  const dotLat = lat0 - (dot[1] + 0.5) * step;
  const metresPerDegree = 111_320;

  it('moves high ground toward the satellite by height / tan(elevation)', () => {
    // Seen from the east at 45°, a point 1000 m up shows 1000 m west of where it is: the ortho puts it back east.
    const result = run({ azimuth: 90, elevation: 45 });
    expect(result.demCoverage).toBe(1);
    const [lon, lat] = brightest(result);
    const east = (lon - dotLon) * metresPerDegree * Math.cos((lat * Math.PI) / 180);
    expect(east).toBeGreaterThan(1000 - 120);
    expect(east).toBeLessThan(1000 + 120);
    expect(Math.abs(lat - dotLat) * metresPerDegree).toBeLessThan(120);
  });

  it('moves by the height above the reference height, in the satellite direction', () => {
    // From the south at 60°, 400 m above the reference: 400 / tan 60° ≈ 231 m south.
    const [lon, lat] = brightest(run({ azimuth: 180, elevation: 60 }, [flat1000], 600));
    expect((lat - dotLat) * metresPerDegree).toBeCloseTo(-231, -2);
    expect(Math.abs(lon - dotLon) * metresPerDegree * Math.cos((lat * Math.PI) / 180)).toBeLessThan(100);
  });

  it('leaves the image where it is at nadir or without a DEM', () => {
    for (const [view, cells] of [
      [{ azimuth: 90, elevation: 90 }, [flat1000]],
      [{ azimuth: 90, elevation: 45 }, []],
    ] as const) {
      const result = run(view, [...cells]);
      const [lon, lat] = brightest(result);
      expect(Math.abs(lon - dotLon) * metresPerDegree * Math.cos((lat * Math.PI) / 180)).toBeLessThan(100);
      expect(Math.abs(lat - dotLat) * metresPerDegree).toBeLessThan(120);
      if (!cells.length) expect(result.demCoverage).toBe(0);
    }
  });

  it('points the displacement away from the satellite', () => {
    const [e, n] = displacement({ azimuth: 90, elevation: 45 });
    expect(e).toBeCloseTo(-1, 9);
    expect(n).toBeCloseTo(0, 9);
    expect(displacement({ azimuth: 0, elevation: 90 })[1]).toBeCloseTo(0, 9);
  });

  it('interpolates and extends sampled grids', () => {
    const grid = sampleGrid([0, 0, 10, 10], 3, 3, (x, y) => [2 * x + 1, y - 3]);
    const close = ([x, y]: number[], [ex, ey]: number[]) => {
      expect(x).toBeCloseTo(ex, 9);
      expect(y).toBeCloseTo(ey, 9);
    };
    close(gridLookup(grid, 2.5, 7), [6, 4]);
    close(gridLookup(grid, -5, 12), [-9, 9]); // linear, so exact beyond the edge too
  });
});

describe('sensor direction from metadata', () => {
  it('reads a DigitalGlobe .IMD file', () => {
    const imd = 'BEGIN_GROUP = IMAGE_1\n\tmeanSunAz = 150.2;\n\tmeanSatAz = 213.4;\n\tmeanSatEl = 71.6;\n\tmeanOffNadirViewAngle = 16.9;\nEND_GROUP = IMAGE_1\n';
    expect(sensorViewFromText(imd)).toEqual({ azimuth: 213.4, elevation: 71.6 });
    expect(isImdName('16FEB01-P1BS.IMD')).toBe(true);
    expect(isImdName('a.tif')).toBe(false);
  });

  it('reads GDAL metadata and off-nadir angles', () => {
    const xml = '<GDALMetadata><Item name="IMAGE_1.meanSatAz" domain="IMD">45.5</Item><Item name="IMAGE_1.meanSatEl" domain="IMD">80</Item></GDALMetadata>';
    expect(sensorViewFromText(xml)).toEqual({ azimuth: 45.5, elevation: 80 });
    expect(sensorViewFromText('{"satellite_azimuth": 101.2, "view_angle": 4.5}')).toEqual({ azimuth: 101.2, elevation: 85.5 });
    expect(sensorViewFromText('{"satellite_azimuth": -90, "off_nadir": -10}')).toEqual({ azimuth: 270, elevation: 80 });
  });

  it('gives null without both angles', () => {
    expect(sensorViewFromText('meanSunAz = 150;')).toBeNull();
    expect(sensorViewFromText('meanSatAz = 150;')).toBeNull();
  });
});
