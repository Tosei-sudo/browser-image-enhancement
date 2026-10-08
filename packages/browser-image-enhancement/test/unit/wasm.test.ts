import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { compile, processPixels, type ResolvedMode } from '../../src/core/process.js';
import { configureWasm, runWasm, wasmStatus } from '../../src/core/wasm.js';
import { WASM_SOURCE_HASH } from '../../src/core/wasm-bytes.js';
import { normalizeOp } from '../../src/ops/index.js';
import type { ImageDataLike, OpSpec } from '../../src/types.js';
import { grayImage, image, noiseImage, randomOps, rng } from '../helpers.js';

afterEach(() => configureWasm({ enabled: true }));

/** Runs with WebAssembly on or off; `ran` says whether WebAssembly took the program. */
function run(img: ImageDataLike, ops: OpSpec[], mode: ResolvedMode, wasm: boolean): { data: Uint8ClampedArray; ran: boolean } {
  const program = compile(ops.map(normalizeOp), mode);
  configureWasm({ enabled: wasm });
  const data = new Uint8ClampedArray(img.data.length);
  const ran = wasm && runWasm(img.data, new Uint8ClampedArray(img.data.length), program, img.width);
  processPixels(img.data, data, program, img.width);
  return { data, ran };
}

/** Index of the first differing byte, or -1 (toEqual is slow on megabytes). */
function firstDifference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : a.length;
}

function expectSame(img: ImageDataLike, ops: OpSpec[], mode: ResolvedMode): boolean {
  const js = run(img, ops, mode, false);
  const wasm = run(img, ops, mode, true);
  expect(firstDifference(wasm.data, js.data)).toBe(-1);
  return wasm.ran;
}

/** A photo-like image: smooth gradients, some noise, opaque. */
function photo(width: number, height: number, seed = 1): ImageDataLike {
  const r = rng(seed);
  return image(width, height, (x, y) => {
    const n = r() * 24;
    return [(x * 255) / width + n, (y * 255) / height + n, ((x + y) * 128) / width + n, 255].map((v) => Math.min(255, Math.floor(v))) as [
      number,
      number,
      number,
      number,
    ];
  });
}

describe('WebAssembly engine', () => {
  it('was built from the current C sources (run npm run build:wasm)', () => {
    const h = createHash('sha256');
    for (const s of ['wasm/kernel.c', 'wasm/pow.c']) h.update(readFileSync(new URL(`../../${s}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n'));
    expect(h.digest('hex').slice(0, 16)).toBe(WASM_SOURCE_HASH);
  });

  it('is ready in Node', () => {
    expect(wasmStatus()).toBe('ready');
    configureWasm({ enabled: false });
    expect(wasmStatus()).toBe('off');
  });

  it('takes the common program shapes', () => {
    const img = photo(40, 30);
    const shapes: OpSpec[][] = [
      [{ op: 'exposure', ev: 0.5 }, { op: 'saturation', amount: 0.4 }, { op: 'contrast', amount: 0.3 }],
      [{ op: 'sharpen', amount: 1, radius: 1.5, threshold: 0 }],
      [{ op: 'temperature', amount: 0.3 }, { op: 'saturation', amount: 0.5 }, { op: 'sharpen', amount: 0.8, radius: 1, threshold: 0 }],
      [{ op: 'sharpen', amount: 0.8, radius: 2, threshold: 0.01 }, { op: 'saturation', amount: -0.4 }, { op: 'gamma', gamma: 0.8 }],
    ];
    for (const ops of shapes) expect(expectSame(img, ops, 'rgb')).toBe(true);
    expect(expectSame(grayImage(40, 30), [{ op: 'sharpen', amount: 1, radius: 1, threshold: 0 }], 'gray')).toBe(true);
  });

  it('leaves other programs to JS', () => {
    const img = photo(20, 10);
    // Plain tables; a falling levels step that cannot fold into rounding; two sharpens; forced gray around a sharpen.
    expect(expectSame(img, [{ op: 'brightness', amount: 0.2 }, { op: 'gamma', gamma: 1.4 }], 'rgb')).toBe(false);
    expect(expectSame(img, [{ op: 'saturation', amount: 0.3 }, { op: 'levels', inBlack: 0, inWhite: 1, gamma: 1, outBlack: 1, outWhite: 0 }], 'rgb')).toBe(false);
    const sharp: OpSpec = { op: 'sharpen', amount: 1, radius: 1, threshold: 0 };
    expect(expectSame(img, [sharp, sharp], 'rgb')).toBe(false);
    expect(expectSame(img, [sharp], 'gray')).toBe(false);
  });

  it('gives the JS pixels for random pipelines, with and without sharpen', () => {
    const r = rng(7);
    for (let t = 0; t < 120; t++) {
      const ops = randomOps(r);
      if (t % 2 === 1) {
        const at = Math.floor(r() * (ops.length + 1));
        ops.splice(at, 0, { op: 'sharpen', amount: r() * 3, radius: 0.3 + r() * 4, threshold: r() < 0.5 ? 0 : r() * 0.05 });
      }
      const w = 5 + Math.floor(r() * 30);
      const h = 3 + Math.floor(r() * 20);
      expectSame(t % 3 === 0 ? photo(w, h, t) : noiseImage(w, h, t), ops, 'rgb');
      expectSame(grayImage(w, h, t), ops, 'gray');
    }
  });

  it('gives the JS pixels on images larger than one chunk or band, and in place', () => {
    const img = photo(1100, 1000, 3);
    const ops: OpSpec[] = [{ op: 'saturation', amount: 0.6 }, { op: 'contrast', amount: 0.2 }];
    expect(expectSame(img, ops, 'rgb')).toBe(true);
    const program = compile(ops.map(normalizeOp), 'rgb');
    const inPlace = img.data.slice();
    processPixels(inPlace, inPlace, program, img.width);
    expect(firstDifference(inPlace, run(img, ops, 'rgb', false).data)).toBe(-1);
    // Sharpen runs in bands of rows; transparent pixels on the band edges too.
    const sharp: OpSpec[] = [{ op: 'saturation', amount: 0.4 }, { op: 'sharpen', amount: 1.5, radius: 2.5, threshold: 0 }];
    expect(expectSame(img, sharp, 'rgb')).toBe(true);
    expect(expectSame(noiseImage(700, 800, 2), sharp, 'rgb')).toBe(true);
  });

  it('handles transparent pixels and the widest blur', () => {
    const img = noiseImage(320, 12, 5);
    for (const radius of [0.1, 0.5, 7, 50]) {
      expect(expectSame(img, [{ op: 'saturation', amount: 0.5 }, { op: 'sharpen', amount: 2, radius, threshold: 0 }], 'rgb')).toBe(true);
    }
  });
});
