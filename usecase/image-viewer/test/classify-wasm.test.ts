import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { accumulate, classColor, classify, colorClasses, emptyStats, trainModel, type ClassModel } from '../src/classify.js';
import { classifyWasm, wasmAvailable } from '../src/classify-wasm.js';
import { CLASSIFY_WASM_HASH } from '../src/classify-wasm-bytes.js';

/** `n` pixels of `dims` bands around `k` well separated looks, with some noise and a few pixels without a value. */
function scene(n: number, dims: number, k: number): { bands: Float32Array[]; labels: Uint8Array } {
  const bands = Array.from({ length: dims }, () => new Float32Array(n));
  const labels = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = Math.floor((i * 7) / 13) % k;
    for (let d = 0; d < dims; d++) bands[d][i] = 1000 * c + 300 * d * ((c % 2) + 1) + ((i * (d + 5)) % 37);
    if (i % 101 === 0) bands[i % dims][i] = NaN;
    else if (i % 5 === 0) labels[i] = c + 1;
  }
  return { bands, labels };
}

describe('classification in WebAssembly', () => {
  it('was built from the C source as it is now (npm run build:wasm)', () => {
    const source = readFileSync(new URL('../wasm/classify.c', import.meta.url));
    expect(createHash('sha256').update(source).digest('hex')).toBe(CLASSIFY_WASM_HASH);
  });

  it('puts every pixel where the JS classifier does, colors them and counts them', () => {
    expect(wasmAvailable()).toBe(true);
    // Lengths that are and are not a multiple of 4 (the SIMD lanes).
    for (const n of [4000, 4003, 1]) {
      for (const dims of [1, 3, 7]) {
        const k = 5;
        const { bands, labels } = scene(n, dims, k);
        const stats = emptyStats(k, dims);
        accumulate(stats, bands, labels, n);
        if (stats.counts.some((c) => c <= dims)) continue;
        const colors = Array.from({ length: k }, (_, c) => classColor(c + 1));
        for (const kind of ['distance', 'likelihood'] as const) {
          const model: ClassModel = trainModel(stats, kind, colors.map((_, c) => `c${c}`));
          const js = classify(bands, n, model);
          const wasm = classifyWasm(bands, n, model, colors)!;
          expect(Array.from(wasm.classes)).toEqual(Array.from(js));
          expect(Array.from(wasm.rgba)).toEqual(Array.from(colorClasses(js, colors)));
          const counts = new Array(k).fill(0);
          for (const c of js) if (c) counts[c - 1]++;
          expect(Array.from(wasm.counts)).toEqual(counts);
        }
      }
    }
  });

  it('leaves pixels without a value in every band out', () => {
    const bands = [new Float32Array([1, NaN, 9, 2, 8]), new Float32Array([1, 5, NaN, 2, 8])];
    const model: ClassModel = { kind: 'distance', dims: 2, means: new Float64Array([0, 0, 10, 10]) };
    const made = classifyWasm(bands, 5, model, [classColor(1), classColor(2)])!;
    expect(Array.from(made.classes)).toEqual([1, 0, 0, 1, 2]);
    expect(Array.from(made.counts)).toEqual([2, 1]);
  });

  it('takes no more bands than the kernel holds', () => {
    const dims = 33;
    const model: ClassModel = { kind: 'distance', dims, means: new Float64Array(dims * 2) };
    expect(classifyWasm(Array.from({ length: dims }, () => new Float32Array(4)), 4, model, [classColor(1), classColor(2)])).toBeNull();
  });
});
