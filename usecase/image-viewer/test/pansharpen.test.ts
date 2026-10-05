import { describe, expect, it } from 'vitest';
import { planPanSharpen, runPanSharpen, type Grid } from '../src/pansharpen.js';

const pan: Grid = { width: 400, height: 400, origin: [1000, 5000], resolution: [1, -1] };
const ms: Grid = { width: 100, height: 100, origin: [1000, 5000], resolution: [4, -4] };

describe('planPanSharpen', () => {
  it('maps the multispectral pixels onto the panchromatic grid', () => {
    const plan = planPanSharpen(pan, ms, { bands: 4, maxSamples: 1e9 });
    expect(plan.pan).toEqual({ window: [0, 0, 400, 400], width: 400, height: 400 });
    expect(plan.ms).toEqual({ window: [0, 0, 100, 100], width: 100, height: 100 });
    expect(plan.msToOutput).toEqual([4, 0, 0, 0, 4, 0]);
    expect(plan.ratio).toEqual([4, 4]);
    expect(plan.origin).toEqual([1000, 5000]);
    expect(plan.resolution).toEqual([1, -1]);
  });

  it('keeps to the overlap, reading a margin of multispectral pixels', () => {
    const small: Grid = { width: 50, height: 50, origin: [1040, 4960], resolution: [4, -4] };
    const plan = planPanSharpen(pan, small, { bands: 4, maxSamples: 1e9 });
    expect(plan.pan.window).toEqual([40, 40, 240, 240]);
    expect(plan.origin).toEqual([1040, 4960]);
    // The whole small image is inside, so no margin can be read; its pixel 0 is output pixel 0.
    expect(plan.ms.window).toEqual([0, 0, 50, 50]);
    expect(plan.msToOutput).toEqual([4, 0, 0, 0, 4, 0]);

    const big: Grid = { width: 200, height: 200, origin: [600, 5400], resolution: [4, -4] };
    const inside = planPanSharpen(pan, big, { bands: 4, maxSamples: 1e9 });
    expect(inside.pan.window).toEqual([0, 0, 400, 400]);
    expect(inside.ms.window).toEqual([97, 97, 203, 203].map((v) => Math.min(200, v)));
    // Read pixel 0 is multispectral pixel 97, at panchromatic x (600 + 97 * 4 - 1000) = -12.
    expect(inside.msToOutput[2]).toBeCloseTo(-12, 9);
  });

  it('reduces the output by a whole factor when it would not fit', () => {
    const plan = planPanSharpen(pan, ms, { bands: 4, maxSamples: 200 * 200 * 4 });
    expect(plan.reduction).toBe(2);
    expect([plan.width, plan.height]).toEqual([200, 200]);
    expect(plan.resolution).toEqual([2, -2]);
    expect(plan.msToOutput).toEqual([2, 0, 0, 0, 2, 0]);
  });

  it('stretches an ordinary picture over the other one', () => {
    const picture: Grid = { width: 100, height: 100, origin: [-50, 50], resolution: [1, -1] };
    const plan = planPanSharpen(pan, picture, { bands: 3, maxSamples: 1e9, sameGround: true });
    expect(plan.pan.window).toEqual([0, 0, 400, 400]);
    expect(plan.msToOutput).toEqual([4, 0, 0, 0, 4, 0]);
  });

  it('refuses images that do not overlap', () => {
    expect(() => planPanSharpen(pan, { ...ms, origin: [9000, 5000] }, { bands: 4, maxSamples: 1e9 })).toThrow('重なっていません');
  });
});

describe('runPanSharpen', () => {
  it('resamples and sharpens: an edge the multispectral image blurs comes back', () => {
    const W = 64;
    const f = 4;
    const panData = new Uint16Array(W * W).map((_, i) => ((i % W) >= 30 ? 3000 : 1000));
    const w = W / f;
    const msData = new Uint16Array(w * w * 3);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        // The block holding the edge averages both sides.
        let s = 0;
        for (let i = 0; i < f; i++) s += x * f + i >= 30 ? 3000 : 1000;
        for (let b = 0; b < 3; b++) msData[(y * w + x) * 3 + b] = Math.round((s / f) * (1 + b * 0.2));
      }
    }
    const plan = planPanSharpen(
      { width: W, height: W, origin: [0, W], resolution: [1, -1] },
      { width: w, height: w, origin: [0, W], resolution: [f, -f] },
      { bands: 3, maxSamples: 1e9 },
    );
    const out = runPanSharpen({
      pan: { width: W, height: W, bands: 1, data: panData },
      ms: { width: w, height: w, bands: 3, data: msData },
      alpha: false,
      plan,
      method: 'gram-schmidt',
      resample: 'bilinear',
      strength: 1,
      weights: 'auto',
    });
    expect(out.raster.width).toBe(W);
    expect(out.raster.data).toBeInstanceOf(Uint16Array);
    const at = (x: number, b = 0) => out.raster.data[(20 * W + x) * 3 + b];
    // A sharp step between pixels 29 and 30, in every band.
    for (let b = 0; b < 3; b++) {
      expect(at(30, b) - at(29, b)).toBeGreaterThan(1500 * (1 + b * 0.2));
      expect(Math.abs(at(26, b) - at(29, b))).toBeLessThan(200);
    }
  });
});
