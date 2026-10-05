import { describe, expect, it } from 'vitest';
import { barHeights, channelStats } from '../src/histogram-panel.js';
import { swipeRect } from '../src/swipe.js';

describe('channelStats', () => {
  it('gives min, max, mean and median of the counted values', () => {
    const bins = new Float64Array(256);
    bins[10] = 1;
    bins[20] = 2;
    bins[200] = 1;
    expect(channelStats(bins)).toEqual({ min: 10, max: 200, mean: 62.5, median: 20, count: 4 });
  });

  it('is null for an empty channel', () => {
    expect(channelStats(new Float64Array(256))).toBeNull();
  });
});

describe('barHeights', () => {
  it('scales to the tallest bin away from the ends, cutting the clipped ends', () => {
    const bins = new Float64Array(256);
    bins[0] = 1000;
    bins[100] = 10;
    bins[150] = 5;
    const [h] = barHeights([bins], false);
    expect(h[100]).toBe(1);
    expect(h[150]).toBe(0.5);
    expect(h[0]).toBe(1);
  });

  it('shares one scale between channels, and can be logarithmic', () => {
    const a = new Float64Array(256);
    const b = new Float64Array(256);
    a[50] = 99;
    b[50] = 9;
    const [ha, hb] = barHeights([a, b], true);
    expect(ha[50]).toBe(1);
    expect(hb[50]).toBeCloseTo(0.5);
  });

  it('falls back to the ends when only they are counted', () => {
    const bins = new Float64Array(256);
    bins[255] = 4;
    expect(barHeights([bins], false)[0][255]).toBe(1);
  });
});

describe('swipeRect', () => {
  it('keeps the left part for a vertical line and the top part for a horizontal one', () => {
    expect(swipeRect('vertical', 0.25, [800, 600])).toEqual([0, 0, 200, 600]);
    expect(swipeRect('horizontal', 0.5, [800, 600])).toEqual([0, 0, 800, 300]);
  });

  it('clamps the position to the map', () => {
    expect(swipeRect('vertical', 1.5, [800, 600])).toEqual([0, 0, 800, 600]);
    expect(swipeRect('vertical', -1, [800, 600])).toEqual([0, 0, 0, 600]);
  });
});
