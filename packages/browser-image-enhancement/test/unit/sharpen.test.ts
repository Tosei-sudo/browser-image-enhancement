import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { compile, processPixels, type ResolvedMode } from '../../src/core/process.js';
import { resolveOps } from '../../src/core/histogram.js';
import { kernelRadius, marginOf, normalizeOp } from '../../src/ops/index.js';
import { histogram, pipeline, Pipeline, sharpen } from '../../src/index.js';
import type { ImageDataLike, OpSpec } from '../../src/types.js';
import { grayImage, image, isGrayPixels, maxDiff, noiseImage, pixel, randomOps, rng } from '../helpers.js';

let warnSpy: MockInstance;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warnSpy.mockRestore());

const SHARPEN = (amount = 1, radius = 1.5, threshold = 0): OpSpec => ({ op: 'sharpen', amount, radius, threshold });

function run(img: ImageDataLike, ops: OpSpec[], mode: ResolvedMode, fuse = true): Uint8ClampedArray {
  const out = new Uint8ClampedArray(img.data.length);
  processPixels(img.data, out, compile(ops.map(normalizeOp), mode, { fuse }), img.width);
  return out;
}

/** Opaque random color image. */
function photo(width: number, height: number, seed = 1): ImageDataLike {
  const r = rng(seed);
  return image(width, height, () => [r() * 256, r() * 256, r() * 256, 255].map(Math.floor) as [number, number, number, number]);
}

/** Rows y0..y1 and columns x0..x1 of an image. */
function crop(img: ImageDataLike, x0: number, y0: number, x1: number, y1: number): ImageDataLike {
  const width = x1 - x0;
  const data = new Uint8ClampedArray(width * (y1 - y0) * 4);
  for (let y = y0; y < y1; y++) data.set(img.data.subarray((y * img.width + x0) * 4, (y * img.width + x1) * 4), (y - y0) * width * 4);
  return { data, width, height: y1 - y0 };
}

// --- An independent reference: direct 2-D Gaussian, plain formulas, sharpen as the only step. ---
function reference(img: ImageDataLike, amount: number, radius: number, threshold: number, gray: boolean): Uint8ClampedArray {
  const { width, height, data } = img;
  const R = Math.ceil(3 * radius);
  const e = (i: number) => data[i] / 255;
  const luma = (j: number) => (gray ? e(j * 4) : 0.2126 * e(j * 4) + 0.7152 * e(j * 4 + 1) + 0.0722 * e(j * 4 + 2));
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const j = y * width + x;
      let num = 0;
      let den = 0;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          const w = Math.exp(-(dx * dx + dy * dy) / (2 * radius * radius)) * (data[(yy * width + xx) * 4 + 3] / 255);
          num += w * luma(yy * width + xx);
          den += w;
        }
      }
      const diff = luma(j) - num / den;
      const d = data[j * 4 + 3] === 0 || Math.abs(diff) < threshold ? 0 : amount * diff;
      for (let c = 0; c < 3; c++) out[j * 4 + c] = Math.round(Math.min(1, Math.max(0, e(j * 4 + (gray ? 0 : c)) + d)) * 255);
      out[j * 4 + 3] = data[j * 4 + 3];
    }
  }
  return out;
}

describe('sharpen parameters', () => {
  it('fills defaults and clamps with a warning', () => {
    expect(normalizeOp({ op: 'sharpen' })).toEqual({ op: 'sharpen', amount: 0.5, radius: 1, threshold: 0 });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(normalizeOp({ op: 'sharpen', amount: 9, radius: 0, threshold: -1 })).toEqual({ op: 'sharpen', amount: 5, radius: 0.1, threshold: 0 });
    expect(normalizeOp({ op: 'sharpen', radius: 80 })).toMatchObject({ radius: 50 });
    expect(warnSpy).toHaveBeenCalledTimes(4);
  });

  it('margin is the reach of every sharpen step together', () => {
    expect(kernelRadius(1)).toBe(3);
    expect(kernelRadius(0.1)).toBe(1);
    expect(marginOf([])).toBe(0);
    expect(pipeline().exposure(1).margin).toBe(0);
    expect(pipeline().sharpen().margin).toBe(3);
    expect(pipeline().sharpen({ radius: 2 }).contrast(0.2).sharpen({ radius: 0.5 }).margin).toBe(6 + 2);
    expect(pipeline().sharpen({ amount: 0 }).margin).toBe(0);
  });

  it('survives toJSON / fromJSON', () => {
    const p = pipeline().exposure(0.2).sharpen({ amount: 1.2, radius: 2, threshold: 0.01 });
    const back = Pipeline.fromJSON(JSON.stringify(p.toJSON()));
    expect(back.ops).toEqual(p.ops);
  });
});

describe('sharpen', () => {
  it('matches a direct 2-D unsharp mask', () => {
    for (const [amount, radius, threshold] of [[1, 1, 0], [2.5, 0.6, 0], [0.8, 2.2, 0.03]]) {
      const img = photo(23, 19, 3);
      const out = run(img, [SHARPEN(amount, radius, threshold)], 'rgb');
      expect(maxDiff(out, reference(img, amount, radius, threshold, false))).toBeLessThanOrEqual(1);
      const g = grayImage(23, 19, 4);
      const gout = run(g, [SHARPEN(amount, radius, threshold)], 'gray');
      expect(maxDiff(gout, reference(g, amount, radius, threshold, true))).toBeLessThanOrEqual(1);
    }
  });

  it('steepens an edge: the dark side gets darker and the bright side brighter', () => {
    const img = image(20, 4, (x) => (x < 10 ? [60, 60, 60, 255] : [180, 180, 180, 255]));
    const out = { data: sharpen(img, { amount: 1, radius: 1 }).data, width: 20, height: 4 };
    expect(pixel(out, 9, 1)[0]).toBeLessThan(60);
    expect(pixel(out, 10, 1)[0]).toBeGreaterThan(180);
    // Far from the edge nothing changes.
    expect(pixel(out, 0, 1)).toEqual([60, 60, 60, 255]);
    expect(pixel(out, 19, 1)).toEqual([180, 180, 180, 255]);
  });

  it('leaves flat images, amount 0 and differences under the threshold unchanged', () => {
    const flat = image(16, 16, () => [90, 140, 200, 255]);
    expect(sharpen(flat, { amount: 3, radius: 2 }).data).toEqual(flat.data);
    const img = photo(16, 16, 9);
    expect(sharpen(img, { amount: 0 }).data).toEqual(img.data);
    expect(sharpen(img, { amount: 3, threshold: 1 }).data).toEqual(img.data);
  });

  it('threshold keeps small differences and sharpens large ones', () => {
    // A faint ripple next to a strong edge.
    const img = image(30, 3, (x) => (x < 15 ? [100 + (x % 2) * 2, 100, 100, 255] : [220, 220, 220, 255]));
    const out = { data: sharpen(img, { amount: 2, radius: 1, threshold: 0.05 }).data, width: 30, height: 3 };
    expect(pixel(out, 3, 1)).toEqual(pixel(img, 3, 1));
    expect(pixel(out, 15, 1)[0]).toBeGreaterThan(220);
  });

  it('adds the same change to R, G and B, so gray stays gray and colors do not fringe', () => {
    const g = grayImage(20, 20, 2);
    const opaque = { ...g, data: g.data.map((v, i) => (i % 4 === 3 ? 255 : v)) };
    const out = run(opaque, [SHARPEN(2, 1)], 'rgb');
    expect(isGrayPixels(out)).toBe(true);
    // Computed as gray or as rgb, a monochrome image gives the same result.
    expect(run(opaque, [SHARPEN(2, 1)], 'gray')).toEqual(out);
    // A pure-hue edge (equal luminance contribution changes on all channels): hue differences stay.
    const img = image(10, 2, (x) => (x < 5 ? [200, 50, 50, 255] : [100, 50, 50, 255]));
    const s = { data: sharpen(img, { amount: 1 }).data, width: 10, height: 2 };
    const [r4, g4, b4] = pixel(s, 4, 0);
    expect(g4).toBe(b4);
    expect(r4 - g4).toBeGreaterThan(100);
  });

  it('works on monochrome images in auto mode', () => {
    const g = grayImage(24, 24, 5);
    const out = sharpen(g, { amount: 1.5 });
    expect(isGrayPixels(out.data)).toBe(true);
    expect(out.data).not.toEqual(g.data);
  });

  it('ignores the color of transparent pixels and leaves them unchanged', () => {
    const a = image(20, 20, (x, y) => (x > 12 ? [0, 0, 0, 0] : [(x * 17 + y * 5) % 256, (x * 3) % 256, (y * 11) % 256, 255]));
    const b = { ...a, data: a.data.slice() };
    for (let i = 0; i < b.data.length; i += 4) if (b.data[i + 3] === 0) b.data.set([255, 200, 13, 0], i);
    const oa = sharpen(a, { amount: 2, radius: 2 }, { colorMode: 'rgb' }).data;
    const ob = sharpen(b, { amount: 2, radius: 2 }, { colorMode: 'rgb' }).data;
    for (let i = 0; i < oa.length; i += 4) {
      if (a.data[i + 3] === 0) {
        expect(Array.from(ob.subarray(i, i + 4))).toEqual([255, 200, 13, 0]);
      } else {
        expect(Array.from(ob.subarray(i, i + 4))).toEqual(Array.from(oa.subarray(i, i + 4)));
      }
    }
  });

  it('keeps alpha and can process in place', () => {
    const img = noiseImage(30, 20, 4);
    const ops = [{ op: 'exposure', ev: 0.3 }, SHARPEN(1.2, 1.3), { op: 'saturation', amount: 0.4 }].map(normalizeOp);
    const expected = run(img, ops, 'rgb');
    for (let i = 3; i < expected.length; i += 4) expect(expected[i]).toBe(img.data[i]);
    const data = img.data.slice();
    processPixels(data, data, compile(ops, 'rgb'), img.width);
    expect(data).toEqual(expected);
  });

  it('needs the image width', () => {
    const p = compile([normalizeOp(SHARPEN())], 'rgb');
    expect(() => processPixels(new Uint8ClampedArray(16), new Uint8ClampedArray(16), p)).toThrow(RangeError);
    expect(() => processPixels(new Uint8ClampedArray(16), new Uint8ClampedArray(16), p, 3)).toThrow(RangeError);
  });

  it('runs the steps around it in one pass, as in a pipeline', () => {
    // Mid-range values with some texture, so no step clips (clipping is where the two differ most).
    const img = image(20, 20, (x, y) => [60 + x * 3 + (y % 3) * 4, 70 + y * 3, 80 + ((x * y) % 7) * 3, 255]);
    const p = pipeline().exposure(0.3).sharpen({ amount: 0.6 }).contrast(0.2);
    const once = p.runSync(img).data;
    // Not the same as rounding to 8 bits between steps, but within a code or two.
    const stepwise = pipeline().contrast(0.2).runSync(sharpen(pipeline().exposure(0.3).runSync(img), { amount: 0.6 })).data;
    expect(once).not.toEqual(img.data);
    expect(maxDiff(once, stepwise)).toBeLessThanOrEqual(3);
  });

  it('autoStretch after sharpen warns that sharpening is not in the statistics', () => {
    const img = photo(10, 10);
    resolveOps([normalizeOp(SHARPEN()), normalizeOp({ op: 'autoStretch' })], histogram(img));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('autoStretch after sharpen'));
  });
});

describe('folding steps around sharpen changes nothing', () => {
  const r = rng(77);
  const img = noiseImage(40, 30, 12);
  for (let t = 0; t < 30; t++) {
    // Random steps with one or two sharpens at random places.
    const ops = randomOps(r);
    const count = 1 + Math.floor(r() * 2);
    for (let k = 0; k < count; k++) ops.splice(Math.floor(r() * (ops.length + 1)), 0, SHARPEN(r() * 3, 0.3 + r() * 2, r() < 0.3 ? r() * 0.05 : 0));
    it(`chain #${t}: ${ops.map((o) => o.op).join(' > ')}`, () => {
      for (const mode of ['rgb', 'gray'] as const) expect(run(img, ops, mode, true)).toEqual(run(img, ops, mode, false));
    });
  }
});

describe('tiles with a margin match the whole image exactly', () => {
  const ops = [
    { op: 'exposure', ev: 0.4 },
    SHARPEN(1.5, 1.2, 0.01),
    { op: 'saturation', amount: 0.3 },
    SHARPEN(0.7, 2.5),
    { op: 'levels', inBlack: 0.05, inWhite: 0.9 },
  ].map(normalizeOp);
  const m = marginOf(ops);

  for (const [name, img] of [
    ['color with transparency', noiseImage(64, 48, 21)],
    ['opaque color', photo(64, 48, 22)],
  ] as const) {
    it(name, () => {
      const whole = run(img, ops, 'rgb');
      const W = { data: whole, width: img.width, height: img.height };
      // Inner tiles, tiles at the image edges and corners, odd sizes.
      for (const [x0, y0, x1, y1] of [[20, 15, 40, 30], [0, 0, 16, 16], [48, 32, 64, 48], [5, 0, 37, 11], [0, 30, 64, 48]]) {
        const ex = [Math.max(0, x0 - m), Math.max(0, y0 - m), Math.min(img.width, x1 + m), Math.min(img.height, y1 + m)] as const;
        const out = run(crop(img, ...ex), ops, 'rgb');
        const tile = crop({ data: out, width: ex[2] - ex[0], height: ex[3] - ex[1] }, x0 - ex[0], y0 - ex[1], x1 - ex[0], y1 - ex[1]);
        expect(tile.data).toEqual(crop(W, x0, y0, x1, y1).data);
      }
    });
  }

  it('padding outside the image with transparent pixels changes nothing', () => {
    // This is how a tile at the edge of a tiled image is given its margin.
    const img = photo(30, 20, 5);
    const padded = image(30 + 2 * m, 20 + 2 * m, (x, y) => {
      const sx = x - m;
      const sy = y - m;
      return sx < 0 || sy < 0 || sx >= 30 || sy >= 20 ? [0, 0, 0, 0] : (pixel(img, sx, sy) as [number, number, number, number]);
    });
    const out = run(padded, ops, 'rgb');
    expect(crop({ data: out, width: padded.width, height: padded.height }, m, m, m + 30, m + 20).data).toEqual(run(img, ops, 'rgb'));
  });
});
