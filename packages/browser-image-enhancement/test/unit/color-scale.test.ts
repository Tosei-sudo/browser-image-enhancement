import { describe, expect, it } from 'vitest';
import { applyPalette, colorScalePalette, colorScales, colorScaleStops } from '../../src/index.js';

const entry = (p: Uint8ClampedArray, v: number) => Array.from(p.subarray(4 * v, 4 * v + 4));

describe('colorScalePalette', () => {
  it('runs a one-color scale from black to the color', () => {
    const p = colorScalePalette('red');
    expect(p.length).toBe(1024);
    expect(entry(p, 0)).toEqual([0, 0, 0, 255]);
    expect(entry(p, 128)).toEqual([128, 0, 0, 255]);
    expect(entry(p, 255)).toEqual([255, 0, 0, 255]);
  });

  it('interpolates between stops, sorted by position', () => {
    const p = colorScalePalette([
      [1, [0, 0, 255]],
      [0, [255, 0, 0]],
      [0.5, [0, 255, 0, 0]],
    ]);
    expect(entry(p, 0)).toEqual([255, 0, 0, 255]);
    expect(entry(p, 255)).toEqual([0, 0, 255, 255]);
    // Halfway between red and the transparent green.
    const quarter = entry(p, 64);
    expect(quarter[0]).toBeGreaterThan(120);
    expect(quarter[1]).toBeGreaterThan(120);
    expect(quarter[3]).toBeGreaterThan(120);
    expect(quarter[3]).toBeLessThan(135);
  });

  it('reverses and fades', () => {
    expect(entry(colorScalePalette('cyan', { reverse: true }), 0)).toEqual([0, 255, 255, 255]);
    const faded = colorScalePalette('red', { fade: true });
    expect(entry(faded, 0)[3]).toBe(0);
    expect(entry(faded, 255)).toEqual([255, 0, 0, 255]);
  });

  it('has every preset, and refuses unknown names', () => {
    for (const name of Object.keys(colorScales)) expect(colorScaleStops(name as keyof typeof colorScales).length).toBeGreaterThan(1);
    expect(() => colorScalePalette('nope' as 'red')).toThrow(RangeError);
    expect(() => colorScalePalette([])).toThrow(RangeError);
  });
});

describe('applyPalette', () => {
  it('colors gray pixels by their value and keeps alpha', () => {
    const data = new Uint8ClampedArray([100, 100, 100, 255, 255, 255, 255, 128]);
    applyPalette(data, colorScalePalette('green'));
    expect(Array.from(data)).toEqual([0, 100, 0, 255, 0, 255, 0, 128]);
  });
});
