import { describe, expect, it } from 'vitest';
import { compile, extractGray, isMonochrome, processPixels, resolveMode, type ResolvedMode } from '../../src/core/process.js';
import { normalizeOp } from '../../src/ops/index.js';
import type { ImageDataLike, OpSpec } from '../../src/types.js';
import { copy, grayImage, image, isGrayPixels, maxDiff, noiseImage, rampImage, randomOps, rng } from '../helpers.js';

function run(img: ImageDataLike, ops: OpSpec[], mode: ResolvedMode, fuse = true): Uint8ClampedArray {
  const out = new Uint8ClampedArray(img.data.length);
  processPixels(img.data, out, compile(ops.map(normalizeOp), mode, { fuse }));
  return out;
}

// --- An independent reference: textbook formulas, no tables, no folding. ---
const dec = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const enc = (v: number) => (v <= 0 ? 0 : v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const toCode = (v: number) => Math.round(Math.min(1, Math.max(0, enc(v))) * 255);
const decE = (e: number) => (e <= 0.04045 ? e / 12.92 : ((e + 0.055) / 1.055) ** 2.4);

function refPixel(rgb: number[], ops: OpSpec[], gray: boolean): number[] {
  let [r, g, b] = rgb.map(dec);
  if (gray) r = g = b = rgb[0] === rgb[1] && rgb[1] === rgb[2] ? r : 0.2126 * r + 0.7152 * g + 0.0722 * b;
  for (const raw of ops) {
    const op = normalizeOp(raw);
    const each = (f: (v: number, c: number) => number) => {
      [r, g, b] = [f(r, 0), f(g, 1), f(b, 2)];
    };
    switch (op.op) {
      case 'brightness':
        each((v) => (op.amount >= 0 ? v + (1 - v) * op.amount : v * (1 + op.amount)));
        break;
      case 'contrast': {
        const k = op.amount >= 0 ? 1 / Math.max(1 - op.amount, 1 / 1024) : 1 + op.amount;
        const p = decE(0.5);
        if (op.amount !== 0) each((v) => (v > 0 ? p * (v / p) ** k : 0));
        break;
      }
      case 'exposure':
        each((v) => v * 2 ** op.ev);
        break;
      case 'gamma':
        if (op.gamma !== 1) each((v) => (v > 0 ? v ** (1 / op.gamma) : 0));
        break;
      case 'saturation': {
        if (gray) break;
        const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        each((v) => y + (v - y) * (1 + op.amount));
        break;
      }
      case 'temperature': {
        if (gray) break;
        const gr = 1 + 0.4 * op.amount;
        const gb = 1 - 0.4 * op.amount;
        const n = 0.2126 * gr + 0.7152 + 0.0722 * gb;
        each((v, c) => (v * [gr, 1, gb][c]) / n);
        break;
      }
      case 'levels':
        each((v) => {
          let x = (enc(v) - op.inBlack) / (op.inWhite - op.inBlack);
          x = Math.min(1, Math.max(0, x)) ** (1 / op.gamma);
          return decE(op.outBlack + x * (op.outWhite - op.outBlack));
        });
        break;
      case 'stretch': {
        // Gray mode has one channel and uses the mean of the per-channel points.
        const mean = (v: number[]) => (v[0] + v[1] + v[2]) / 3;
        const black = gray ? [0, 1, 2].map(() => mean(op.black)) : op.black;
        const white = gray ? [0, 1, 2].map(() => mean(op.white)) : op.white;
        each((v, c) => decE(Math.min(1, Math.max(0, (enc(v) - black[c]) / (white[c] - black[c])))));
        break;
      }
    }
  }
  return [toCode(r), toCode(g), toCode(b)];
}

function reference(img: ImageDataLike, ops: OpSpec[], gray: boolean): Uint8ClampedArray {
  const out = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    const px = refPixel(Array.from(img.data.subarray(i, i + 3)), ops, gray);
    out.set([...px, img.data[i + 3]], i);
  }
  return out;
}

function mismatchRate(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n / a.length;
}

describe('processPixels', () => {
  it('with no ops returns the input exactly', () => {
    const img = noiseImage(64, 64);
    expect(run(img, [], 'rgb')).toEqual(img.data);
    expect(run(img, [{ op: 'brightness', amount: 0 }, { op: 'levels' } as OpSpec], 'rgb')).toEqual(img.data);
  });

  it('identity ops on gray input return the input exactly', () => {
    const img = grayImage(64, 64);
    expect(run(img, [{ op: 'gamma', gamma: 1 }], 'gray')).toEqual(img.data);
  });

  it('keeps alpha untouched', () => {
    const img = noiseImage(50, 50, 3);
    for (const mode of ['rgb', 'gray'] as const) {
      const out = run(img, [{ op: 'brightness', amount: 0.5 }, { op: 'saturation', amount: 0.5 }], mode);
      for (let i = 3; i < out.length; i += 4) expect(out[i]).toBe(img.data[i]);
    }
  });

  it('can process in place', () => {
    const img = noiseImage(40, 40, 5);
    const ops: OpSpec[] = [{ op: 'contrast', amount: 0.3 }, { op: 'saturation', amount: 0.4 }, { op: 'gamma', gamma: 1.3 }];
    const expected = run(img, ops, 'rgb');
    const data = img.data.slice();
    processPixels(data, data, compile(ops.map(normalizeOp), 'rgb'));
    expect(data).toEqual(expected);
  });

  it('rejects mismatched buffers', () => {
    expect(() => processPixels(new Uint8ClampedArray(8), new Uint8ClampedArray(4), compile([], 'rgb'))).toThrow(RangeError);
  });

  it('does not modify the source', () => {
    const img = noiseImage(30, 30, 8);
    const before = img.data.slice();
    run(img, [{ op: 'exposure', ev: 1 }, { op: 'saturation', amount: 1 }], 'rgb');
    expect(img.data).toEqual(before);
  });

  describe('folding steps into tables changes nothing', () => {
    const r = rng(2024);
    const img = rampImage();
    for (let t = 0; t < 60; t++) {
      const ops = randomOps(r);
      it(`chain #${t}: ${ops.map((o) => o.op).join(' > ')}`, () => {
        expect(run(img, ops, 'rgb', true)).toEqual(run(img, ops, 'rgb', false));
        expect(run(img, ops, 'gray', true)).toEqual(run(img, ops, 'gray', false));
      });
    }
  });

  describe('matches the textbook formulas', () => {
    const r = rng(7);
    const img = noiseImage(128, 64, 11);
    for (let t = 0; t < 25; t++) {
      const ops = randomOps(r);
      it(`chain #${t}: ${ops.map((o) => o.op).join(' > ')}`, () => {
        for (const gray of [false, true]) {
          const got = run(img, ops, gray ? 'gray' : 'rgb');
          const want = reference(img, ops, gray);
          // Floating-point order of operations may differ; allow rare 1-step differences at rounding ties.
          expect(maxDiff(got, want)).toBeLessThanOrEqual(1);
          expect(mismatchRate(got, want)).toBeLessThan(0.001);
        }
      });
    }
  });

  it('brightness +1 makes everything white, -1 black', () => {
    const img = noiseImage(20, 20);
    const white = run(img, [{ op: 'brightness', amount: 1 }], 'rgb');
    const black = run(img, [{ op: 'brightness', amount: -1 }], 'rgb');
    for (let i = 0; i < white.length; i += 4) {
      expect([white[i], white[i + 1], white[i + 2]]).toEqual([255, 255, 255]);
      expect([black[i], black[i + 1], black[i + 2]]).toEqual([0, 0, 0]);
    }
  });

  it('saturation -1 produces gray pixels', () => {
    const out = run(noiseImage(40, 40), [{ op: 'saturation', amount: -1 }], 'rgb');
    for (let i = 0; i < out.length; i += 4) {
      expect(Math.abs(out[i] - out[i + 1])).toBeLessThanOrEqual(1);
      expect(Math.abs(out[i] - out[i + 2])).toBeLessThanOrEqual(1);
    }
  });

  it('saturation +1 increases channel spread', () => {
    const img = image(1, 1, () => [180, 120, 90, 255]);
    const [r, g, b] = run(img, [{ op: 'saturation', amount: 1 }], 'rgb');
    expect(r - b).toBeGreaterThan(90);
    expect(g).toBeLessThan(140);
  });

  it('temperature shifts a neutral gray toward orange or blue', () => {
    const img = image(1, 1, () => [128, 128, 128, 255]);
    const [wr, , wb] = run(img, [{ op: 'temperature', amount: 0.6 }], 'rgb');
    const [cr, , cb] = run(img, [{ op: 'temperature', amount: -0.6 }], 'rgb');
    expect(wr).toBeGreaterThan(wb);
    expect(cb).toBeGreaterThan(cr);
  });

  it('exposure +1 doubles linear light', () => {
    const img = image(1, 1, () => [100, 100, 100, 255]);
    const [v] = run(img, [{ op: 'exposure', ev: 1 }], 'rgb');
    const lin = ((100 / 255 + 0.055) / 1.055) ** 2.4 * 2;
    expect(v).toBe(Math.round((1.055 * lin ** (1 / 2.4) - 0.055) * 255));
  });

  it('levels stretches a range to full scale', () => {
    const img = image(3, 1, (x) => {
      const v = [51, 128, 204][x];
      return [v, v, v, 255];
    });
    const out = run(img, [{ op: 'levels', inBlack: 0.2, inWhite: 0.8 } as OpSpec], 'rgb');
    expect(out[0]).toBe(0);
    expect(out[4]).toBeGreaterThanOrEqual(127);
    expect(out[4]).toBeLessThanOrEqual(129);
    expect(out[8]).toBe(255);
  });

  it('chained ops are computed without intermediate rounding', () => {
    // Darken a lot, then brighten back: one rounding keeps the shadows apart, per-step rounding would merge them.
    const img = image(256, 1, (x) => [x, x, x, 255]);
    const ops: OpSpec[] = [{ op: 'exposure', ev: -6 }, { op: 'exposure', ev: 6 }];
    const out = run(img, ops, 'rgb');
    for (let x = 0; x < 256; x++) expect(out[x * 4]).toBe(x);
  });
});

describe('monochrome handling', () => {
  describe('gray input stays gray (R = G = B) under any chain', () => {
    const r = rng(555);
    for (let t = 0; t < 40; t++) {
      const ops = randomOps(r);
      it(`chain #${t}: ${ops.map((o) => o.op).join(' > ')}`, () => {
        const img = grayImage(64, 32, t);
        expect(isGrayPixels(run(img, ops, resolveMode(img.data, 'auto')))).toBe(true);
      });
    }
  });

  it('saturation and temperature are no-ops on gray input in auto mode', () => {
    const img = grayImage(64, 64, 9);
    const mode = resolveMode(img.data, 'auto');
    expect(mode).toBe('gray');
    expect(run(img, [{ op: 'saturation', amount: 1 }, { op: 'temperature', amount: -1 }], mode)).toEqual(img.data);
  });

  it('gray mode gives the same result as rgb mode for ops that do not involve color', () => {
    const img = grayImage(64, 64, 10);
    const r = rng(1);
    for (let t = 0; t < 20; t++) {
      const ops = randomOps(r).filter(
        (o) => o.op !== 'saturation' && o.op !== 'temperature' && !(o.op === 'stretch' && new Set([...o.black, ...o.white]).size > 2),
      );
      expect(run(img, ops, 'gray')).toEqual(run(img, ops, 'rgb'));
    }
  });

  it("colorMode 'rgb' lets temperature tint a gray image", () => {
    const img = grayImage(16, 16, 4);
    const out = run(img, [{ op: 'temperature', amount: 0.8 }], resolveMode(img.data, 'rgb'));
    expect(isGrayPixels(out)).toBe(false);
  });

  it("colorMode 'gray' converts a color image to its luminance", () => {
    const img = image(3, 1, (x) => [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]][x] as [number, number, number, number]);
    const out = run(img, [], 'gray');
    expect(isGrayPixels(out)).toBe(true);
    // Rec. 709 luminance of pure primaries, encoded back to sRGB.
    expect(out[0]).toBe(127);
    expect(out[4]).toBe(220);
    expect(out[8]).toBe(76);
  });

  it('forced gray on a color image matches extractGray, then applies ops', () => {
    const img = noiseImage(64, 64, 12);
    const plain = run(img, [], 'gray');
    const g = extractGray(img.data);
    for (let i = 0; i < g.length; i++) expect(plain[i * 4]).toBe(g[i]);
    const ops: OpSpec[] = [{ op: 'contrast', amount: 0.4 }, { op: 'levels', inBlack: 0.1 } as OpSpec];
    const out = run(img, ops, 'gray');
    expect(isGrayPixels(out)).toBe(true);
    expect(out).toEqual(run(img, ops, 'gray', false));
  });

  it('isMonochrome and resolveMode', () => {
    const g = grayImage(10, 10);
    expect(isMonochrome(g.data)).toBe(true);
    const c = copy(g);
    c.data[c.data.length - 2] ^= 1; // last pixel's blue
    expect(isMonochrome(c.data)).toBe(false);
    expect(isMonochrome(new Uint8ClampedArray(0))).toBe(true);
    expect(resolveMode(g.data)).toBe('gray');
    expect(resolveMode(c.data)).toBe('rgb');
    expect(resolveMode(g.data, 'rgb')).toBe('rgb');
    expect(resolveMode(c.data, 'gray')).toBe('gray');
  });

  it('alpha does not affect monochrome detection', () => {
    const img = image(2, 1, (x) => [100, 100, 100, x * 200]);
    expect(isMonochrome(img.data)).toBe(true);
  });

  it('extractGray returns one value per pixel', () => {
    const img = image(2, 1, (x) => (x === 0 ? [77, 77, 77, 0] : [0, 0, 0, 255]));
    expect(Array.from(extractGray(img.data))).toEqual([77, 0]);
  });
});

describe('decreasing steps (inverting curve or levels)', () => {
  const inverting = [
    [{ op: 'saturation', amount: 0.3 }, { op: 'curve', points: [[0, 1], [1, 0]] }],
    [{ op: 'saturation', amount: 0.3 }, { op: 'levels', outBlack: 1, outWhite: 0 }],
    [{ op: 'curve', points: [[0, 1], [1, 0]] }, { op: 'sharpen', amount: 1 }, { op: 'curve', points: [[0, 1], [1, 0]] }],
  ];
  for (const ops of inverting as Array<Array<{ op: string }>>) {
    it(`fold to the same result as step by step: ${ops.map((o) => o.op).join(', ')}`, () => {
      const img = noiseImage(16, 16);
      const go = (mode: ResolvedMode, fuse: boolean) => {
        const out = new Uint8ClampedArray(img.data.length);
        processPixels(img.data, out, compile((ops as unknown[]).map(normalizeOp), mode, { fuse }), img.width);
        return out;
      };
      for (const mode of ['rgb', 'gray'] as const) expect(maxDiff(go(mode, true), go(mode, false))).toBeLessThanOrEqual(1);
    });
  }
});
