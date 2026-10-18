import { describe, expect, it } from 'vitest';
import {
  classColors,
  classPalette,
  classRange,
  classShares,
  colorClasses,
  equalIntervalBreaks,
  formatClassValue,
  quantileBreaks,
  rasterHistogram,
  uniqueValues,
  type ColorClasses,
  type RasterHistogram,
} from '../../src/index.js';

const entry = (p: Uint8ClampedArray, v: number) => Array.from(p.subarray(4 * v, 4 * v + 4));

/** A histogram of `values` (a one-band raster). */
function hist(values: number[], bins?: number): RasterHistogram {
  return rasterHistogram({ data: Float32Array.from(values), width: values.length, height: 1, bands: 1 }, bins ? { bins } : {});
}

describe('classPalette', () => {
  const ranges: ColorClasses = {
    kind: 'range',
    min: 0,
    classes: [
      { value: 100, color: [255, 0, 0] },
      { value: 200, color: [0, 255, 0] },
      { value: 255, color: [0, 0, 255, 128] },
    ],
  };

  it('gives each code the color of the class its value falls in, upper bounds inclusive', () => {
    const p = classPalette(ranges, [0, 255]);
    expect(entry(p, 0)).toEqual([255, 0, 0, 255]);
    expect(entry(p, 100)).toEqual([255, 0, 0, 255]);
    expect(entry(p, 101)).toEqual([0, 255, 0, 255]);
    expect(entry(p, 200)).toEqual([0, 255, 0, 255]);
    expect(entry(p, 255)).toEqual([0, 0, 255, 128]);
  });

  it('maps codes through the value range they stand for', () => {
    // Codes 0-255 stand for 0-2550: code 100 is 1000, code 101 is 1010.
    const p = classPalette({ ...ranges, classes: ranges.classes.map((c) => ({ ...c, value: c.value * 10 })) }, [0, 2550]);
    expect(entry(p, 100)).toEqual([255, 0, 0, 255]);
    expect(entry(p, 101)).toEqual([0, 255, 0, 255]);
  });

  it('colors exact values only, the rest transparent', () => {
    const exact: ColorClasses = {
      kind: 'exact',
      classes: [
        { value: 3, color: [255, 0, 0] },
        { value: 1, color: [0, 255, 0] },
      ],
    };
    const range = classRange(exact);
    expect(range).toEqual([1, 256]);
    const p = classPalette(exact, range);
    expect(entry(p, 0)).toEqual([0, 255, 0, 255]); // value 1
    expect(entry(p, 1)[3]).toBe(0); // value 2
    expect(entry(p, 2)).toEqual([255, 0, 0, 255]); // value 3
  });

  it('spreads range classes over their bounds', () => {
    expect(classRange(ranges)).toEqual([0, 255]);
    expect(classRange({ kind: 'range', classes: [{ value: 5, color: [0, 0, 0] }] })).toEqual([5, 6]);
    expect(classRange({ kind: 'exact', classes: [{ value: 0.5, color: [0, 0, 0] }, { value: 1000, color: [0, 0, 0] }] })).toEqual([0.5, 1000]);
  });
});

describe('class breaks', () => {
  it('splits a range evenly', () => {
    expect(equalIntervalBreaks(0, 100, 4)).toEqual([25, 50, 75, 100]);
  });

  it('puts about as many pixels in each quantile class', () => {
    const values = Array.from({ length: 1000 }, (_, i) => i);
    const bounds = quantileBreaks(hist(values, 1000), 4);
    expect(bounds).toHaveLength(4);
    expect(bounds[0]).toBeGreaterThan(240);
    expect(bounds[0]).toBeLessThan(260);
    expect(bounds[3]).toBe(999);
  });

  it('merges quantile bounds that fall together', () => {
    const values = [...new Array(900).fill(0), ...Array.from({ length: 100 }, (_, i) => i + 1)];
    const bounds = quantileBreaks(hist(values, 101), 5);
    expect(bounds.length).toBeLessThan(5);
    expect(bounds[0]).toBe(0);
    expect(bounds[bounds.length - 1]).toBe(100);
  });

  it('finds the distinct values of an integer image', () => {
    const values = [1, 1, 1, 4, 4, 9];
    expect(uniqueValues(hist(values))).toEqual([
      { value: 1, count: 3 },
      { value: 4, count: 2 },
      { value: 9, count: 1 },
    ]);
    expect(uniqueValues(hist(values), 2)).toBeNull();
  });
});

describe('colorClasses', () => {
  it('makes equal classes colored along a scale, with labels', () => {
    const c = colorClasses(hist([0, 50, 100]), { count: 2, scale: 'gray' })!;
    expect(c.kind).toBe('range');
    expect(c.min).toBe(0);
    expect(c.classes.map((k) => k.value)).toEqual([50, 100]);
    expect(c.classes.map((k) => k.label)).toEqual(['0 – 50', '50 – 100']);
    expect(c.classes[0].color).toEqual([0, 0, 0, 255]);
    expect(c.classes[1].color).toEqual([255, 255, 255, 255]);
  });

  it('makes a class per value', () => {
    const c = colorClasses(hist([2, 2, 5, 7]), { method: 'unique' })!;
    expect(c.kind).toBe('exact');
    expect(c.classes.map((k) => k.value)).toEqual([2, 5, 7]);
    expect(c.classes.map((k) => k.label)).toEqual(['2', '5', '7']);
    expect(classShares(hist([2, 2, 5, 7]), c)).toEqual([0.5, 0.25, 0.25]);
  });

  it('gives the share of each range class', () => {
    const h = hist([0, 10, 20, 30, 90, 100]);
    const c = colorClasses(h, { count: 2 })!;
    expect(classShares(h, c).map((s) => Math.round(s * 6))).toEqual([4, 2]);
  });

  it('takes colors evenly, reversed on request', () => {
    expect(classColors('red', 3)).toEqual([
      [0, 0, 0, 255],
      [128, 0, 0, 255],
      [255, 0, 0, 255],
    ]);
    expect(classColors('red', 2, true)[0]).toEqual([255, 0, 0, 255]);
  });

  it('writes values with the decimals the class width needs', () => {
    expect(formatClassValue(12.3456, 0.5)).toBe('12.346');
    expect(formatClassValue(177.5, 77.5)).toBe('177.5');
    expect(formatClassValue(1200, 100)).toBe('1200');
    expect(formatClassValue(0.25, 0.05)).toBe('0.25');
  });
});
