import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { opInfo, pipeline, type NumberParamInfo, type OpName } from '../../src/index.js';
import { normalizeOp } from '../../src/ops/index.js';

let warnSpy: MockInstance;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warnSpy.mockRestore());

describe('opInfo', () => {
  it('has the ranges and defaults normalization uses', () => {
    for (const [op, info] of Object.entries(opInfo) as Array<[OpName, (typeof opInfo)[OpName]]>) {
      for (const [name, p] of Object.entries(info.params)) {
        if (p.type !== 'number') continue;
        const at = (value: number) => (normalizeOp({ op, [name]: value }) as unknown as Record<string, number>)[name];
        // levels keeps inBlack below inWhite, so those two cannot reach every end on their own.
        if (!(op === 'levels' && name === 'inWhite')) expect(at(p.min - 1000), `${op}.${name} min`).toBe(p.min);
        if (!(op === 'levels' && name === 'inBlack')) expect(at(p.max + 1000), `${op}.${name} max`).toBe(p.max);
        expect((normalizeOp({ op }) as unknown as Record<string, number>)[name], `${op}.${name} default`).toBe(p.default);
      }
    }
  });

  it('marks color-only, spatial and automatic steps', () => {
    expect(opInfo.saturation.colorOnly).toBe(true);
    expect(opInfo.sharpen.spatial).toBe(true);
    expect(opInfo.autoStretch.auto).toBe(true);
    expect((opInfo.exposure.params.ev as NumberParamInfo).max).toBe(10);
  });
});

describe('Pipeline.set / get / remove', () => {
  it('updates the first step of a kind in place, keeping its position and other parameters', () => {
    const p = pipeline().exposure(0.5).sharpen({ amount: 1, radius: 2 }).contrast(0.1);
    const q = p.set('sharpen', { radius: 3 }).set('contrast', 0.4).set('exposure', -1);
    expect(q.ops).toEqual([
      { op: 'exposure', ev: -1 },
      { op: 'sharpen', amount: 1, radius: 3, threshold: 0 },
      { op: 'contrast', amount: 0.4 },
    ]);
    expect(p.get('contrast')).toEqual({ op: 'contrast', amount: 0.1 });
  });

  it('appends a step the pipeline does not have, with defaults for missing parameters', () => {
    const p = pipeline().exposure(0.5).set('levels', { inBlack: 0.1 });
    expect(p.ops[1]).toEqual({ op: 'levels', inBlack: 0.1, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1 });
    expect(pipeline().set('sharpen', 2).get('sharpen')?.amount).toBe(2);
  });

  it('clamps like the builder methods', () => {
    expect(pipeline().set('gamma', 50).get('gamma')?.gamma).toBe(10);
  });

  it('rejects a number for steps that need an object, and unknown steps', () => {
    expect(() => pipeline().set('levels', 0.5)).toThrow(TypeError);
    expect(() => pipeline().set('nope' as OpName, 1)).toThrow(TypeError);
  });

  it('removes every step of a kind', () => {
    const p = pipeline().contrast(0.1).exposure(1).contrast(0.2);
    expect(p.remove('contrast').ops).toEqual([{ op: 'exposure', ev: 1 }]);
    expect(p.remove('gamma')).toBe(p);
    expect(p.get('gamma')).toBeUndefined();
  });

  it('knows when nothing changes', () => {
    expect(pipeline().isIdentity).toBe(true);
    expect(pipeline().contrast(0).levels({}).isIdentity).toBe(true);
    expect(pipeline().contrast(0.1).isIdentity).toBe(false);
  });
});
