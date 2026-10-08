import { describe, expect, it } from 'vitest';
import { blocksOf, fitPanSharpen, planPanSharpen, runPanSharpen, sampleWindows, type Grid } from '../src/pansharpen.js';

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

describe('pan-sharpening in blocks', () => {
  /** A 600 × 520 panchromatic image and a 4-band one at a quarter of its resolution, with edges and gradients. */
  const W = 600;
  const H = 520;
  const F = 4;
  const panGrid: Grid = { width: W, height: H, origin: [0, H], resolution: [1, -1] };
  const msGrid: Grid = { width: W / F, height: H / F, origin: [0, H], resolution: [F, -F] };
  const truth = (x: number, y: number) => 800 + 3 * x + 2 * y + ((x >> 5) % 2) * 900 + ((y * 7 + x * 3) % 41) * 5;
  const panData = new Uint16Array(W * H).map((_, i) => truth(i % W, Math.floor(i / W)));
  const msData = new Uint16Array((W / F) * (H / F) * 4);
  for (let y = 0; y < H / F; y++) {
    for (let x = 0; x < W / F; x++) {
      let s = 0;
      for (let j = 0; j < F; j++) for (let i = 0; i < F; i++) s += truth(x * F + i, y * F + j);
      for (let b = 0; b < 4; b++) msData[(y * (W / F) + x) * 4 + b] = Math.round((s / (F * F)) * (0.7 + 0.2 * b));
    }
  }
  const settings = { alpha: false, method: 'gram-schmidt' as const, resample: 'bicubic' as const, strength: 1, weights: 'auto' as const };
  /** The job for a window, read as the dialog reads it. */
  const jobOf = (window?: readonly [number, number, number, number]) => {
    const plan = planPanSharpen(panGrid, msGrid, { bands: 4, window });
    const [px0, py0, px1, py1] = plan.pan.window;
    const [mx0, my0, mx1, my1] = plan.ms.window;
    const pan = new Uint16Array((px1 - px0) * (py1 - py0));
    for (let y = py0; y < py1; y++) pan.set(panData.subarray(y * W + px0, y * W + px1), (y - py0) * (px1 - px0));
    const ms = new Uint16Array((mx1 - mx0) * (my1 - my0) * 4);
    for (let y = my0; y < my1; y++) ms.set(msData.subarray((y * (W / F) + mx0) * 4, (y * (W / F) + mx1) * 4), (y - my0) * (mx1 - mx0) * 4);
    return { pan: { width: px1 - px0, height: py1 - py0, bands: 1, data: pan }, ms: { width: mx1 - mx0, height: my1 - my0, bands: 4, data: ms }, plan, ...settings };
  };

  it('splits the output into blocks on whole tiles, and spreads fitting windows over it', () => {
    const plan = planPanSharpen(panGrid, msGrid, { bands: 4 });
    expect(blocksOf(plan, 256)).toEqual([
      [0, 0, 256, 256], [256, 0, 512, 256], [512, 0, 600, 256],
      [0, 256, 256, 512], [256, 256, 512, 512], [512, 256, 600, 512],
      [0, 512, 256, 520], [256, 512, 512, 520], [512, 512, 600, 520],
    ]);
    expect(sampleWindows(plan, 8, 256)).toEqual([
      [0, 0, 256, 256], [344, 0, 600, 256],
      [0, 264, 256, 520], [344, 264, 600, 520],
    ]);
  });

  it('plans a window like the whole: the same multispectral pixels under the same output pixels', () => {
    const whole = planPanSharpen(panGrid, msGrid, { bands: 4 });
    const part = planPanSharpen(panGrid, msGrid, { bands: 4, window: [256, 256, 512, 512] });
    expect(part.pan.window).toEqual([256, 256, 512, 512]);
    expect(part.origin).toEqual([256, H - 256]);
    expect(part.reduction).toBe(1);
    // Output pixel (u, v) of the part is output pixel (256 + u, 256 + v) of the whole: same multispectral position.
    const ms = (p: typeof whole, u: number) => (u - p.msToOutput[2]) / p.msToOutput[0] + p.ms.window[0];
    expect(ms(part, 10)).toBeCloseTo(ms(whole, 266), 9);
  });

  it('gives the same result in blocks, with the model fitted on the whole, as all at once', () => {
    const whole = runPanSharpen(jobOf());
    const model = fitPanSharpen([jobOf()]);
    expect(model.weights).toEqual(whole.model.weights);
    const plan = planPanSharpen(panGrid, msGrid, { bands: 4 });
    for (const window of blocksOf(plan, 256)) {
      const block = runPanSharpen({ ...jobOf(window), model });
      const [x0, y0, x1, y1] = window;
      for (let y = y0; y < y1; y += 7) {
        for (let x = x0; x < x1; x += 5) {
          for (let b = 0; b < 4; b++) expect(block.raster.data[((y - y0) * (x1 - x0) + x - x0) * 4 + b]).toBe(whole.raster.data[(y * W + x) * 4 + b]);
        }
      }
    }
  });

  it('fits nearly the same model on windows spread over the image as on the whole', () => {
    const plan = planPanSharpen(panGrid, msGrid, { bands: 4 });
    const whole = fitPanSharpen([jobOf()]);
    const spread = fitPanSharpen(sampleWindows(plan, 8, 128).map((w) => jobOf(w)));
    for (let j = 0; j < 4; j++) {
      expect(spread.weights[j]).toBeCloseTo(whole.weights[j], 1);
      expect(spread.gains[j]).toBeCloseTo(whole.gains[j], 1);
    }
    expect(spread.panGain).toBeCloseTo(whole.panGain, 1);
  });
});
