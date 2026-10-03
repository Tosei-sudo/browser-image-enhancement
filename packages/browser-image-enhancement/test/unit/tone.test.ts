import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { compile, processPixels } from '../../src/core/process.js';
import { curveFunction, normalizeCurve } from '../../src/ops/curve.js';
import { normalizeOp } from '../../src/ops/index.js';
import { curve, highlights, pipeline, sampleColor, shadows, tint, whiteBalance } from '../../src/index.js';
import type { ImageDataLike, OpSpec } from '../../src/types.js';
import { grayImage, image, noiseImage } from '../helpers.js';

let warnSpy: MockInstance;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warnSpy.mockRestore());

/** One pixel per gray level 0..255. */
const ramp: ImageDataLike = image(256, 1, (x) => [x, x, x, 255]);
const pixel = (r: number, g: number, b: number): ImageDataLike => image(1, 1, () => [r, g, b, 255]);
const levelsOf = (img: ImageData) => Array.from({ length: img.width }, (_, x) => img.data[x * 4]);
const rising = (v: number[]) => v.every((x, i) => i === 0 || x >= v[i - 1]);

describe('curves', () => {
  it('normalizes points: sorted, clamped, with the ends added', () => {
    expect(normalizeCurve('c', [[0.7, 0.8], [0.3, 0.2]])).toEqual([[0, 0], [0.3, 0.2], [0.7, 0.8], [1, 1]]);
    expect(normalizeCurve('c', [[-1, 2], [1, 0.5]])).toEqual([[0, 1], [1, 0.5]]);
    expect(normalizeCurve('c', [[0.5, 0.5], 'x' as never])).toEqual([[0, 0], [0.5, 0.5], [1, 1]]);
  });

  it('goes through its points, rises where they rise and never overshoots', () => {
    const pts = normalizeCurve('c', [[0.1, 0.4], [0.2, 0.45], [0.6, 0.5], [0.9, 0.98]]);
    const f = curveFunction(pts);
    for (const [x, y] of pts) expect(f(x)).toBeCloseTo(y, 12);
    const ys = Array.from({ length: 1001 }, (_, i) => f(i / 1000));
    expect(rising(ys)).toBe(true);
    for (let i = 0; i < pts.length - 1; i++) {
      for (let x = pts[i][0]; x <= pts[i + 1][0]; x += 0.001) {
        expect(f(x)).toBeGreaterThanOrEqual(pts[i][1] - 1e-12);
        expect(f(x)).toBeLessThanOrEqual(pts[i + 1][1] + 1e-12);
      }
    }
  });

  it('maps gray levels through the curve for all channels', () => {
    const out = levelsOf(curve(ramp, { points: [[0.5, 0.75]] }));
    expect(out[0]).toBe(0);
    expect(out[255]).toBe(255);
    expect(out[128]).toBe(Math.round(curveFunction(normalizeCurve('c', [[0.5, 0.75]]))(128 / 255) * 255));
    expect(rising(out)).toBe(true);
    expect(curve(ramp, {}).data).toEqual(ramp.data);
  });

  it('applies a channel curve to that channel only, and ignores it on monochrome images', () => {
    const red = curve(pixel(100, 100, 100), { red: [[0.5, 0.8]] }, { colorMode: 'rgb' }).data;
    expect(red[0]).toBeGreaterThan(100);
    expect([red[1], red[2]]).toEqual([100, 100]);
    expect(curve(grayImage(8, 8), { red: [[0.5, 0.8]] }).data).toEqual(grayImage(8, 8).data);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('red, green and blue curves'));
  });
});

describe('shadows and highlights', () => {
  it('lift or darken their own range, keep black and white, and stay rising', () => {
    for (const amount of [-1, -0.4, 0.5, 1]) {
      for (const [f, low, high] of [
        [shadows, 64, 220],
        [highlights, 220, 64],
      ] as const) {
        const out = levelsOf(f(ramp, amount));
        expect(out[0]).toBe(0);
        expect(out[255]).toBe(255);
        expect(rising(out)).toBe(true);
        expect(Math.sign(out[low] - low)).toBe(Math.sign(amount));
        // The other end of the scale barely moves.
        expect(Math.abs(out[high] - high)).toBeLessThan(Math.abs(out[low] - low));
      }
    }
  });
});

describe('tint and white balance', () => {
  it('tint moves gray toward magenta or green and keeps white at the same luminance', () => {
    const [mr, mg, mb] = tint(pixel(128, 128, 128), 0.6, { colorMode: 'rgb' }).data;
    expect(mr).toBeGreaterThan(mg);
    expect(mb).toBeGreaterThan(mg);
    const [gr, gg] = tint(pixel(128, 128, 128), -0.6, { colorMode: 'rgb' }).data;
    expect(gg).toBeGreaterThan(gr);
  });

  it('white balance makes the gray point neutral', () => {
    const cast = pixel(150, 128, 95);
    const [r, g, b] = sampleColor(cast, 0, 0)!;
    const [or, og, ob] = whiteBalance(cast, { r, g, b }).data;
    expect(Math.abs(or - og)).toBeLessThanOrEqual(1);
    expect(Math.abs(ob - og)).toBeLessThanOrEqual(1);
    expect(whiteBalance(cast, { r: 0.3, g: 0.3, b: 0.3 }).data).toEqual(cast.data);
  });

  it('sampleColor averages in linear light and skips transparent pixels', () => {
    const img = image(3, 1, (x) => (x === 0 ? [0, 0, 0, 255] : x === 1 ? [255, 255, 255, 255] : [10, 20, 30, 0]));
    const [r] = sampleColor(img, 1, 0, { radius: 1 })!;
    expect(r).toBeCloseTo(0.7353569, 5); // encoded value of linear 0.5
    expect(sampleColor(img, 2, 0, { radius: 0 })).toBeNull();
    expect(sampleColor(img, 50, 50)).toBeNull();
  });
});

describe('the new steps in the engine', () => {
  const ops: OpSpec[] = [
    { op: 'whiteBalance', r: 0.6, g: 0.5, b: 0.45 },
    { op: 'tint', amount: 0.3 },
    { op: 'shadows', amount: 0.7 },
    { op: 'saturation', amount: 0.2 },
    { op: 'highlights', amount: -0.6 },
    { op: 'curve', points: [[0.3, 0.25], [0.7, 0.8]], red: [[0.5, 0.55]] } as unknown as OpSpec,
  ];

  it('give the same result with and without folding into tables', () => {
    const img = noiseImage(64, 64, 4);
    for (const mode of ['rgb', 'gray'] as const) {
      const run = (fuse: boolean) => {
        const out = new Uint8ClampedArray(img.data.length);
        processPixels(img.data, out, compile(ops.map(normalizeOp), mode, { fuse }));
        return out;
      };
      expect(run(true)).toEqual(run(false));
    }
  });

  it('round-trip through JSON and work in a pipeline with autoStretch after them', async () => {
    const p = pipeline().curve({ points: [[0.5, 0.6]] }).shadows(0.3).tint(0.1).whiteBalance({ r: 0.5, g: 0.5, b: 0.4 }).highlights(-0.2).autoStretch();
    expect(pipeline.fromJSON(JSON.stringify(p)).ops).toEqual(p.ops);
    const img = noiseImage(32, 32, 9);
    expect((await p.run(img, { worker: false })).data).toEqual(p.runSync(img).data);
  });

  it('can be set from controls', () => {
    const p = pipeline().set('shadows', 0.5).set('whiteBalance', { b: 0.4 }).set('curve', { points: [[0.5, 0.7]] });
    expect(p.get('shadows')?.amount).toBe(0.5);
    expect(p.get('whiteBalance')).toEqual({ op: 'whiteBalance', r: 0.5, g: 0.5, b: 0.4 });
    expect(p.get('curve')?.points).toEqual([[0, 0], [0.5, 0.7], [1, 1]]);
  });
});

describe('presets', () => {
  it('are pipelines that run on color and monochrome images', async () => {
    const { presets, autoEnhance } = await import('../../src/index.js');
    for (const [name, p] of Object.entries(presets)) {
      expect(p.ops.length, name).toBeGreaterThan(0);
      const out = p.runSync(noiseImage(24, 16, 3));
      expect(out.width, name).toBe(24);
      p.runSync(grayImage(8, 8));
    }
    const img = noiseImage(20, 20, 2);
    expect((await autoEnhance(img, { worker: false })).data).toEqual(presets.auto.runSync(img).data);
    expect(Object.isFrozen(presets)).toBe(true);
  });

  it('do not warn about step order', async () => {
    const { presets } = await import('../../src/index.js');
    warnSpy.mockClear();
    for (const p of Object.values(presets)) p.runSync(noiseImage(8, 8));
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
