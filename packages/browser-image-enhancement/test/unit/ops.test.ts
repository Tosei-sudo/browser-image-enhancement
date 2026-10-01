import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { linearToSrgb, srgbToLinear } from '../../src/color/srgb.js';
import { isIdentity, normalizeLevels, normalizeOp, toStage, type ChannelFn } from '../../src/ops/index.js';
import type { OpSpec } from '../../src/types.js';

let warnSpy: MockInstance;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warnSpy.mockRestore());

function fn(op: OpSpec): ChannelFn {
  const s = toStage(normalizeOp(op));
  if (s.kind !== 'channel') throw new Error('not a channel op');
  return s.fn;
}

/** Applies a channel op to an sRGB-encoded value and returns the encoded result. */
function onEncoded(op: OpSpec, e: number, c = 0): number {
  return linearToSrgb(fn(op)(srgbToLinear(e), c));
}

describe('normalizeOp', () => {
  it('keeps in-range values without warning', () => {
    expect(normalizeOp({ op: 'brightness', amount: 0.5 })).toEqual({ op: 'brightness', amount: 0.5 });
    expect(normalizeOp({ op: 'exposure', ev: -3 })).toEqual({ op: 'exposure', ev: -3 });
    expect(normalizeOp({ op: 'gamma', gamma: 2.2 })).toEqual({ op: 'gamma', gamma: 2.2 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each([
    [{ op: 'brightness', amount: 2 }, { op: 'brightness', amount: 1 }],
    [{ op: 'contrast', amount: -5 }, { op: 'contrast', amount: -1 }],
    [{ op: 'saturation', amount: 1.5 }, { op: 'saturation', amount: 1 }],
    [{ op: 'temperature', amount: -1.01 }, { op: 'temperature', amount: -1 }],
    [{ op: 'exposure', ev: 20 }, { op: 'exposure', ev: 10 }],
    [{ op: 'gamma', gamma: 0 }, { op: 'gamma', gamma: 0.1 }],
    [{ op: 'gamma', gamma: 100 }, { op: 'gamma', gamma: 10 }],
  ])('clamps %j to %j and warns', (input, expected) => {
    expect(normalizeOp(input)).toEqual(expected);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('out of range');
  });

  it('replaces NaN and non-numbers with the neutral value and warns', () => {
    expect(normalizeOp({ op: 'contrast', amount: Number.NaN })).toEqual({ op: 'contrast', amount: 0 });
    expect(normalizeOp({ op: 'gamma', gamma: '2' })).toEqual({ op: 'gamma', gamma: 1 });
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('treats a missing parameter as neutral without warning', () => {
    expect(normalizeOp({ op: 'saturation' })).toEqual({ op: 'saturation', amount: 0 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('throws on an unknown op', () => {
    expect(() => normalizeOp({ op: 'sharpen', amount: 1 })).toThrow(/Unknown correction: sharpen/);
    expect(() => normalizeOp(null)).toThrow(TypeError);
  });

  it('drops unknown extra properties', () => {
    expect(normalizeOp({ op: 'brightness', amount: 0.1, extra: 1 })).toEqual({ op: 'brightness', amount: 0.1 });
  });

  it('accepts infinities as out of range', () => {
    expect(normalizeOp({ op: 'exposure', ev: Infinity })).toEqual({ op: 'exposure', ev: 10 });
  });
});

describe('normalizeLevels', () => {
  it('fills defaults', () => {
    expect(normalizeLevels({})).toEqual({ inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1 });
    expect(normalizeLevels()).toEqual({ inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1 });
  });

  it('repairs inWhite <= inBlack', () => {
    const l = normalizeLevels({ inBlack: 0.5, inWhite: 0.4 });
    expect(l.inBlack).toBe(0.5);
    expect(l.inWhite).toBeCloseTo(0.5 + 1 / 255, 12);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('repairs inBlack = inWhite = 1', () => {
    const l = normalizeLevels({ inBlack: 1, inWhite: 1 });
    expect(l.inWhite).toBe(1);
    expect(l.inBlack).toBeCloseTo(1 - 1 / 255, 12);
  });

  it('allows outBlack > outWhite (inverts)', () => {
    expect(normalizeLevels({ outBlack: 1, outWhite: 0 })).toMatchObject({ outBlack: 1, outWhite: 0 });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('isIdentity', () => {
  it('recognizes neutral parameters', () => {
    expect(isIdentity(normalizeOp({ op: 'brightness', amount: 0 }))).toBe(true);
    expect(isIdentity(normalizeOp({ op: 'exposure', ev: 0 }))).toBe(true);
    expect(isIdentity(normalizeOp({ op: 'gamma', gamma: 1 }))).toBe(true);
    expect(isIdentity(normalizeOp({ op: 'levels' }))).toBe(true);
    expect(isIdentity(normalizeOp({ op: 'levels', outWhite: 0.9 }))).toBe(false);
    expect(isIdentity(normalizeOp({ op: 'saturation', amount: 0.01 }))).toBe(false);
  });
});

describe('correction math', () => {
  it('brightness: 0 is identity, +1 is white, -1 is black, monotonic in between', () => {
    for (const e of [0, 0.2, 0.5, 0.9, 1]) {
      expect(onEncoded({ op: 'brightness', amount: 1 }, e)).toBeCloseTo(1, 12);
      expect(onEncoded({ op: 'brightness', amount: -1 }, e)).toBe(0);
    }
    let prev = -1;
    for (let a = -1; a <= 1.0001; a += 0.1) {
      const v = onEncoded({ op: 'brightness', amount: Math.min(1, a) }, 0.4);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
    // Positive brightness lifts black; negative keeps it at black.
    expect(onEncoded({ op: 'brightness', amount: 0.5 }, 0)).toBeGreaterThan(0.5);
    expect(onEncoded({ op: 'brightness', amount: -0.5 }, 0)).toBe(0);
  });

  it('contrast pivots on sRGB mid-gray', () => {
    for (const a of [-0.8, -0.3, 0.3, 0.9]) {
      expect(onEncoded({ op: 'contrast', amount: a }, 0.5)).toBeCloseTo(0.5, 12);
    }
    // Positive spreads values away from the pivot, negative pulls them in.
    expect(onEncoded({ op: 'contrast', amount: 0.5 }, 0.3)).toBeLessThan(0.3);
    expect(onEncoded({ op: 'contrast', amount: 0.5 }, 0.7)).toBeGreaterThan(0.7);
    expect(onEncoded({ op: 'contrast', amount: -0.5 }, 0.3)).toBeGreaterThan(0.3);
    expect(onEncoded({ op: 'contrast', amount: -0.5 }, 0.7)).toBeLessThan(0.7);
    // Black stays black.
    expect(onEncoded({ op: 'contrast', amount: 0.7 }, 0)).toBe(0);
  });

  it('contrast -1 flattens everything (except pure black) to mid-gray', () => {
    for (const e of [0.01, 0.3, 0.9, 1]) expect(onEncoded({ op: 'contrast', amount: -1 }, e)).toBeCloseTo(0.5, 12);
  });

  it('contrast +1 is a threshold at mid-gray', () => {
    expect(onEncoded({ op: 'contrast', amount: 1 }, 0.45)).toBeLessThan(0.01);
    expect(onEncoded({ op: 'contrast', amount: 1 }, 0.55)).toBeGreaterThan(1);
  });

  it('exposure multiplies linear light by 2^ev', () => {
    expect(fn({ op: 'exposure', ev: 1 })(0.2, 0)).toBeCloseTo(0.4, 15);
    expect(fn({ op: 'exposure', ev: -2 })(0.8, 0)).toBeCloseTo(0.2, 15);
    expect(fn({ op: 'exposure', ev: 0.5 })(1, 0)).toBeCloseTo(Math.SQRT2, 15);
  });

  it('gamma raises linear light to 1/gamma', () => {
    expect(fn({ op: 'gamma', gamma: 2 })(0.25, 0)).toBeCloseTo(0.5, 15);
    expect(fn({ op: 'gamma', gamma: 0.5 })(0.5, 0)).toBeCloseTo(0.25, 15);
    expect(fn({ op: 'gamma', gamma: 3 })(1, 0)).toBe(1);
    expect(fn({ op: 'gamma', gamma: 3 })(0, 0)).toBe(0);
    expect(fn({ op: 'gamma', gamma: 3 })(-0.1, 0)).toBe(0);
  });

  it('saturation is a factor around luminance', () => {
    expect(toStage(normalizeOp({ op: 'saturation', amount: -1 }))).toEqual({ kind: 'saturation', factor: 0 });
    expect(toStage(normalizeOp({ op: 'saturation', amount: 0.5 }))).toEqual({ kind: 'saturation', factor: 1.5 });
  });

  it('temperature warms with +, cools with -, and keeps white at the same luminance', () => {
    const warm = fn({ op: 'temperature', amount: 0.5 });
    const cool = fn({ op: 'temperature', amount: -0.5 });
    expect(warm(0.5, 0)).toBeGreaterThan(warm(0.5, 2));
    expect(cool(0.5, 0)).toBeLessThan(cool(0.5, 2));
    for (const f of [warm, cool]) {
      const y = 0.2126 * f(1, 0) + 0.7152 * f(1, 1) + 0.0722 * f(1, 2);
      expect(y).toBeCloseTo(1, 12);
    }
  });

  it('levels maps input points to output points on the encoded scale', () => {
    const op: OpSpec = { op: 'levels', inBlack: 0.2, inWhite: 0.8, gamma: 1, outBlack: 0.1, outWhite: 0.9 };
    expect(onEncoded(op, 0.2)).toBeCloseTo(0.1, 12);
    expect(onEncoded(op, 0.8)).toBeCloseTo(0.9, 12);
    expect(onEncoded(op, 0.5)).toBeCloseTo(0.5, 12);
    // Clipped outside the input range.
    expect(onEncoded(op, 0)).toBeCloseTo(0.1, 12);
    expect(onEncoded(op, 1)).toBeCloseTo(0.9, 12);
  });

  it('levels midtone gamma > 1 brightens, < 1 darkens, endpoints fixed', () => {
    const bright: OpSpec = { op: 'levels', inBlack: 0, inWhite: 1, gamma: 2, outBlack: 0, outWhite: 1 };
    const dark: OpSpec = { op: 'levels', inBlack: 0, inWhite: 1, gamma: 0.5, outBlack: 0, outWhite: 1 };
    expect(onEncoded(bright, 0.25)).toBeCloseTo(0.5, 12);
    expect(onEncoded(dark, 0.5)).toBeCloseTo(0.25, 12);
    expect(onEncoded(bright, 0)).toBe(0);
    expect(onEncoded(bright, 1)).toBeCloseTo(1, 12);
  });

  it('levels with outBlack > outWhite inverts', () => {
    const inv: OpSpec = { op: 'levels', inBlack: 0, inWhite: 1, gamma: 1, outBlack: 1, outWhite: 0 };
    expect(onEncoded(inv, 0)).toBeCloseTo(1, 12);
    expect(onEncoded(inv, 1)).toBeCloseTo(0, 12);
    expect(onEncoded(inv, 0.3)).toBeCloseTo(0.7, 12);
  });

  it('every channel op is non-decreasing (required by the rounding fold)', () => {
    const ops: OpSpec[] = [
      { op: 'brightness', amount: 0.6 },
      { op: 'brightness', amount: -0.6 },
      { op: 'contrast', amount: 0.8 },
      { op: 'contrast', amount: -0.8 },
      { op: 'exposure', ev: 4 },
      { op: 'gamma', gamma: 0.2 },
      { op: 'temperature', amount: 1 },
      { op: 'levels', inBlack: 0.1, inWhite: 0.7, gamma: 3, outBlack: 0.2, outWhite: 0.6 },
    ];
    for (const op of ops) {
      const f = fn(op);
      for (let c = 0; c < 3; c++) {
        let prev = -Infinity;
        for (let v = -2; v <= 4; v += 0.001) {
          const y = f(v, c);
          expect(Number.isNaN(y)).toBe(false);
          if (y < prev) throw new Error(`${op.op} decreases at ${v}`);
          prev = y;
        }
      }
    }
  });
});
