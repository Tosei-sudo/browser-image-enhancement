import { describe, expect, it } from 'vitest';
import { fromArrayBuffer, writeArrayBuffer } from 'geotiff';
import { fastReadRasters } from '../../src/openlayers/fast-read.js';
import { rasterToGeoTIFF } from '../../src/openlayers/geotiff-writer.js';

/*
 * geotiff.js reads through the typed-array copy exactly what it reads through
 * its own per-value DataView loop: the same arrays, types and fill values.
 */

const W = 300;
const H = 200;

function samples<T extends Uint8Array | Uint16Array | Int16Array | Float32Array>(Ctor: new (n: number) => T, bands: number): T {
  const data = new Ctor(W * H * bands);
  for (let i = 0; i < data.length; i++) data[i] = ((i * 7919) % 65521) % (Ctor === (Uint8Array as unknown) ? 256 : 30000) - (Ctor === (Int16Array as unknown) ? 15000 : 0);
  if (data instanceof Float32Array) for (let i = 0; i < data.length; i += 13) data[i] = i / 7 - 100.25;
  return data;
}

/** Counts calls of DataView's getters until `stop()`. */
function countDataViewReads() {
  const names = ['getUint8', 'getInt8', 'getUint16', 'getInt16', 'getUint32', 'getInt32', 'getFloat32', 'getFloat64'] as const;
  const proto = DataView.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const saved = names.map((n) => proto[n]);
  let count = 0;
  names.forEach((n, i) => {
    proto[n] = function (this: DataView, ...args: unknown[]) {
      count++;
      return saved[i].apply(this, args);
    };
  });
  return {
    stop() {
      names.forEach((n, i) => (proto[n] = saved[i]));
      return count;
    },
  };
}

async function images(blob: ArrayBuffer) {
  const a = await (await fromArrayBuffer(blob)).getImage(0);
  const b = await (await fromArrayBuffer(blob)).getImage(0);
  fastReadRasters(b);
  return [a, b];
}

const windows = [
  [0, 0, 256, 256], // one tile, overhanging the image at the bottom
  [256, 0, 512, 256], // the last column of tiles, mostly outside the image
  [40, 30, 290, 190], // across four tiles
  [-20, -10, 100, 50], // starting outside the image
];

describe('fastReadRasters', () => {
  for (const [name, data, bands] of [
    ['uint8 RGB', samples(Uint8Array, 3), 3],
    ['uint16 RGB', samples(Uint16Array, 3), 3],
    ['int16 gray', samples(Int16Array, 1), 1],
    ['float32 4 bands', samples(Float32Array, 4), 4],
  ] as const) {
    it(`gives geotiff.js's own arrays for ${name}`, async () => {
      const blob = rasterToGeoTIFF({ width: W, height: H, bands, data, geo: { modelPixelScale: [1, 1, 0], modelTiepoint: [0, 0, 0, 0, 0, 0] } });
      const [plain, fast] = await images(await blob.arrayBuffer());
      for (const window of windows) {
        for (const pick of [undefined, bands > 1 ? [bands - 1, 0] : [0]]) {
          const options = { window, interleave: false, fillValue: pick ? pick.map(() => 7) : 7, ...(pick ? { samples: [...pick] } : {}) };
          const want = (await plain.readRasters({ ...options, samples: options.samples && [...options.samples] })) as unknown as ArrayLike<number>[];
          const reads = countDataViewReads();
          const got = (await fast.readRasters({ ...options, samples: options.samples && [...options.samples] })) as unknown as ArrayLike<number>[];
          // Copied as typed arrays, not value by value.
          expect(reads.stop()).toBe(0);
          expect(got.length).toBe(want.length);
          for (let s = 0; s < want.length; s++) {
            expect(got[s].constructor).toBe(want[s].constructor);
            expect(Array.from(got[s])).toEqual(Array.from(want[s]));
          }
          expect([(got as unknown as { width: number }).width, (got as unknown as { height: number }).height]).toEqual([window[2] - window[0], window[3] - window[1]]);
        }
      }
    });
  }

  it('leaves resampled reads and stripped big-endian files to geotiff.js', async () => {
    const data = samples(Uint16Array, 1);
    const buffer = writeArrayBuffer(data, { width: W, height: H, BitsPerSample: [16], SampleFormat: [1], SamplesPerPixel: 1, PhotometricInterpretation: 1 });
    const [plain, fast] = await images(buffer);
    for (const options of [{ window: [0, 0, 300, 200], width: 150, height: 100 }, { window: [10, 20, 200, 120] }]) {
      const want = (await plain.readRasters({ ...options, interleave: false })) as unknown as Uint16Array[];
      const got = (await fast.readRasters({ ...options, interleave: false })) as unknown as Uint16Array[];
      expect(Array.from(got[0])).toEqual(Array.from(want[0]));
    }
  });
});
