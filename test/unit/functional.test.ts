import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  brightness,
  contrast,
  exposure,
  gamma,
  levels,
  pipeline,
  saturation,
  temperature,
} from '../../src/index.js';
import { grayImage, isGrayPixels, maxDiff, noiseImage } from '../helpers.js';

let warnSpy: MockInstance;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warnSpy.mockRestore());

const fns = [
  ['brightness', (img: any) => brightness(img, 0.3)],
  ['contrast', (img: any) => contrast(img, 0.3)],
  ['exposure', (img: any) => exposure(img, 0.7)],
  ['gamma', (img: any) => gamma(img, 1.8)],
  ['saturation', (img: any) => saturation(img, 0.5)],
  ['temperature', (img: any) => temperature(img, 0.5)],
  ['levels', (img: any) => levels(img, { inBlack: 0.1, inWhite: 0.9 })],
] as const;

describe('functional API', () => {
  for (const [name, f] of fns) {
    it(`${name} returns a new image, leaves the input alone, and changes pixels`, () => {
      const img = noiseImage(32, 16, 3);
      const before = img.data.slice();
      const out = f(img);
      expect(out).not.toBe(img);
      expect(out.data).not.toBe(img.data);
      expect(out.width).toBe(32);
      expect(out.height).toBe(16);
      expect(img.data).toEqual(before);
      expect(maxDiff(out.data, img.data)).toBeGreaterThan(0);
    });

    it(`${name} keeps a gray image gray`, () => {
      expect(isGrayPixels(f(grayImage(32, 16, 4)).data)).toBe(true);
    });
  }

  it('matches the equivalent one-step pipeline', () => {
    const img = noiseImage(32, 32, 1);
    expect(contrast(img, 0.4).data).toEqual(pipeline().contrast(0.4).runSync(img).data);
    expect(levels(img, { gamma: 1.5 }).data).toEqual(pipeline().levels({ gamma: 1.5 }).runSync(img).data);
  });

  it('chaining calls rounds between steps; the pipeline does not', () => {
    const img = noiseImage(64, 64, 2);
    const chained = exposure(exposure(img, -5), 5);
    const piped = pipeline().exposure(-5).exposure(5).runSync(img);
    expect(piped.data).toEqual(img.data);
    expect(maxDiff(chained.data, img.data)).toBeGreaterThan(0);
  });

  it('warns once when color corrections are asked of a monochrome image', () => {
    const img = grayImage(8, 8);
    const out = saturation(img, 0.8);
    expect(out.data).toEqual(img.data);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/saturation has no effect on a monochrome image/);
  });

  it("does not warn for colorMode: 'rgb' on a monochrome image, and tints it", () => {
    const out = temperature(grayImage(8, 8), 0.8, { colorMode: 'rgb' });
    expect(isGrayPixels(out.data)).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("colorMode: 'gray' produces a gray image from a color one", () => {
    expect(isGrayPixels(brightness(noiseImage(8, 8), 0.1, { colorMode: 'gray' }).data)).toBe(true);
  });

  it('clamps out-of-range parameters with a warning instead of throwing', () => {
    const img = noiseImage(8, 8);
    expect(brightness(img, 5).data).toEqual(brightness(img, 1).data);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('rejects malformed images', () => {
    expect(() => brightness({ data: new Uint8ClampedArray(3), width: 1, height: 1 }, 0.1)).toThrow(RangeError);
    expect(() => brightness({ data: new Uint8ClampedArray(0), width: 0, height: 0 }, 0.1)).toThrow(RangeError);
    expect(() => brightness({ data: [1, 2, 3, 4] as any, width: 1, height: 1 }, 0.1)).toThrow(TypeError);
    expect(() => brightness({ data: new Uint8ClampedArray(4), width: 1.5, height: 1 } as any, 0.1)).toThrow(RangeError);
  });

  it('rejects non-sRGB ImageData and points to the pipeline', () => {
    const img = { data: new Uint8ClampedArray(4), width: 1, height: 1, colorSpace: 'display-p3' };
    expect(() => brightness(img, 0.1)).toThrow(/pipeline/);
  });
});
