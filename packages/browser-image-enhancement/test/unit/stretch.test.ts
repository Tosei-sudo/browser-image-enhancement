import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { linearToSrgb, SRGB_TO_LINEAR } from '../../src/color/srgb.js';
import { resolveOps } from '../../src/core/histogram.js';
import { normalizeOp, toStage, type ChannelFn } from '../../src/ops/index.js';
import {
  autoStretch,
  computeStretch,
  exposure,
  histogram,
  mergeHistograms,
  pipeline,
  Pipeline,
  stretch,
  type Histogram,
  type OpSpec,
} from '../../src/index.js';
import { copy, grayImage, image, isGrayPixels, maxDiff, noiseImage, pixel, rampImage, rng } from '../helpers.js';

let warnSpy: MockInstance;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warnSpy.mockRestore());

/** An image whose R, G, B values are drawn uniformly from the given code ranges. */
function rangedImage(w: number, h: number, ranges: Array<[number, number]>, seed = 1) {
  const r = rng(seed);
  return image(w, h, () => {
    const [rr, gg, bb] = ranges.map(([lo, hi]) => lo + Math.floor(r() * (hi - lo + 1)));
    return [rr, gg, bb, 255];
  });
}

/** Values in sorted order: the reference for percentiles. */
function sorted(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

describe('stretch op', () => {
  it('normalizes one number to all channels and fills defaults', () => {
    expect(normalizeOp({ op: 'stretch', black: 0.1 })).toEqual({ op: 'stretch', black: [0.1, 0.1, 0.1], white: [1, 1, 1] });
    expect(normalizeOp({ op: 'stretch', black: [0.1, 0.2, 0.3], white: [0.7, 0.8, 0.9] })).toEqual({
      op: 'stretch',
      black: [0.1, 0.2, 0.3],
      white: [0.7, 0.8, 0.9],
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('leaves a channel unchanged when white is not above black, with a warning', () => {
    const op = normalizeOp({ op: 'stretch', black: [0.5, 0.1, 0.2], white: [0.4, 0.9, 0.2] });
    expect(op).toEqual({ op: 'stretch', black: [0, 0.1, 0], white: [1, 0.9, 1] });
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('clamps out-of-range and repairs malformed values', () => {
    const op = normalizeOp({ op: 'stretch', black: -1, white: [0.9, 'x', 2] } as never);
    expect(op).toEqual({ op: 'stretch', black: [0, 0, 0], white: [0.9, 1, 2] });
    expect(warnSpy).toHaveBeenCalled();
  });

  it('maps black..white to 0..255 linearly in sRGB codes and clips outside', () => {
    const img = image(256, 1, (x) => [x, x, x, 255]);
    const out = stretch(img, { black: 0.2, white: 0.8 }, { colorMode: 'rgb' });
    for (let k = 0; k < 256; k++) {
      const x = Math.min(1, Math.max(0, (k / 255 - 0.2) / 0.6));
      expect(out.data[k * 4]).toBe(Math.round(x * 255));
    }
  });

  it('stretches each channel with its own points', () => {
    const img = rampImage();
    const out = stretch(img, { black: [0.1, 0.2, 0.3], white: [0.5, 0.9, 1] });
    for (const [x, y] of [[0, 0], [40, 100], [128, 200], [255, 255]]) {
      const src = pixel(img, x, y);
      const got = pixel(out, x, y);
      [0.1, 0.2, 0.3].forEach((b, c) => {
        const w = [0.5, 0.9, 1][c];
        expect(got[c]).toBe(Math.round(Math.min(1, Math.max(0, (src[c] / 255 - b) / (w - b))) * 255));
      });
      expect(got[3]).toBe(src[3]);
    }
  });

  it('a white point above 1 recovers highlights pushed past white', () => {
    const img = image(256, 1, (x) => [x, x, x, 255]);
    const over = pipeline().exposure(1).runSync(img);
    const back = pipeline().exposure(1).stretch({ white: linearToSrgb(2) }).runSync(img);
    expect(over.data[200 * 4]).toBe(255); // clipped without the stretch
    expect(back.data[200 * 4]).toBeLessThan(255);
    for (let x = 1; x < 256; x++) expect(back.data[x * 4]).toBeGreaterThanOrEqual(back.data[(x - 1) * 4]);
  });

  it('on a monochrome image uses the mean of per-channel points, stays gray, and warns', () => {
    const img = grayImage(32, 32, 3);
    const out = stretch(img, { black: [0.1, 0.2, 0.3], white: [0.7, 0.8, 0.9] });
    expect(isGrayPixels(out.data)).toBe(true);
    expect(out.data).toEqual(stretch(img, { black: 0.2, white: 0.8 }).data);
    expect(warnSpy.mock.calls.join('')).toMatch(/per-channel stretch/);
  });

  it('identity stretch is skipped', () => {
    const img = noiseImage(16, 16);
    expect(stretch(img, {}).data).toEqual(img.data);
  });
});

describe('histogram', () => {
  it('counts each channel and skips transparent pixels', () => {
    const img = image(3, 1, (x) => [[10, 20, 30, 255], [10, 50, 60, 1], [99, 99, 99, 0]][x] as [number, number, number, number]);
    const h = histogram(img);
    expect(h.mode).toBe('rgb');
    expect(h.count).toBe(2);
    expect(h.bins[0][10]).toBe(2);
    expect(h.bins[1][20]).toBe(1);
    expect(h.bins[1][50]).toBe(1);
    expect(h.bins[2][99]).toBe(0);
    expect(h.bins.map((b) => b.reduce((a, v) => a + v, 0))).toEqual([2, 2, 2]);
  });

  it('counts only inside rect, clipped to the image', () => {
    const img = image(10, 10, (x, y) => [x, y, 0, 255]);
    const h = histogram(img, { rect: { x: 2, y: 3, width: 4, height: 2 } });
    expect(h.count).toBe(8);
    for (let x = 2; x < 6; x++) expect(h.bins[0][x]).toBe(2);
    expect(h.bins[1][3]).toBe(4);
    expect(h.bins[1][4]).toBe(4);
    expect(histogram(img, { rect: { x: 8, y: 8, width: 10, height: 10 } }).count).toBe(4);
    expect(histogram(img, { rect: { x: 20, y: 0, width: 5, height: 5 } }).count).toBe(0);
    expect(histogram(img, { rect: { x: 2, y: 2, width: 0, height: 5 } }).count).toBe(0);
  });

  it('fractional rects cover every pixel they touch', () => {
    const img = image(10, 10, (x, y) => [x, y, 0, 255]);
    expect(histogram(img, { rect: { x: 1.5, y: 1.5, width: 2, height: 1 } }).count).toBe(6);
  });

  it('monochrome images give one gray channel; colored pixels count by luminance in gray mode', () => {
    const g = histogram(grayImage(8, 8, 1));
    expect(g.mode).toBe('gray');
    expect(g.bins).toHaveLength(1);
    const red = image(1, 1, () => [255, 0, 0, 255]);
    const h = histogram(red, { colorMode: 'gray' });
    expect(h.bins[0][127]).toBe(1); // Rec. 709 luminance of pure red, as gray mode computes it
  });

  it('histograms of parts add up to the histogram of the whole', () => {
    const img = noiseImage(37, 23, 4);
    const parts = [
      { x: 0, y: 0, width: 20, height: 23 },
      { x: 20, y: 0, width: 17, height: 10 },
      { x: 20, y: 10, width: 17, height: 13 },
    ].map((rect) => histogram(img, { rect }));
    const merged = mergeHistograms(parts);
    expect(merged).toEqual(histogram(img));
  });

  it('merging gray and color histograms counts gray on every channel', () => {
    const merged = mergeHistograms([histogram(grayImage(4, 4, 1)), histogram(noiseImage(4, 4, 2))]);
    expect(merged.mode).toBe('rgb');
    expect(merged.bins).toHaveLength(3);
    for (const b of merged.bins) expect(b.reduce((a, v) => a + v, 0)).toBe(merged.count);
    expect(mergeHistograms([]).count).toBe(0);
  });

  it('rejects non-images', () => {
    expect(() => histogram({ data: new Uint8ClampedArray(3), width: 1, height: 1 })).toThrow(RangeError);
  });
});

describe('computeStretch', () => {
  const ramp = image(256, 1, (x) => [x, x, x, 255]);

  it('minMax uses the darkest and brightest values per channel', () => {
    const img = rangedImage(64, 64, [[10, 100], [50, 200], [0, 255]]);
    const s = computeStretch(histogram(img), { method: 'minMax' });
    expect(s.black).toEqual([10 / 255, 50 / 255, 0]);
    expect(s.white).toEqual([100 / 255, 200 / 255, 1]);
  });

  it('percentClip discards the given share of pixels at each end', () => {
    // 256 pixels, one per code. 1 % = 2.56 pixels: black is the first code with more than
    // that many pixels at or below it (code 2), white the mirror (code 253).
    const s = computeStretch(histogram(ramp), { lowPercent: 1, highPercent: 1 });
    expect(s.black).toEqual([2 / 255, 2 / 255, 2 / 255]);
    expect(s.white).toEqual([253 / 255, 253 / 255, 253 / 255]);
    const z = computeStretch(histogram(ramp), { lowPercent: 0, highPercent: 0 });
    expect(z).toEqual(computeStretch(histogram(ramp), { method: 'minMax' }));
  });

  it('percentClip matches percentiles of the sorted values', () => {
    const img = noiseImage(50, 40, 9);
    const visible: number[][] = [[], [], []];
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i + 3] === 0) continue;
      for (let c = 0; c < 3; c++) visible[c].push(img.data[i + c] / 255);
    }
    for (const [low, high] of [[0.5, 0.5], [2, 5], [10, 0], [25, 25]]) {
      const s = computeStretch(histogram(img), { lowPercent: low, highPercent: high });
      for (let c = 0; c < 3; c++) {
        const v = sorted(visible[c]);
        const n = v.length;
        // The first value with more than low% of pixels at or below it, and the mirror for white.
        expect(s.black[c]).toBe(v[Math.floor((n * low) / 100)]);
        expect(s.white[c]).toBe(v[n - 1 - Math.floor((n * high) / 100)]);
      }
    }
  });

  it('standardDeviation uses mean ± n·σ, kept inside the data range', () => {
    const img = rangedImage(40, 40, [[60, 180], [60, 180], [60, 180]], 3);
    const values: number[] = [];
    for (let i = 0; i < img.data.length; i += 4) values.push(img.data[i] / 255);
    const mean = values.reduce((a, v) => a + v, 0) / values.length;
    const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
    const s = computeStretch(histogram(img), { method: 'standardDeviation', stdDevs: 1 });
    expect(s.black[0]).toBeCloseTo(mean - sd, 12);
    expect(s.white[0]).toBeCloseTo(mean + sd, 12);
    const wide = computeStretch(histogram(img), { method: 'standardDeviation', stdDevs: 5 });
    expect(wide.black[0]).toBe(60 / 255);
    expect(wide.white[0]).toBe(180 / 255);
  });

  it('linked uses one range for all channels', () => {
    const img = rangedImage(64, 64, [[10, 100], [50, 200], [30, 230]]);
    const s = computeStretch(histogram(img), { method: 'minMax', linked: true });
    expect(s.black).toEqual([10 / 255, 10 / 255, 10 / 255]);
    expect(s.white).toEqual([230 / 255, 230 / 255, 230 / 255]);
  });

  it('flat channels and empty histograms are left unchanged', () => {
    const flat = image(8, 8, () => [100, 40, 200, 255]);
    expect(computeStretch(histogram(flat))).toEqual({ black: [0, 0, 0], white: [1, 1, 1] });
    const clear = image(8, 8, () => [100, 40, 200, 0]);
    expect(computeStretch(histogram(clear))).toEqual({ black: [0, 0, 0], white: [1, 1, 1] });
    const partly = image(2, 1, (x) => [x * 100, 40, 200, 255]);
    expect(computeStretch(histogram(partly), { method: 'minMax' })).toEqual({ black: [0, 0, 0], white: [100 / 255, 1, 1] });
  });

  it('a gray histogram gives the same point on every channel', () => {
    const s = computeStretch(histogram(grayImage(32, 32, 2)), { method: 'minMax' });
    expect(new Set(s.black).size).toBe(1);
    expect(new Set(s.white).size).toBe(1);
  });
});

describe('autoStretch', () => {
  it('normalizes options with defaults and warns on bad ones', () => {
    expect(normalizeOp({ op: 'autoStretch' })).toEqual({
      op: 'autoStretch',
      method: 'percentClip',
      lowPercent: 0.5,
      highPercent: 0.5,
      stdDevs: 2,
      linked: false,
    });
    expect(warnSpy).not.toHaveBeenCalled();
    const bad = normalizeOp({ op: 'autoStretch', method: 'magic', lowPercent: 80 } as never);
    expect(bad).toMatchObject({ method: 'percentClip', lowPercent: 50 });
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('equals a stretch with the range computed from the image', () => {
    const img = rangedImage(64, 48, [[30, 160], [20, 140], [70, 250]], 5);
    for (const options of [{}, { method: 'minMax' as const }, { method: 'standardDeviation' as const }, { linked: true }]) {
      const expected = stretch(img, computeStretch(histogram(img), options));
      expect(autoStretch(img, options).data).toEqual(expected.data);
    }
  });

  it('fills the full range: minMax maps the darkest pixel to 0 and the brightest to 255', () => {
    const img = rangedImage(64, 64, [[40, 120], [40, 120], [40, 120]], 6);
    const out = autoStretch(img, { method: 'minMax', linked: true });
    let lo = 255;
    let hi = 0;
    for (let i = 0; i < out.data.length; i += 4) {
      lo = Math.min(lo, out.data[i]);
      hi = Math.max(hi, out.data[i]);
    }
    expect([lo, hi]).toEqual([0, 255]);
  });

  it('ignores transparent pixels (nodata)', () => {
    // Dark nodata border with alpha 0 around a bright interior.
    const img = image(20, 20, (x, y) => (x < 4 ? [0, 0, 0, 0] : [100 + ((x + y) % 50), 100 + ((x + y) % 50), 100 + ((x + y) % 50), 255]));
    const s = computeStretch(histogram(img), { method: 'minMax' });
    expect(s.black[0]).toBe(104 / 255); // the darkest visible pixel, not the black border
    const out = autoStretch(img, { method: 'minMax' });
    expect(pixel(out, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('removes a color cast when channels are independent, keeps it when linked', () => {
    const img = rangedImage(32, 32, [[80, 255], [40, 215], [0, 175]], 7);
    const meanOf = (data: Uint8ClampedArray, c: number) => {
      let s = 0;
      for (let i = c; i < data.length; i += 4) s += data[i];
      return s / (data.length / 4);
    };
    const free = autoStretch(img, { method: 'minMax' }).data;
    expect(Math.abs(meanOf(free, 0) - meanOf(free, 2))).toBeLessThan(10);
    const linked = autoStretch(img, { method: 'minMax', linked: true }).data;
    expect(meanOf(linked, 0) - meanOf(linked, 2)).toBeGreaterThan(50);
  });

  it('monochrome input stays monochrome; forced gray uses luminance', () => {
    const gray = grayImage(40, 30, 8);
    expect(isGrayPixels(autoStretch(gray).data)).toBe(true);
    const color = noiseImage(40, 30, 8);
    const out = autoStretch(color, {}, { colorMode: 'gray' });
    expect(isGrayPixels(out.data)).toBe(true);
    // Same range as the luminance image's; the luminance is just not rounded before stretching.
    const lum = pipeline().runSync(color, { colorMode: 'gray' });
    expect(histogram(color, { colorMode: 'gray' })).toEqual(histogram(lum));
    expect(maxDiff(out.data, stretch(lum, computeStretch(histogram(lum))).data)).toBeLessThanOrEqual(1);
  });

  it('a flat image is returned unchanged', () => {
    const img = image(10, 10, () => [90, 90, 90, 255]);
    expect(autoStretch(img).data).toEqual(img.data);
  });

  describe('statistics are of the image as it reaches the step', () => {
    const img = noiseImage(48, 40, 12);
    const chains: OpSpec[][] = [
      [{ op: 'exposure', ev: 0.7 }],
      [{ op: 'exposure', ev: -1.5 }, { op: 'contrast', amount: 0.4 }],
      [{ op: 'temperature', amount: 0.6 }, { op: 'gamma', gamma: 1.8 }],
      [{ op: 'levels', inBlack: 0.1, inWhite: 0.8, gamma: 1.3, outBlack: 0.05, outWhite: 0.95 }],
      [{ op: 'brightness', amount: -0.4 }, { op: 'stretch', black: [0.1, 0, 0.2], white: [0.9, 0.8, 1] }],
    ];
    chains.forEach((before, t) => {
      it(`chain #${t}: ${before.map((o) => o.op).join(' > ')}`, () => {
        // The value of every visible pixel after `before`, computed directly, without rounding.
        const fns = before.map((op) => normalizeOp(op));
        const values: number[][] = [[], [], []];
        for (let i = 0; i < img.data.length; i += 4) {
          if (img.data[i + 3] === 0) continue;
          for (let c = 0; c < 3; c++) {
            const out = pipelineValue(fns, img.data[i + c], c);
            values[c].push(out);
          }
        }
        for (const options of [{ method: 'minMax' as const }, { lowPercent: 3, highPercent: 7 }]) {
          const ops = resolveOps([...fns, normalizeOp({ op: 'autoStretch', ...options })], histogram(img));
          const s = ops[ops.length - 1] as Extract<OpSpec, { op: 'stretch' }>;
          for (let c = 0; c < 3; c++) {
            const v = sorted(values[c]);
            const n = v.length;
            const low = options.method === 'minMax' ? 0 : Math.floor((n * 3) / 100);
            const high = options.method === 'minMax' ? 0 : Math.floor((n * 7) / 100);
            expect(s.black[c]).toBeCloseTo(v[low], 12);
            expect(s.white[c]).toBeCloseTo(v[n - 1 - high], 12);
          }
        }
      });
    });

    /** One channel value through normalized ops, as the engine computes it (sRGB-encoded result). */
    function pipelineValue(ops: OpSpec[], code: number, c: number): number {
      // Run a 1-pixel image with only channel c meaningful through the engine's own stages, unrounded.
      let v = SRGB_TO_LINEAR[code];
      for (const op of ops) v = stageOf(op)(v, c);
      return linearToSrgb(v);
    }
  });

  it('after exposure: the stretch maps the exposed range back to full scale', () => {
    const img = rangedImage(40, 40, [[20, 90], [20, 90], [20, 90]], 13);
    const out = pipeline().exposure(1).autoStretch({ method: 'minMax', linked: true }).runSync(img);
    let lo = 255;
    let hi = 0;
    for (let i = 0; i < out.data.length; i += 4) {
      lo = Math.min(lo, out.data[i]);
      hi = Math.max(hi, out.data[i]);
    }
    expect([lo, hi]).toEqual([0, 255]);
    // Same result as stretching the unrounded exposed image, which differs from stretching the rounded one at most by one step.
    const rounded = autoStretch(exposure(img, 1), { method: 'minMax', linked: true });
    expect(maxDiff(out.data, rounded.data)).toBeLessThanOrEqual(3);
  });

  it('after saturation: warns that saturation is ignored for the statistics', () => {
    pipeline().saturation(0.5).autoStretch().runSync(noiseImage(8, 8));
    expect(warnSpy.mock.calls.join('')).toMatch(/after saturation/);
    warnSpy.mockClear();
    pipeline().autoStretch().saturation(0.5).runSync(noiseImage(8, 8));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('a second autoStretch sees the first one applied', () => {
    const img = rangedImage(40, 40, [[30, 200], [30, 200], [30, 200]], 14);
    const ops = resolveOps([normalizeOp({ op: 'autoStretch', method: 'minMax' }), normalizeOp({ op: 'autoStretch', method: 'minMax' })], histogram(img));
    const second = ops[1] as Extract<OpSpec, { op: 'stretch' }>;
    for (let c = 0; c < 3; c++) {
      expect(second.black[c]).toBeCloseTo(0, 12);
      expect(second.white[c]).toBeCloseTo(1, 12);
    }
  });
});

describe('Pipeline with autoStretch', () => {
  it('needsStats, resolve and resolve(null)', () => {
    const p = pipeline().autoStretch({ lowPercent: 1 }).contrast(0.2);
    expect(p.needsStats).toBe(true);
    const img = noiseImage(20, 20, 3);
    const r = p.resolve(histogram(img));
    expect(r.needsStats).toBe(false);
    expect(r.ops[0].op).toBe('stretch');
    expect(r.ops[1]).toEqual(p.ops[1]);
    expect(p.resolve(null).ops).toEqual([p.ops[1]]);
    const plain = pipeline().contrast(0.2);
    expect(plain.resolve(histogram(img))).toBe(plain);
  });

  it('runSync resolves from the image', () => {
    const img = noiseImage(30, 20, 5);
    const p = pipeline().autoStretch().gamma(1.2);
    expect(p.runSync(img).data).toEqual(p.resolve(histogram(img)).runSync(img).data);
  });

  it('toJSON keeps autoStretch; resolved pipelines save fixed points', () => {
    const p = pipeline().autoStretch({ method: 'standardDeviation', stdDevs: 1.5 }).stretch({ black: [0, 0.1, 0.2] });
    const back = Pipeline.fromJSON(JSON.stringify(p.toJSON()));
    expect(back.ops).toEqual(p.ops);
    const img = noiseImage(10, 10);
    const fixed = Pipeline.fromJSON(JSON.stringify(p.resolve(histogram(img)).toJSON()));
    expect(fixed.needsStats).toBe(false);
    expect(fixed.runSync(img).data).toEqual(p.runSync(img).data);
  });

  it('tiles resolved from merged statistics match the whole image exactly (no seams)', () => {
    const img = rangedImage(60, 40, [[20, 180], [40, 220], [10, 150]], 15);
    const p = pipeline().autoStretch().saturation(0.2);
    const whole = p.runSync(img);

    // Cut into 4 tiles, take statistics per tile, merge, and correct each tile with the same resolved pipeline.
    const tiles = [
      [0, 0, 30, 20],
      [30, 0, 30, 20],
      [0, 20, 30, 20],
      [30, 20, 30, 20],
    ].map(([x, y, w, h]) => ({ x, y, img: crop(img, x, y, w, h) }));
    const stats: Histogram = mergeHistograms(tiles.map((t) => histogram(t.img, { colorMode: 'rgb' })));
    const resolved = p.resolve(stats);
    const out = copy(img);
    for (const t of tiles) paste(out.data, img.width, resolved.runSync(t.img, { colorMode: 'rgb' }), t.x, t.y);
    expect(out.data).toEqual(whole.data);

    // Each tile corrected on its own statistics would differ: that is the seam this avoids.
    const own = p.runSync(tiles[0].img);
    expect(own.data).not.toEqual(resolved.runSync(tiles[0].img).data);
  });

  it('run in the pipeline (main thread) matches runSync', async () => {
    const img = noiseImage(40, 30, 6);
    const p = pipeline().autoStretch({ linked: true }).temperature(0.3);
    const res = await p.run(img, { worker: false });
    expect(res.data).toEqual(p.runSync(img).data);
  });
});

function crop(img: { data: Uint8ClampedArray; width: number }, x: number, y: number, w: number, h: number) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++) data.set(img.data.subarray(((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4), r * w * 4);
  return { data, width: w, height: h };
}

function paste(dst: Uint8ClampedArray, width: number, tile: { data: Uint8ClampedArray; width: number; height: number }, x: number, y: number) {
  for (let r = 0; r < tile.height; r++) dst.set(tile.data.subarray(r * tile.width * 4, (r + 1) * tile.width * 4), ((y + r) * width + x) * 4);
}

function stageOf(op: OpSpec): ChannelFn {
  const s = toStage(op);
  if (s.kind !== 'channel') throw new Error('not a channel op');
  return s.fn;
}
