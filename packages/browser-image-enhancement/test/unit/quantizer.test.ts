import { describe, expect, it } from 'vitest';
import { quantize, SRGB_TO_LINEAR } from '../../src/color/srgb.js';
import { Quantizer } from '../../src/core/quantizer.js';
import { normalizeOp, toStage, type ChannelFn } from '../../src/ops/index.js';
import type { OpSpec } from '../../src/types.js';
import { rng } from '../helpers.js';

function compose(ops: OpSpec[], c = 0): (v: number) => number {
  const fns = ops.map((op) => (toStage(normalizeOp(op)) as { fn: ChannelFn }).fn);
  return (v) => fns.reduce((x, fn) => fn(x, c), v);
}

/** Inputs a real pipeline can produce: around [0, 1], plus negatives (after saturation) and large values (after exposure). */
function samples(seed: number): number[] {
  const r = rng(seed);
  const out: number[] = [0, -0, 1, -1, 1e-12, 0.5, 2, 1000, -1000, 1e6, -1e6];
  for (let i = 0; i < 256; i++) out.push(SRGB_TO_LINEAR[i]);
  for (let i = 0; i < 20000; i++) out.push(r() * 1.4 - 0.2);
  for (let i = 0; i < 2000; i++) out.push(r() * 0.01);
  for (let i = 0; i < 2000; i++) out.push((r() - 0.5) * 50);
  return out;
}

function expectSame(q: Quantizer, F: (v: number) => number, seed: number): void {
  for (const v of samples(seed)) {
    const want = quantize(F(v));
    const got = q.quantize(v);
    if (got !== want) expect({ v, got }).toEqual({ v, got: want });
  }
}

describe('Quantizer', () => {
  it('without a function, equals plain quantize', () => {
    expectSame(new Quantizer(), (v) => v, 1);
  });

  const cases: Array<[string, OpSpec[]]> = [
    ['brightness +', [{ op: 'brightness', amount: 0.4 }]],
    ['brightness -', [{ op: 'brightness', amount: -0.7 }]],
    ['contrast +', [{ op: 'contrast', amount: 0.6 }]],
    ['contrast -', [{ op: 'contrast', amount: -0.5 }]],
    ['contrast max (near threshold)', [{ op: 'contrast', amount: 1 }]],
    ['contrast min (constant)', [{ op: 'contrast', amount: -1 }]],
    ['exposure +', [{ op: 'exposure', ev: 3 }]],
    ['exposure -', [{ op: 'exposure', ev: -8 }]],
    ['gamma', [{ op: 'gamma', gamma: 2.2 }]],
    ['gamma small', [{ op: 'gamma', gamma: 0.1 }]],
    ['brightness max (constant white)', [{ op: 'brightness', amount: 1 }]],
    ['brightness min (constant black)', [{ op: 'brightness', amount: -1 }]],
    ['levels', [{ op: 'levels', inBlack: 0.1, inWhite: 0.9, gamma: 1.4, outBlack: 0.05, outWhite: 0.95 }]],
    ['levels inverted output', [{ op: 'levels', inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0.8, outWhite: 0.8 }]],
    [
      'chain',
      [
        { op: 'exposure', ev: 0.5 },
        { op: 'contrast', amount: 0.3 },
        { op: 'gamma', gamma: 1.3 },
        { op: 'levels', inBlack: 0.02, inWhite: 0.97, gamma: 1, outBlack: 0, outWhite: 1 },
        { op: 'brightness', amount: -0.1 },
      ],
    ],
  ];

  for (const [name, ops] of cases) {
    it(`equals quantize(F(v)) for ${name}`, () => {
      const F = compose(ops);
      expectSame(new Quantizer(F), F, name.length);
    });
  }

  it('handles per-channel temperature gains', () => {
    for (let c = 0; c < 3; c++) {
      const F = compose([{ op: 'temperature', amount: 0.8 }], c);
      expectSame(new Quantizer(F), F, 7 + c);
    }
  });

  it('equals quantize(F(v)) for random chains', () => {
    const r = rng(99);
    for (let t = 0; t < 30; t++) {
      const ops: OpSpec[] = [
        { op: 'exposure', ev: (r() - 0.5) * 4 },
        { op: 'contrast', amount: (r() - 0.5) * 1.8 },
        { op: 'gamma', gamma: 0.3 + r() * 3 },
        { op: 'brightness', amount: r() - 0.5 },
      ];
      const F = compose(ops);
      expectSame(new Quantizer(F), F, t);
    }
  });
});
