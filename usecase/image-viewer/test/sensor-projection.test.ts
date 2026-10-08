import { describe, expect, it } from 'vitest';
import { transform, transformExtent } from 'ol/proj.js';
import { gcpModel, geoKeysCrs, rpcModel, sensorPlacement, sensorProjection, sensorWindowTransform } from '../src/sensor-projection.js';
import { rpcProjector } from '../src/rpc.js';
import { rpcModel as rpcFixture } from './fixtures.js';

const [LON, LAT] = [139.7, 35.7];

/** Ground control points of a 1000 × 1000 image turned 30° and sheared a little, 0.1° across, plus a slight bend. */
function rotatedGcps(): { gcps: number[]; truth: (x: number, y: number) => [number, number] } {
  const a = (30 * Math.PI) / 180;
  const truth = (x: number, y: number): [number, number] => {
    const u = x / 1000 - 0.5;
    const v = y / 1000 - 0.5;
    return [LON + 0.1 * (u * Math.cos(a) + v * Math.sin(a)) + 0.002 * u * u, LAT + 0.1 * (u * Math.sin(a) - v * Math.cos(a))];
  };
  const gcps: number[] = [];
  for (let j = 0; j <= 1000; j += 100) for (let i = 0; i <= 1000; i += 100) gcps.push(i, j, 0, ...truth(i, j), 0);
  return { gcps, truth };
}

describe('sensor projection', () => {
  it('fits ground control points both ways, rotation and bend included', () => {
    const { gcps, truth } = rotatedGcps();
    const fit = gcpModel(gcps)!;
    expect(fit.order).toBe(3);
    expect(fit.points).toBe(121);
    expect(fit.rms).toBeLessThan(0.01);
    const [lon, lat] = fit.model.toLonLat(333, 777);
    const [tl, ta] = truth(333, 777);
    expect(lon).toBeCloseTo(tl, 7);
    expect(lat).toBeCloseTo(ta, 7);
    const [x, y] = fit.model.toPixel(tl, ta);
    expect(x).toBeCloseTo(333, 2);
    expect(y).toBeCloseTo(777, 2);
  });

  it('turns map coordinates into pixels of the image (y up from its top), and back', () => {
    const { gcps, truth } = rotatedGcps();
    const projection = sensorProjection(gcpModel(gcps)!.model, 1000, 1000, { kind: 'gcp' });
    const at = transform(truth(750, 250), 'EPSG:4326', 'EPSG:3857');
    const [x, y] = transform(at, 'EPSG:3857', projection);
    expect(x).toBeCloseTo(750, 1);
    expect(y).toBeCloseTo(-250, 1);
    const back = transform([750, -250], projection, 'EPSG:4326');
    expect(back[0]).toBeCloseTo(truth(750, 250)[0], 6);
    // 0.1° over 1000 pixels: about 10 m a pixel at 35.7°N (between 9 and 11 m east-west and north-south).
    expect(projection.getMetersPerUnit()).toBeGreaterThan(9);
    expect(projection.getMetersPerUnit()).toBeLessThan(11.2);
    expect(sensorPlacement(projection)?.kind).toBe('gcp');
    expect(sensorPlacement('EPSG:3857')).toBeNull();
  });

  it('stays finite and monotonic far outside the image, where a map tile may reach', () => {
    const { gcps } = rotatedGcps();
    const projection = sensorProjection(gcpModel(gcps)!.model, 1000, 1000, { kind: 'gcp' });
    const world = transformExtent([-20037508, -20037508, 20037508, 20037508], 'EPSG:3857', projection);
    expect(world.every(Number.isFinite)).toBe(true);
    const far = transform([LON + 20, LAT + 10], 'EPSG:4326', projection);
    expect(far.every(Number.isFinite)).toBe(true);
    expect(Math.hypot(far[0], far[1])).toBeGreaterThan(10_000);
  });

  it('places an RPC image at the model height, pixel corners half a pixel off the model’s centres', () => {
    const rpc = rpcFixture(LON, LAT);
    const model = rpcModel(rpc);
    const centre = rpcProjector(rpc).toGround(499.5, 499.5, rpc.heightOff);
    const [lon, lat] = model.toLonLat(500, 500);
    expect(lon).toBeCloseTo(centre[0], 9);
    expect(lat).toBeCloseTo(centre[1], 9);
    const [x, y] = model.toPixel(lon, lat);
    expect(x).toBeCloseTo(500, 4);
    expect(y).toBeCloseTo(500, 4);
  });

  it('places a clip of the image by the plane best fitting the model over it', () => {
    const { gcps, truth } = rotatedGcps();
    const model = gcpModel(gcps)!.model;
    // Pixels 200 to 600 across, read at half resolution: 200 × 200 written pixels.
    const m = sensorWindowTransform(model, 200, 400, 400, 400, [2, 2])!;
    const at = (i: number, j: number) => [m[0] * i + m[1] * j + m[3], m[4] * i + m[5] * j + m[7]];
    const [lon, lat] = at(100, 100);
    const [tl, ta] = truth(400, 600);
    expect(lon).toBeCloseTo(tl, 4);
    expect(lat).toBeCloseTo(ta, 4);
  });

  it('reads the CRS of the points from the GeoKeys', () => {
    expect(geoKeysCrs([1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326])).toBe('EPSG:4326');
    expect(geoKeysCrs([1, 1, 0, 2, 1024, 0, 1, 1, 3072, 0, 1, 32654])).toBe('EPSG:32654');
    expect(geoKeysCrs([1, 1, 0, 1, 1024, 0, 1, 1])).toBeNull();
  });
});
