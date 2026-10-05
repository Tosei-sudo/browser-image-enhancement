import { describe, expect, it } from 'vitest';
import { affineGeo, epsgOf, pickLevel, pixelWindow, viewScales } from '../src/view-export.js';

describe('epsgOf', () => {
  it('reads EPSG codes only', () => {
    expect(epsgOf('EPSG:3857')).toBe(3857);
    expect(epsgOf('epsg:4326')).toBe(4326);
    expect(epsgOf('urn:ogc:def:crs:EPSG::3857')).toBeNull();
    expect(epsgOf('EPSG:99999')).toBeNull();
  });
});

describe('affineGeo', () => {
  it('writes a pixel scale and tiepoint for an unrotated view', () => {
    const geo = affineGeo([100, 200], [2, 0], [0, -3], 3857, false);
    expect(geo.modelPixelScale).toEqual([2, 3, 0]);
    expect(geo.modelTiepoint).toEqual([0, 0, 0, 100, 200, 0]);
    expect(geo.modelTransformation).toBeUndefined();
    expect(geo.geoKeyDirectory).toEqual([1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 3857]);
  });

  it('writes a transformation for a rotated view', () => {
    const c = Math.cos(0.5);
    const s = Math.sin(0.5);
    const geo = affineGeo([10, 20], [c, s], [s, -c], 4326, true);
    expect(geo.modelPixelScale).toBeUndefined();
    expect(geo.modelTransformation).toEqual([c, s, 0, 10, s, -c, 0, 20, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(geo.geoKeyDirectory!.slice(4, 8)).toEqual([1024, 0, 1, 2]);
    expect(geo.geoKeyDirectory!.slice(12)).toEqual([2048, 0, 1, 4326]);
  });
});

describe('pixelWindow', () => {
  // 100 × 50 px, 10 units a pixel, top left at (1000, 2000).
  const origin = [1000, 2000];
  const resolution = [10, -10];

  it('finds the pixels under an extent', () => {
    expect(pixelWindow([1100, 1700, 1305, 1900], origin, resolution, 100, 50)).toEqual({ x: 10, y: 10, w: 21, h: 20 });
  });

  it('clips to the image', () => {
    expect(pixelWindow([0, 0, 5000, 5000], origin, resolution, 100, 50)).toEqual({ x: 0, y: 0, w: 100, h: 50 });
  });

  it('is null away from the image', () => {
    expect(pixelWindow([3000, 0, 4000, 100], origin, resolution, 100, 50)).toBeNull();
  });
});

describe('pickLevel', () => {
  const levels = [
    { width: 4000, height: 2000 },
    { width: 2000, height: 1000 },
    { width: 1000, height: 500 },
  ];

  it('reads the image itself when the clip fits', () => {
    expect(pickLevel(levels, { x: 100, y: 100, w: 400, h: 200 }, 3, 1_000_000)).toEqual({ level: 0, window: { x: 100, y: 100, w: 400, h: 200 } });
  });

  it('reads the finest overview that fits', () => {
    expect(pickLevel(levels, { x: 0, y: 0, w: 4000, h: 2000 }, 1, 2_100_000)).toEqual({ level: 1, window: { x: 0, y: 0, w: 2000, h: 1000 } });
    expect(pickLevel(levels, { x: 101, y: 3, w: 3000, h: 1000 }, 4, 1_000_000)).toEqual({ level: 2, window: { x: 25, y: 0, w: 751, h: 251 } });
  });

  it('takes the coarsest when nothing fits', () => {
    expect(pickLevel(levels, { x: 0, y: 0, w: 4000, h: 2000 }, 1, 10).level).toBe(2);
  });
});

describe('viewScales', () => {
  it('leaves out sizes past the limit', () => {
    expect(viewScales([1000, 600], 1)).toEqual([1, 2, 4]);
    expect(viewScales([1600, 900], 2)).toEqual([1, 2]);
    expect(viewScales([5000, 900], 2)).toEqual([1]);
  });
});
