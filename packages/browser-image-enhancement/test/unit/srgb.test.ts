import { describe, expect, it } from 'vitest';
import { linearToSrgb, quantize, SRGB_TO_LINEAR, srgbToLinear } from '../../src/color/srgb.js';
import { rng } from '../helpers.js';

/** The textbook definition, written independently of the implementation. */
function referenceQuantize(v: number): number {
  if (!(v > 0)) return 0;
  if (v >= 1) return 255;
  const e = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(e * 255);
}

describe('sRGB transfer functions', () => {
  it('matches known values', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 15);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.214041, 6);
    expect(linearToSrgb(0.18)).toBeCloseTo(0.461356, 6);
    expect(srgbToLinear(0.04)).toBeCloseTo(0.04 / 12.92, 15);
  });

  it('is continuous at the linear/power junction', () => {
    expect(srgbToLinear(0.04045 + 1e-12)).toBeCloseTo(srgbToLinear(0.04045), 7);
    expect(linearToSrgb(0.0031308 + 1e-12)).toBeCloseTo(linearToSrgb(0.0031308), 6);
  });

  it('round-trips encoded <-> linear', () => {
    for (let i = 0; i <= 1000; i++) {
      const v = i / 1000;
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 12);
    }
  });

  it('maps negative and NaN linear values to 0', () => {
    expect(linearToSrgb(-1)).toBe(0);
    expect(linearToSrgb(Number.NaN)).toBe(0);
  });

  it('is strictly increasing over the 8-bit table', () => {
    for (let i = 1; i < 256; i++) expect(SRGB_TO_LINEAR[i]).toBeGreaterThan(SRGB_TO_LINEAR[i - 1]);
    expect(SRGB_TO_LINEAR[0]).toBe(0);
    expect(SRGB_TO_LINEAR[255]).toBeCloseTo(1, 15);
  });
});

describe('quantize', () => {
  it('returns every 8-bit code from its own linear value', () => {
    for (let i = 0; i < 256; i++) expect(quantize(SRGB_TO_LINEAR[i])).toBe(i);
  });

  it('matches round(encode(v) * 255) on random values', () => {
    const r = rng(42);
    for (let i = 0; i < 200000; i++) {
      const v = r() * 1.2 - 0.1;
      expect(quantize(v)).toBe(referenceQuantize(v));
    }
  });

  it('matches the reference in the steep dark range', () => {
    for (let i = 0; i <= 20000; i++) {
      const v = (i / 20000) * 0.01;
      expect(quantize(v)).toBe(referenceQuantize(v));
    }
  });

  it('rounds halves up at code boundaries', () => {
    for (let k = 0; k < 255; k++) {
      const boundary = srgbToLinear((k + 0.5) / 255);
      expect(quantize(boundary)).toBe(k + 1);
      expect(quantize(boundary * (1 - 1e-9))).toBe(k);
    }
  });

  it('clamps out-of-range input', () => {
    expect(quantize(-0.5)).toBe(0);
    expect(quantize(-Infinity)).toBe(0);
    expect(quantize(Number.NaN)).toBe(0);
    expect(quantize(1.5)).toBe(255);
    expect(quantize(Infinity)).toBe(255);
  });
});
