import { describe, expect, it } from 'vitest';
import { fromArrayBuffer } from 'geotiff';
import { meshOf } from '../src/composite.js';
import { distanceToEmpty, makeMosaicBlock, resampleBands, type MosaicRead, type MosaicTask } from '../src/mosaic.js';
import { TiledTiffWriter } from '../src/tiff-stream.js';

/** An image `dx` output pixels right of the output's origin and `dy` above it, on the output's grid. */
const shifted = (dx: number, dy: number) => (xy: Float64Array) => {
  for (let k = 0; k < xy.length; k += 2) {
    xy[k] -= dx;
    xy[k + 1] += dy;
  }
};

/**
 * A `width` × `height` image of `bands` bands of `value(x, y, band)`, placed
 * `dx` output pixels right of the block (with `pad` around it) and, when
 * the block is padded, `pad` rows above it, so the block is no nearer its top
 * or bottom than the feather.
 */
function read(
  dx: number,
  width: number,
  height: number,
  value: (x: number, y: number, b: number) => number,
  block: { width: number; height: number; pad?: number },
  options: { bands?: number; noData?: number | null; zero?: boolean } = {},
): MosaicRead {
  const bands = options.bands ?? 1;
  const pad = block.pad ?? 0;
  const data = new Float32Array(width * height * bands);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let b = 0; b < bands; b++) data[(y * width + x) * bands + b] = value(x, y, b);
  const { mesh, cols, rows } = meshOf(shifted(dx, pad), -pad, -pad, block.width + 2 * pad, block.height + 2 * pad);
  return { data, bands, width, height, window: [0, 0, width, height], noData: options.noData ?? null, zeroIsEmpty: options.zero ?? false, mesh, cols, rows };
}

const task = (reads: MosaicTask['reads'], width: number, height: number, more: Partial<MosaicTask> = {}): MosaicTask => ({
  width,
  height,
  pad: 0,
  bands: 1,
  reads,
  type: { format: 3, bits: 32 },
  resample: 'nearest',
  overlap: 'priority',
  feather: 0,
  tileSize: 16,
  tx0: 0,
  ty0: 0,
  ...more,
});

/** The block's samples, from its tiles written into a GeoTIFF. */
async function samples(t: MosaicTask): Promise<number[]> {
  const block = makeMosaicBlock(t);
  const sample = t.type.format === 3 ? new Float32Array(0) : new Uint16Array(0);
  const writer = new TiledTiffWriter({ width: t.width, height: t.height, bands: t.bands, sample, tileSize: t.tileSize, photometric: 1 });
  writer.add(block.tiles);
  const blob = writer.finish([]);
  const image = await (await fromArrayBuffer(await blob.arrayBuffer())).getImage();
  return Array.from((await image.readRasters({ interleave: true })) as unknown as ArrayLike<number>);
}

describe('resampleBands', () => {
  it('copies all bands, and leaves a pixel out only when every band has no data', () => {
    const r = read(0, 3, 1, (x, _y, b) => (x === 1 ? 0 : x === 2 && b === 0 ? 0 : 10 + b), { width: 3, height: 1 }, { bands: 2, noData: 0 });
    const out = new Float32Array(6);
    const valid = new Uint8Array(3);
    expect(resampleBands(r, out, valid, 3, 1, 'nearest')).toBe(2);
    expect(Array.from(valid)).toEqual([1, 0, 1]);
    expect(Array.from(out.subarray(0, 2))).toEqual([10, 11]);
    expect(Array.from(out.subarray(4, 6))).toEqual([0, 11]); // a dark red stays
  });

  it('treats black as no data when asked', () => {
    const r = read(0, 2, 1, (x) => (x ? 5 : 0), { width: 2, height: 1 }, { bands: 3, zero: true });
    const valid = new Uint8Array(2);
    resampleBands(r, new Float32Array(6), valid, 2, 1, 'bilinear');
    expect(Array.from(valid)).toEqual([0, 1]);
  });
});

describe('distanceToEmpty', () => {
  it('counts pixels to the nearest empty one, capped', () => {
    const valid = Uint8Array.from([0, 1, 1, 1, 1, 1, 1]);
    expect(Array.from(distanceToEmpty(valid, 7, 1, 4))).toEqual([0, 1, 2, 3, 4, 4, 4]);
  });
});

describe('makeMosaicBlock', () => {
  const block = { width: 12, height: 1 };

  it('puts the first image on top, and fills its no data and the rest from the next', async () => {
    // A: pixels 0–7 (pixel 2 no data), B: pixels 4–11.
    const a = read(0, 8, 1, (x) => (x === 2 ? -1 : 100), block, { noData: -1 });
    const b = read(4, 8, 1, () => 200, block);
    expect(await samples(task([a, b], 12, 1))).toEqual([100, 100, NaN, 100, 100, 100, 100, 100, 200, 200, 200, 200]);
    expect(await samples(task([b, a], 12, 1))).toEqual([100, 100, NaN, 100, 200, 200, 200, 200, 200, 200, 200, 200]);
  });

  it('averages overlaps when asked', async () => {
    const a = read(0, 8, 1, () => 100, block);
    const b = read(4, 8, 1, () => 200, block);
    expect(await samples(task([a, b], 12, 1, { overlap: 'average' }))).toEqual([100, 100, 100, 100, 150, 150, 150, 150, 200, 200, 200, 200]);
  });

  it('feathers the first image into the next over its edge, the same across block borders', async () => {
    const wide = { width: 12, height: 1, pad: 4 };
    const a = read(0, 8, 9, () => 100, wide);
    const b = read(4, 8, 9, () => 200, wide);
    const values = await samples(task([a, b], 12, 1, { feather: 4, pad: 4 }));
    // Pixel 7 is A's last: a quarter A. Further in, more of A; A alone where B is not.
    expect(values.slice(0, 8)).toEqual([100, 100, 100, 100, 100, 125, 150, 175]);
    expect(values.slice(8)).toEqual([200, 200, 200, 200]);

    // The right half alone, as a block of its own, gets the same values.
    const half = { width: 6, height: 1, pad: 4 };
    const a2 = read(-6, 8, 9, () => 100, half);
    const b2 = read(-2, 8, 9, () => 200, half);
    expect(await samples(task([a2, b2], 6, 1, { feather: 4, pad: 4 }))).toEqual(values.slice(6));
  });

  it('rounds into integers and reports the range and the pixels covered', () => {
    const a = read(0, 4, 1, () => 101, block);
    const b = read(2, 4, 1, () => 200, block);
    const made = makeMosaicBlock(task([a, b], 12, 1, { overlap: 'average', type: { format: 1, bits: 16 } }));
    expect(made.min).toEqual([101]);
    expect(made.max).toEqual([200]);
    expect(made.covered).toBe(6);
  });
});
