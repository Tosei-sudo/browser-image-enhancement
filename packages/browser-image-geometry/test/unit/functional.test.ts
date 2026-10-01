import { describe, expect, it } from 'vitest';
import {
  affine,
  crop,
  fitTransform,
  flip,
  identity,
  projective,
  resize,
  rotate,
  warpImageData,
  type CoordinateTransform,
} from '../../src/index.js';
import { makeImage, maxDiff, noiseImage, pixel, smoothImage } from '../helpers.js';

describe('resampling', () => {
  for (const resample of ['nearest', 'bilinear', 'bicubic'] as const) {
    it(`identity is exact with ${resample}, including partial alpha`, () => {
      const img = noiseImage(23, 17);
      // Fully transparent pixels come back as 0,0,0,0 (their color is meaningless).
      const expected = Uint8ClampedArray.from(img.data);
      for (let i = 0; i < expected.length; i += 4) if (expected[i + 3] === 0) expected.fill(0, i, i + 4);
      const out = warpImageData(img, identity(), { resample });
      expect(out.width).toBe(23);
      expect(out.height).toBe(17);
      expect(maxDiff(out.image.data, expected)).toBeLessThanOrEqual(1);
    });
  }

  it('interpolates on premultiplied alpha, so transparent neighbours do not tint', () => {
    const img = makeImage(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 255, 0, 0]));
    // Sample halfway between the two pixel centers.
    const out = warpImageData(img, affine([1, 0, -0.5, 0, 1, 0]), { extent: [0, 0, 1, 1], width: 1, height: 1, resample: 'bilinear' });
    expect(pixel(out.image, 0, 0)).toEqual([255, 0, 0, 128]);
  });

  it('fills outside the source with the background', () => {
    const img = makeImage(4, 4, () => [10, 20, 30, 255]);
    const out = warpImageData(img, identity(), { extent: [-2, 0, 4, 4], width: 6, height: 4, background: [200, 100, 0, 255] });
    expect(pixel(out.image, 0, 0)).toEqual([200, 100, 0, 255]);
    expect(pixel(out.image, 4, 2)).toEqual([10, 20, 30, 255]);
  });

  it('keeps monochrome images gray', () => {
    const img = makeImage(30, 20, (x, y) => {
      const v = (x * 7 + y * 13) % 256;
      return [v, v, v, 255];
    });
    for (const resample of ['nearest', 'bilinear', 'bicubic'] as const) {
      const out = rotate(img, 17, { resample });
      for (let i = 0; i < out.data.length; i += 4) {
        expect(out.data[i]).toBe(out.data[i + 1]);
        expect(out.data[i]).toBe(out.data[i + 2]);
      }
    }
  });
});

describe('rotate, flip, crop, resize', () => {
  const img = noiseImage(7, 4, true);

  it('rotates quarter turns exactly', () => {
    const r90 = rotate(img, 90, { resample: 'bicubic' });
    expect([r90.width, r90.height]).toEqual([4, 7]);
    // Clockwise: the top-left pixel ends up top-right.
    expect(pixel(r90, 3, 0)).toEqual(pixel(img, 0, 0));
    expect(pixel(r90, 0, 6)).toEqual(pixel(img, 6, 3));
    const r180 = rotate(img, 180);
    expect(Array.from(r180.data)).toEqual(Array.from(flip(img, 'both').data));
    expect(Array.from(rotate(img, -270).data)).toEqual(Array.from(r90.data));
    expect(Array.from(rotate(img, 360).data)).toEqual(Array.from(img.data));
  });

  it('expands to fit other angles, or keeps the size', () => {
    const big = smoothImage(100, 50);
    const r = rotate(big, 30);
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    expect(r.width).toBe(Math.ceil(100 * c + 50 * s - 1e-6));
    expect(r.height).toBe(Math.ceil(100 * s + 50 * c - 1e-6));
    expect(pixel(r, 0, 0)[3]).toBe(0);
    const kept = rotate(big, 30, { expand: false });
    expect([kept.width, kept.height]).toEqual([100, 50]);
  });

  it('flips and crops exactly', () => {
    expect(pixel(flip(img), 0, 1)).toEqual(pixel(img, 6, 1));
    expect(pixel(flip(img, 'vertical'), 2, 0)).toEqual(pixel(img, 2, 3));
    const c = crop(img, { x: 2, y: 1, width: 3, height: 2 });
    expect([c.width, c.height]).toEqual([3, 2]);
    expect(pixel(c, 2, 1)).toEqual(pixel(img, 4, 2));
    expect(() => crop(img, { x: 5, y: 0, width: 3, height: 1 })).toThrow(RangeError);
  });

  it('resizes; nearest doubling repeats pixels', () => {
    const up = resize(img, 14, 8, { resample: 'nearest' });
    expect(pixel(up, 5, 3)).toEqual(pixel(img, 2, 1));
    expect(pixel(up, 4, 2)).toEqual(pixel(img, 2, 1));
  });

  it('shrinks large factors without aliasing', () => {
    // A one-pixel checkerboard averages to mid gray; plain bilinear would pick only black or white.
    const checker = makeImage(256, 256, (x, y) => ((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const small = resize(checker, 16, 16);
    for (let i = 0; i < small.data.length; i += 4) expect(Math.abs(small.data[i] - 128)).toBeLessThanOrEqual(2);
  });
});

describe('georeferencing', () => {
  it('places the output in map coordinates, north up', () => {
    // 1e-4 degrees per pixel, top-left corner at (139.7, 35.7).
    const img = makeImage(40, 30, (x, y) => (x === 10 && y === 20 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const points = [
      [0, 0],
      [40, 0],
      [0, 30],
      [40, 30],
    ].map(([x, y]) => ({ pixel: [x, y] as [number, number], world: [139.7 + x * 1e-4, 35.7 - y * 1e-4] as [number, number] }));
    const fit = fitTransform(points, { model: 'affine' });
    const out = warpImageData(img, fit.transform, { resample: 'nearest' });
    expect([out.width, out.height]).toEqual([40, 30]);
    const [x0, px, , y0, , py] = out.geoTransform;
    expect(x0).toBeCloseTo(139.7, 9);
    expect(y0).toBeCloseTo(35.7, 9);
    expect(px).toBeCloseTo(1e-4, 12);
    expect(py).toBeCloseTo(-1e-4, 12);
    expect(out.extent[0]).toBeCloseTo(139.7, 9);
    expect(out.extent[1]).toBeCloseTo(35.697, 9);
    expect(pixel(out.image, 10, 20)).toEqual([255, 0, 0, 255]);
  });

  it('respects an explicit extent and pixel size', () => {
    const img = smoothImage(20, 20);
    const out = warpImageData(img, identity(), { extent: [5, 5, 15, 10], pixelSize: 0.5 });
    expect([out.width, out.height]).toEqual([20, 10]);
    expect(out.extent).toEqual([5, 5, 15, 10]);
  });

  it('corrects a keystone with a projective transform', () => {
    // A square drawn as a trapezoid; mapping the corners back gives a uniform square.
    const img = makeImage(100, 100, (x, y) => {
      const inset = (y / 100) * 20;
      return x >= 20 - inset && x < 80 + inset && y >= 10 && y < 90 ? [255, 255, 255, 255] : [0, 0, 0, 255];
    });
    const fit = fitTransform(
      [
        { pixel: [20, 10], world: [0, 0] },
        { pixel: [80, 10], world: [60, 0] },
        { pixel: [2, 90], world: [0, 60] },
        { pixel: [98, 90], world: [60, 60] },
      ],
      { model: 'projective', target: 'image' },
    );
    const out = warpImageData(img, fit.transform, { extent: [0, 0, 60, 60], width: 60, height: 60 });
    let dark = 0;
    for (let y = 3; y < 57; y++) for (let x = 3; x < 57; x++) if (pixel(out.image, x, y)[0] < 128) dark++;
    expect(dark).toBe(0);
    expect(projective).toBeTypeOf('function');
  });

  it('approximates a coordinate transform with a grid', () => {
    // Longitude/latitude to Web Mercator metres.
    const R = 6378137;
    const mercator: CoordinateTransform = {
      forward: ([lon, lat]) => [(R * lon * Math.PI) / 180, R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))],
      inverse: ([x, y]) => [(x / R) * (180 / Math.PI), (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI)],
    };
    const img = smoothImage(200, 160);
    // A large area (20° × 16°) so the projection is visibly non-linear.
    const t = affine([0.1, 0, 130, 0, -0.1, 50], { yUp: true });
    const coarse = warpImageData(img, t, { coordinateTransform: mercator, gridStep: 64 });
    const exact = warpImageData(img, t, { coordinateTransform: mercator, gridStep: 1 });
    expect([coarse.width, coarse.height]).toEqual([exact.width, exact.height]);
    // Within the 0.125 px tolerance: colors barely move; edge coverage moves by at most ~0.125 × 255.
    const a = coarse.image.data;
    const b = exact.image.data;
    let color = 0;
    let alpha = 0;
    for (let i = 0; i < a.length; i += 4) {
      alpha = Math.max(alpha, Math.abs(a[i + 3] - b[i + 3]));
      if (a[i + 3] === 255 && b[i + 3] === 255) for (let c = 0; c < 3; c++) color = Math.max(color, Math.abs(a[i + c] - b[i + c]));
    }
    expect(color).toBeLessThanOrEqual(1);
    expect(alpha).toBeLessThanOrEqual(32);
    // The output extent is in metres.
    expect(coarse.extent[0]).toBeCloseTo((R * 130 * Math.PI) / 180, 0);
  });

  it('rejects bad options', () => {
    const img = smoothImage(4, 4);
    expect(() => warpImageData(img, identity(), { resample: 'lanczos' as never })).toThrow(TypeError);
    expect(() => warpImageData(img, identity(), { extent: [0, 0, 0, 1] })).toThrow(RangeError);
    expect(() => warpImageData(img, identity(), { pixelSize: -1 })).toThrow(RangeError);
    expect(() => warpImageData(img, { type: 'polynomial', order: 2 } as never)).toThrow(/forward/);
  });
});
