import { describe, expect, it } from 'vitest';
import proj4 from 'proj4';
import { resampleDem } from '../src/dem-geotiff.js';
import { elevationAt } from '../src/dem.js';
import { DTED_VOID } from '../src/dted.js';

/** A raster of `f(x, y)` at pixel centres over `extent`. */
function raster(width: number, height: number, extent: number[], f: (x: number, y: number) => number) {
  const data = new Float32Array(width * height);
  const px = (extent[2] - extent[0]) / width;
  const py = (extent[3] - extent[1]) / height;
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) data[r * width + c] = f(extent[0] + (c + 0.5) * px, extent[3] - (r + 0.5) * py);
  return { width, height, data, noData: -9999, extent };
}

describe('GeoTIFF DEMs', () => {
  it('in longitude and latitude keep their heights', () => {
    const extent = [139, 35, 139.1, 35.1];
    const plane = (lon: number, lat: number) => 100 + (lon - 139) * 1000 + (lat - 35) * 500;
    const cell = resampleDem(raster(100, 100, extent, plane), (p) => p, extent);
    expect(cell.level).toBe('GeoTIFF');
    expect(cell.width * cell.height).toBe(10_000);
    for (const [lon, lat] of [
      [139.05, 35.05],
      [139.0123, 35.0871],
    ]) {
      expect(elevationAt([cell], lon, lat)).toBeCloseTo(plane(lon, lat), 3);
    }
  });

  it('in a projected system (UTM) are resampled to longitude and latitude', () => {
    const utm = proj4('EPSG:4326', '+proj=utm +zone=54 +datum=WGS84 +units=m +no_defs');
    const [x0, y0] = utm.forward([139.7, 35.6]);
    const extent = [x0 - 5000, y0 - 5000, x0 + 5000, y0 + 5000];
    const bowl = (x: number, y: number) => 50 + ((x - x0) ** 2 + (y - y0) ** 2) / 1e5;
    const lonLat = [...utm.inverse([extent[0], extent[1]]), ...utm.inverse([extent[2], extent[3]])];
    const cell = resampleDem(raster(200, 200, extent, bowl), (p) => utm.forward(p as [number, number]), [Math.min(lonLat[0], lonLat[2]), Math.min(lonLat[1], lonLat[3]), Math.max(lonLat[0], lonLat[2]), Math.max(lonLat[1], lonLat[3])]);
    for (const [dx, dy] of [
      [0, 0],
      [3000, -2000],
      [-4000, 1500],
    ]) {
      const [lon, lat] = utm.inverse([x0 + dx, y0 + dy]);
      // Bilinear on 50 m pixels of a smooth bowl.
      expect(elevationAt([cell], lon, lat)).toBeCloseTo(bowl(x0 + dx, y0 + dy), 0);
    }
    // The corners of the longitude / latitude box are outside the (turned) UTM square.
    expect(cell.data[0]).toBe(DTED_VOID);
  });

  it('leave out no data, and are reduced when large', () => {
    const extent = [0, 0, 1, 1];
    const r = raster(400, 400, extent, (x) => (x < 0.5 ? -9999 : 10));
    const cell = resampleDem(r, (p) => p, extent, 10_000);
    expect(cell.width).toBe(100);
    expect(elevationAt([cell], 0.25, 0.5)).toBeNull();
    expect(elevationAt([cell], 0.75, 0.5)).toBeCloseTo(10, 5);
  });
});
