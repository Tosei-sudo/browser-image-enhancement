import { describe, expect, it } from 'vitest';
import { combine, commonSampleType, gridOver, meshOf, meshWindow, resampleMesh } from '../src/composite.js';
import { fillOf, makeBlock } from '../src/composite.js';

/** An image `dx` output pixels right of the output's origin, its pixels `1 / scale` output pixels wide. */
const shifted = (dx: number, scale = 1) => (xy: Float64Array) => {
  for (let k = 0; k < xy.length; k += 2) {
    xy[k] = (xy[k] - dx) * scale;
    xy[k + 1] = xy[k + 1] * scale;
  }
};

describe('meshOf', () => {
  it('puts nodes on every step-th pixel centre, the last at or past the edge', () => {
    const { mesh, cols, rows } = meshOf((xy) => xy, 0, 0, 70, 33, 32);
    expect([cols, rows]).toEqual([4, 3]);
    expect([mesh[0], mesh[1]]).toEqual([0.5, 0.5]);
    expect(mesh[2 * 3]).toBe(96.5);
    expect(meshWindow(mesh, 50, 50)).toEqual([0, 0, 50, 50]);
  });
});

describe('resampleMesh', () => {
  const ramp = (w: number, h: number) => Float32Array.from({ length: w * h }, (_, i) => i % w);

  it('copies an image on the same grid unchanged, and leaves pixels outside it empty', () => {
    const width = 40;
    const { mesh, cols, rows } = meshOf(shifted(2), 0, 0, width, 4, 32);
    const data = ramp(30, 4);
    const out = new Float32Array(width * 4).fill(NaN);
    const read = { data, width: 30, height: 4, window: [0, 0, 30, 4] as const, noData: null, mesh, cols, rows };
    const got = resampleMesh(read, out, width, 4, 0, 1, 'bilinear', NaN, 32);
    expect(out[0]).toBeNaN(); // left of the image
    expect(out[2]).toBe(0);
    expect(out[12]).toBe(10);
    expect(out[31]).toBe(29);
    expect(out[32]).toBeNaN(); // right of it
    expect(got).toBe(30 * 4);
  });

  it('interpolates an image of twice the pixel size, and rounds into integers', () => {
    const { mesh, cols, rows } = meshOf(shifted(0, 0.5), 0, 0, 8, 2, 32);
    const data = Uint16Array.from([0, 100, 200, 300]);
    const out = new Uint16Array(8 * 2);
    resampleMesh({ data, width: 4, height: 1, window: [0, 0, 4, 1], noData: null, mesh, cols, rows }, out, 8, 2, 0, 1, 'bilinear', 0, 32);
    // Output pixel 1 (centre 1.5) is at image position 0.75: a quarter of the way from the centre of pixel 0 to that of 1. The edges are held.
    expect(Array.from(out.subarray(0, 8))).toEqual([0, 25, 75, 125, 175, 225, 275, 300]);
  });

  it('leaves no data out of the interpolation', () => {
    const { mesh, cols, rows } = meshOf(shifted(0), 0, 0, 3, 1, 32);
    const out = new Float32Array(3);
    resampleMesh({ data: Float32Array.from([10, -1, 30]), width: 3, height: 1, window: [0, 0, 3, 1], noData: -1, mesh, cols, rows }, out, 3, 1, 0, 1, 'nearest', NaN, 32);
    expect(out[0]).toBe(10);
    expect(out[1]).toBeNaN();
    expect(out[2]).toBe(30);
  });
});

describe('makeBlock', () => {
  it('fills each band from its image and cuts tiles', () => {
    const m = meshOf(shifted(0), 0, 0, 16, 16, 32);
    const a = { data: new Uint8Array(256).fill(50), width: 16, height: 16, window: [0, 0, 16, 16] as const, noData: null, ...m };
    const b = { ...a, data: new Uint8Array(256).fill(200) };
    const block = makeBlock({ width: 16, height: 16, channels: [a, b, b], type: { format: 1, bits: 8 }, resample: 'bilinear', tileSize: 16, tx0: 0, ty0: 0 });
    expect(block.tiles).toHaveLength(1);
    expect(Array.from(block.tiles[0].bytes.subarray(0, 6))).toEqual([50, 200, 200, 50, 200, 200]);
    expect(block.min).toEqual([50, 200, 200]);
    expect(block.covered).toBe(256);
  });

  it('keeps a real 0 of a 16-bit image (no data is the end of the range)', () => {
    const m = meshOf(shifted(0), 0, 0, 16, 16, 32);
    const data = new Int16Array(256).fill(0);
    data[1] = -32768;
    const a = { data, width: 16, height: 16, window: [0, 0, 16, 16] as const, noData: null, ...m };
    const block = makeBlock({ width: 16, height: 16, channels: [a], type: { format: 2, bits: 16 }, resample: 'nearest', tileSize: 16, tx0: 0, ty0: 0 });
    const out = new Int16Array(block.tiles[0].bytes.slice().buffer);
    expect(out[0]).toBe(0);
    // A value that would read as no data moves one step.
    expect(out[1]).toBe(-32767);
    expect(block.covered).toBe(256);
    expect(block.min).toEqual([-32767]);
  });
});

describe('fillOf', () => {
  it('is NaN for floats, 0 for 8-bit unsigned, else the end of the range', () => {
    expect(fillOf({ format: 3, bits: 32 })).toBeNaN();
    expect(fillOf({ format: 1, bits: 8 })).toBe(0);
    expect(fillOf({ format: 1, bits: 16 })).toBe(65535);
    expect(fillOf({ format: 2, bits: 16 })).toBe(-32768);
    expect(fillOf({ format: 2, bits: 8 })).toBe(-128);
    expect(fillOf({ format: 1, bits: 32 })).toBe(4294967295);
  });
});

describe('grids', () => {
  it('intersects or joins extents', () => {
    expect(combine([[0, 0, 10, 10], [5, -5, 20, 8]], 'intersection')).toEqual([5, 0, 10, 8]);
    expect(combine([[0, 0, 10, 10], [5, -5, 20, 8]], 'union')).toEqual([0, -5, 20, 10]);
    expect(combine([[0, 0, 1, 1], [2, 2, 3, 3]], 'intersection')).toBeNull();
  });

  it('snaps an extent to a lattice', () => {
    expect(gridOver([3.2, 1.5, 7.9, 9.1], [0, 10], [1, -1])).toEqual({ width: 5, height: 9, origin: [3, 10], resolution: [1, -1] });
  });

  it('keeps a shared sample type, else float', () => {
    expect(commonSampleType([{ format: 1, bits: 16 }, { format: 1, bits: 16 }])).toEqual({ format: 1, bits: 16 });
    expect(commonSampleType([{ format: 1, bits: 16 }, { format: 1, bits: 8 }])).toEqual({ format: 3, bits: 32 });
  });
});
