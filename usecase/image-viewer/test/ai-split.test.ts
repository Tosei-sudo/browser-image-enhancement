import { describe, expect, it } from 'vitest';
import { detectTile } from '../src/ai/detect-tile.js';
import { nms } from '../src/ai/detect.js';
import { detectorSpec } from '../src/ai/model-config.js';
import type { LoadedModel } from '../src/ai/runtime.js';

/**
 * A stand-in for a Detectron2 model that keeps only its best `cap` objects:
 * each bright blob of its [3, 64, 64] input is an object (the leftmost first),
 * scored by its size.
 */
function cappedModel(cap: number): { model: LoadedModel; runs: () => number } {
  let runs = 0;
  const output = (dims: number[], type: string, data: ArrayLike<number | bigint>) => ({ dims, type, getData: async () => data, dispose() {} });
  const session = {
    outputNames: ['boxes', 'classes', 'scores', 'image_size'],
    async run(feeds: Record<string, { data: Float32Array }>) {
      runs++;
      const image = Object.values(feeds)[0].data;
      const seen = new Uint8Array(64 * 64);
      const blobs: number[][] = [];
      for (let start = 0; start < 64 * 64; start++) {
        if (seen[start] || image[start] < 128) continue;
        const box = [64, 64, 0, 0];
        const stack = [start];
        seen[start] = 1;
        while (stack.length) {
          const i = stack.pop()!;
          const [x, y] = [i % 64, Math.floor(i / 64)];
          box[0] = Math.min(box[0], x);
          box[1] = Math.min(box[1], y);
          box[2] = Math.max(box[2], x + 1);
          box[3] = Math.max(box[3], y + 1);
          for (const j of [x > 0 ? i - 1 : -1, x < 63 ? i + 1 : -1, y > 0 ? i - 64 : -1, y < 63 ? i + 64 : -1]) {
            if (j < 0 || seen[j] || image[j] < 128) continue;
            seen[j] = 1;
            stack.push(j);
          }
        }
        blobs.push(box);
      }
      const kept = blobs.sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, cap);
      const n = kept.length;
      return {
        boxes: output([n, 4], 'float32', Float32Array.from(kept.flat())),
        classes: output([n], 'int64', new BigInt64Array(n)),
        // A cut object scores lower than a whole one.
        scores: output([n], 'float32', Float32Array.from(kept, (b) => 0.5 + ((b[2] - b[0]) * (b[3] - b[1])) / 100)),
        image_size: output([2], 'int64', BigInt64Array.from([64n, 64n])),
      };
    },
  };
  return { model: { name: 'capped', session, metadata: {}, backend: 'wasm' } as unknown as LoadedModel, runs: () => runs };
}

/** A 64 × 64 tile with 16 white 6-pixel squares on a black ground. */
function crowdedTile(): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(64 * 64 * 4);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const v = x % 16 >= 5 && x % 16 < 11 && y % 16 >= 5 && y % 16 < 11 ? 255 : 0;
      rgba.set([v, v, v, 255], (y * 64 + x) * 4);
    }
  }
  return rgba;
}

describe('a tile at the model limit of objects', () => {
  const spec = (maxDetections: number) => ({ ...detectorSpec({ format: 'detectron2', inputSize: [64, 64] }, {}), maxDetections });

  it('is analysed again in quarters until every object is found', async () => {
    const { model, runs } = cappedModel(8);
    const found = nms(await detectTile(model, 'image', crowdedTile(), 64, 64, 0, 0, spec(8)), 0.45);
    expect(found).toHaveLength(16);
    expect(found.map((d) => d.box).sort((a, b) => a[0] - b[0] || a[1] - b[1])[0]).toEqual([8, 8, 6, 6]);
    expect(runs()).toBeGreaterThan(1);
  });

  it('is not split when the model has no limit, or stays under it', async () => {
    const capped = cappedModel(6);
    expect(await detectTile(capped.model, 'image', crowdedTile(), 64, 64, 0, 0, spec(0))).toHaveLength(6);
    expect(capped.runs()).toBe(1);
    const roomy = cappedModel(100);
    expect(await detectTile(roomy.model, 'image', crowdedTile(), 64, 64, 0, 0, spec(100))).toHaveLength(16);
    expect(roomy.runs()).toBe(1);
  });
});
