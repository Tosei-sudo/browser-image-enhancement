import { describe, expect, it } from 'vitest';
import { accumulate, classify, colorClasses, emptyStats, invertSpd, kMeans, rasterizePolygons, samplePixels, random, trainModel } from '../src/classify.js';
import { classCsv } from '../src/classify-dialog.js';

/** Three bands of `n` pixels: dark, green and bright thirds, with a little noise. */
function scene(n: number): Float32Array[] {
  const bands = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const looks = [
    [10, 20, 30],
    [40, 120, 50],
    [200, 180, 160],
  ];
  for (let i = 0; i < n; i++) {
    const look = looks[Math.floor((3 * i) / n)];
    for (let b = 0; b < 3; b++) bands[b][i] = look[b] + ((i * (b + 1)) % 5) - 2;
  }
  return bands;
}

describe('classify', () => {
  it('inverts a symmetric positive definite matrix', () => {
    const m = new Float64Array([4, 2, 2, 3]);
    const { inverse, logDet } = invertSpd(m, 2)!;
    expect(Array.from(inverse).map((v) => Math.round(v * 1000) / 1000)).toEqual([0.375, -0.25, -0.25, 0.5]);
    expect(logDet).toBeCloseTo(Math.log(8));
    expect(invertSpd(new Float64Array([1, 2, 2, 1]), 2)).toBeNull();
  });

  it('k-means finds the three looks, darkest first', () => {
    const n = 300;
    const bands = scene(n);
    const samples = samplePixels(bands, n, 300, random(1));
    const means = kMeans(samples, 3, 3);
    expect(Math.round(means[0])).toBe(10);
    expect(Math.round(means[4])).toBe(120);
    expect(Math.round(means[6])).toBe(200);
    const classes = classify(bands, n, { kind: 'distance', dims: 3, means });
    expect(classes[0]).toBe(1);
    expect(classes[150]).toBe(2);
    expect(classes[299]).toBe(3);
  });

  it('skips pixels without a value in every band', () => {
    const bands = [new Float32Array([1, NaN, 3]), new Float32Array([1, 2, 3])];
    expect(Array.from(classify(bands, 3, { kind: 'distance', dims: 2, means: new Float64Array([0, 0, 5, 5]) }))).toEqual([1, 0, 2]);
    expect(samplePixels(bands, 3, 10, random(1)).length).toBe(4);
  });

  it('trains on labeled pixels, by distance or likelihood', () => {
    const n = 300;
    const bands = scene(n);
    // A few labeled pixels of each third.
    const labels = new Uint8Array(n);
    for (let i = 10; i < 30; i++) labels[i] = 1;
    for (let i = 110; i < 130; i++) labels[i] = 2;
    for (let i = 210; i < 230; i++) labels[i] = 3;
    const stats = emptyStats(3, 3);
    accumulate(stats, bands, labels, n);
    expect(Array.from(stats.counts)).toEqual([20, 20, 20]);
    for (const kind of ['distance', 'likelihood'] as const) {
      const model = trainModel(stats, kind, ['水', '植生', '裸地']);
      const classes = classify(bands, n, model);
      expect([classes[0], classes[99], classes[100], classes[199], classes[200], classes[299]]).toEqual([1, 1, 2, 2, 3, 3]);
    }
  });

  it('says which classes have too few training pixels', () => {
    const stats = emptyStats(2, 3);
    stats.counts[0] = 10;
    stats.counts[1] = 2;
    expect(() => trainModel(stats, 'likelihood', ['水', '森'])).toThrow('森');
    expect(() => trainModel(stats, 'distance', ['水', '森'])).not.toThrow();
  });

  it('fills polygons by pixel centers, holes left out', () => {
    // A 6 × 6 square with a 2 × 2 hole, in an 8 × 8 block.
    const outer = new Float64Array([1, 1, 7, 1, 7, 7, 1, 7]);
    const hole = new Float64Array([3, 3, 5, 3, 5, 5, 3, 5]);
    const mask = rasterizePolygons([{ label: 2, rings: [outer, hole] }], 8, 8);
    expect(mask.reduce((s, v) => s + (v ? 1 : 0), 0)).toBe(32);
    expect(mask[1 * 8 + 1]).toBe(2);
    expect(mask[3 * 8 + 3]).toBe(0);
    expect(mask[0]).toBe(0);
  });

  it('colors classes, transparent where there is none', () => {
    expect(Array.from(colorClasses(new Uint8Array([0, 2]), [[1, 2, 3], [4, 5, 6]]))).toEqual([0, 0, 0, 0, 4, 5, 6, 255]);
  });

  it('writes the class table as CSV', () => {
    const csv = classCsv([
      { name: '水', color: [31, 119, 180], pixels: 100, area: 400 },
      { name: '森, 林', color: [44, 160, 44], pixels: 300, area: 1200 },
    ]);
    expect(csv).toBe('﻿番号,クラス,色,画素数,面積_km2,割合_%\n1,水,#1f77b4,100,0.000400,25.00\n2,"森, 林",#2ca02c,300,0.001200,75.00\n');
  });
});
