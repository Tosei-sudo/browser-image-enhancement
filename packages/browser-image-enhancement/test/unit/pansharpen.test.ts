import { describe, expect, it } from 'vitest';
import { panSharpen, type PanSharpenMethod } from '../../src/index.js';

const W = 64;
const H = 64;
/** Spectral response of the "sensor": pan = Σ RESPONSE[b] · band b. */
const RESPONSE = [0.1, 0.3, 0.2, 0.4];

/** A sharp 4-band scene (16-bit range): edges and stripes, each band its own brightness. */
function scene(): Float64Array {
  const out = new Float64Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const edge = x > 30 ? 1 : 0;
      const stripe = (Math.floor(y / 3) % 2) * 0.5;
      const base = 400 + 1500 * edge + 800 * stripe + 3 * x;
      for (let b = 0; b < 4; b++) out[(y * W + x) * 4 + b] = base * (0.6 + 0.3 * b) + 200 * b;
    }
  }
  return out;
}

/** The pan band of a scene. */
function panOf(truth: Float64Array): Uint16Array {
  const pan = new Uint16Array(W * H);
  for (let i = 0; i < W * H; i++) {
    let v = 0;
    for (let b = 0; b < 4; b++) v += RESPONSE[b] * truth[i * 4 + b];
    pan[i] = Math.round(v);
  }
  return pan;
}

/** The scene seen at 1/4 resolution, then blown back up (nearest): what a resampled multispectral band looks like. */
function blurred(truth: Float64Array): Uint16Array {
  const out = new Uint16Array(W * H * 4);
  const f = 4;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const bx = Math.floor(x / f) * f;
      const by = Math.floor(y / f) * f;
      for (let b = 0; b < 4; b++) {
        let s = 0;
        for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) s += truth[((by + j) * W + bx + i) * 4 + b];
        out[(y * W + x) * 4 + b] = Math.round(s / (f * f));
      }
    }
  }
  return out;
}

function rmse(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s / a.length);
}

describe('panSharpen', () => {
  const truth = scene();
  const pan = { data: panOf(truth), width: W, height: H };
  const ms = { data: blurred(truth), width: W, height: H, bands: 4 };

  it.each<PanSharpenMethod>(['gram-schmidt', 'ihs', 'brovey'])('%s brings the bands closer to the sharp scene', (method) => {
    const out = panSharpen(pan, ms, { method });
    expect(out.data).toBeInstanceOf(Uint16Array);
    expect(out.bands).toBe(4);
    expect(rmse(out.data, truth)).toBeLessThan(rmse(ms.data, truth) * 0.6);
  });

  it('gram-schmidt recovers the scene almost exactly when pan is a mix of the bands', () => {
    const out = panSharpen(pan, ms);
    expect(rmse(out.data, truth)).toBeLessThan(rmse(ms.data, truth) * 0.2);
  });

  it('fits the intensity weights to the pan band', () => {
    const { weights } = panSharpen(pan, ms);
    // The bands are nearly collinear, so only the overall fit is checked: the weights sum to 1 and none is negative.
    expect(weights.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 9);
    expect(weights.every((w) => w >= 0)).toBe(true);
    expect(panSharpen(pan, ms, { weights: 'equal' }).weights).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(panSharpen(pan, ms, { weights: [1, 1, 2, 0] }).weights).toEqual([0.25, 0.25, 0.5, 0]);
  });

  it('strength 0 leaves the bands as they are', () => {
    const out = panSharpen(pan, ms, { strength: 0 });
    expect(Array.from(out.data)).toEqual(Array.from(ms.data));
  });

  it('keeps no data, and never turns a valid pixel into no data', () => {
    const p = Uint16Array.from(pan.data);
    const m = Uint16Array.from(ms.data);
    p[5] = 0; // pan has no data here
    m[10 * 4 + 2] = 0; // one band has no data here
    // A dark pixel whose sharpened value would round to 0.
    m.fill(1, 20 * 4, 21 * 4);
    p[20] = 0;
    p[21] = 1;
    const out = panSharpen({ ...pan, data: p, noData: 0 }, { ...ms, data: m, noData: 0 });
    expect(out.noData).toBe(0);
    expect(Array.from(out.data.subarray(5 * 4, 6 * 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(out.data.subarray(10 * 4, 11 * 4))).toEqual([0, 0, 0, 0]);
    for (let i = 0; i < W * H; i++) {
      if (i === 5 || i === 10 || i === 20) continue;
      for (let b = 0; b < 4; b++) expect(out.data[i * 4 + b]).toBeGreaterThan(0);
    }
  });

  it('clamps to the sample type and copies bands it does not sharpen', () => {
    const p = new Uint8Array(W * H).map((_, i) => (i % 2 ? 255 : 0));
    const m = new Uint8Array(W * H * 2).map((_, i) => (i % 2 ? 77 : 250));
    const out = panSharpen({ data: p, width: W, height: H }, { data: m, width: W, height: H, bands: 2 }, { bands: [0], method: 'ihs' });
    expect(out.data).toBeInstanceOf(Uint8Array);
    for (let i = 0; i < W * H; i++) {
      expect(out.data[i * 2 + 1]).toBe(77);
      expect(out.data[i * 2]).toBeLessThanOrEqual(255);
    }
  });

  it('works on floats, with NaN as no data, and keeps alpha', () => {
    const p = Float32Array.from(pan.data);
    const m = new Float32Array(W * H * 5);
    for (let i = 0; i < W * H; i++) {
      for (let b = 0; b < 4; b++) m[i * 5 + b] = ms.data[i * 4 + b];
      m[i * 5 + 4] = i === 3 ? 0 : 255;
    }
    p[7] = NaN;
    const out = panSharpen({ data: p, width: W, height: H }, { data: m, width: W, height: H, bands: 5, alpha: true });
    expect(out.data).toBeInstanceOf(Float32Array);
    expect(Number.isNaN(out.noData)).toBe(true);
    expect(Number.isNaN(out.data[7 * 5])).toBe(true);
    expect(Number.isNaN(out.data[3 * 5])).toBe(true);
    expect(out.data[3 * 5 + 4]).toBe(0);
    expect(out.data[8 * 5 + 4]).toBe(255);
  });

  it('rejects rasters of different sizes and bad options', () => {
    expect(() => panSharpen({ data: new Uint8Array(4), width: 2, height: 2 }, ms)).toThrow(RangeError);
    expect(() => panSharpen(pan, ms, { bands: [4] })).toThrow(RangeError);
    expect(() => panSharpen(pan, ms, { weights: [1, 2] })).toThrow(RangeError);
    expect(() => panSharpen(pan, ms, { strength: -1 })).toThrow(RangeError);
  });
});
