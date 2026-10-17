import { describe, expect, it } from 'vitest';
import { bandLabels, bandStats, spectralCsv, type Spectrum } from '../src/spectral.js';

describe('bandStats', () => {
  it('gives the mean, range and spread of each band without no data', () => {
    const [a, b] = bandStats([new Float32Array([1, 2, 3, NaN]), new Uint16Array([0, 10, 20, 0])], (v) => v === 0);
    expect(a).toMatchObject({ mean: 2, min: 1, max: 3, count: 3 });
    expect(a.std).toBeCloseTo(Math.sqrt(2 / 3));
    expect(b).toMatchObject({ mean: 15, min: 10, max: 20, std: 5, count: 2 });
  });

  it('a band of no data only has no statistics', () => {
    expect(bandStats([[0, 0]], (v) => v === 0)[0]).toMatchObject({ count: 0, mean: NaN });
  });
});

describe('bandLabels', () => {
  it('numbers the bands and adds their names', () => {
    expect(bandLabels(3, ['Blue', null])).toEqual(['B1 Blue', 'B2', 'B3']);
  });
});

describe('spectralCsv', () => {
  it('has a row per band and a column per line, with a box’s range and spread', () => {
    const stat = (mean: number, extra = 0) => ({ mean, min: mean - extra, max: mean + extra, std: extra, count: 1 });
    const series: Spectrum[] = [
      { number: 1, label: '点（列 3、行 4）', color: '#000', bands: [stat(50), stat(80)], pixels: 1 },
      { number: 2, label: '範囲 2 × 2 画素', color: '#000', bands: [stat(10, 1), stat(20, 2)], pixels: 4 },
    ];
    expect(spectralCsv(series, ['B1', 'B2'])).toBe(
      'band,1 点（列 3、行 4）,2 範囲 2 × 2 画素,2 範囲 2 × 2 画素 min,2 範囲 2 × 2 画素 max,2 範囲 2 × 2 画素 std\nB1,50,10,9,11,1\nB2,80,20,18,22,2\n',
    );
  });
});
