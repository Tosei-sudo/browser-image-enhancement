import { describe, expect, it } from 'vitest';
import { fromArrayBuffer, writeArrayBuffer } from 'geotiff';
import { plainGeoTiff } from './fixtures.js';
import { isTiff, withOverviews } from '../src/overviews.js';
import { reduceSamples, reduceWindow, tileDecoder, windowsOf } from '../src/reduce.js';

describe('withOverviews', () => {
  it('rewrites a GeoTIFF without overviews as a tiled one with them, keeping pixels and georeferencing', async () => {
    const file = new Blob([plainGeoTiff(1100, 700)]);
    expect(await isTiff(file)).toBe(true);
    const out = await withOverviews(file);
    expect(out).not.toBeNull();
    const tiff = await fromArrayBuffer(await out!.arrayBuffer());
    expect(await tiff.getImageCount()).toBe(4); // 1100 → 550 → 275 → 138
    const full = await tiff.getImage(0);
    expect([full.getWidth(), full.getHeight(), full.getSamplesPerPixel()]).toEqual([1100, 700, 3]);
    expect(full.getOrigin()).toEqual([500000, 4000000, 0]);
    expect(full.getResolution()).toEqual([10, -10, 0]);
    expect(full.getGeoKeys()?.ProjectedCSTypeGeoKey).toBe(32654);
    const [r] = (await full.readRasters({ window: [0, 0, 2, 1] })) as unknown as Uint8Array[];
    expect(Array.from(r)).toEqual([230, 20]);
    // Stripes average out in the overview instead of aliasing.
    const [half] = (await (await tiff.getImage(1)).readRasters({ window: [0, 0, 2, 1] })) as unknown as Uint8Array[];
    expect(Array.from(half)).toEqual([125, 125]);
  });

  it('leaves small images and images with overviews as they are', async () => {
    expect(await withOverviews(new Blob([plainGeoTiff(300, 200)]))).toBeNull();
    const withThem = await withOverviews(new Blob([plainGeoTiff(1100, 700)]));
    expect(await withOverviews(withThem!)).toBeNull();
  });
});

describe('withOverviews keeps the file and appends the levels', () => {
  it('leaves every byte after the header as it was', async () => {
    const original = plainGeoTiff(1100, 700);
    const out = new Uint8Array(await (await withOverviews(new Blob([original])))!.arrayBuffer());
    expect(out.length).toBeGreaterThan(original.length);
    expect(original.subarray(8).every((b, i) => out[8 + i] === b)).toBe(true);
  });

  it('writes in the file’s byte order: a big-endian 16-bit GeoTIFF', async () => {
    const width = 700;
    const height = 600;
    const values = new Uint16Array(width * height).map((_, i) => (i % width) * 50);
    const bytes = new Uint8Array(writeArrayBuffer(values, { width, height, BitsPerSample: [16], SampleFormat: [1], SamplesPerPixel: 1, PhotometricInterpretation: 1 }));
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe('MM');
    const tiff = await fromArrayBuffer(await (await withOverviews(new Blob([bytes])))!.arrayBuffer());
    expect(await tiff.getImageCount()).toBe(3); // 700 → 350 → 175
    const [row] = (await (await tiff.getImage(1)).readRasters({ window: [0, 0, 3, 1] })) as unknown as Uint16Array[];
    expect(Array.from(row)).toEqual([25, 125, 225]); // means of 0/50, 100/150, 200/250 (rounded)
  });

  it('appends to a BigTIFF with BigTIFF directories', async () => {
    const tiff = await fromArrayBuffer(await (await withOverviews(new Blob([bigTiffGray(600, 520)])))!.arrayBuffer());
    expect(await tiff.getImageCount()).toBe(3); // 600 → 300 → 150
    const [full] = (await (await tiff.getImage(0)).readRasters({ window: [0, 0, 2, 1] })) as unknown as Uint8Array[];
    expect(Array.from(full)).toEqual([0, 1]);
    const [half] = (await (await tiff.getImage(1)).readRasters({ window: [0, 0, 2, 1] })) as unknown as Uint8Array[];
    expect(Array.from(half)).toEqual([1, 3]); // means of 0,1 / 0,1 → 0.5 rounds to 1; 2,3 → 2.5 → 3
  });

  it('with `geo`, puts the image there and adds its range as statistics, whatever its size', async () => {
    const geo = { modelPixelScale: [0.001, 0.001, 0], modelTiepoint: [0, 0, 0, 135, 35, 0], geoKeyDirectory: [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326] };
    const out = await withOverviews(new Blob([plainGeoTiff(300, 200)]), { geo });
    const image = await (await fromArrayBuffer(await out!.arrayBuffer())).getImage();
    expect(image.getOrigin()).toEqual([135, 35, 0]);
    expect(image.getGeoKeys()?.GeographicTypeGeoKey).toBe(4326);
    expect(await image.getGDALMetadata(0)).toMatchObject({ STATISTICS_MINIMUM: '20', STATISTICS_MAXIMUM: '230' });
  });
});

describe('reducing a window at a time', () => {
  it('follows tiles, or full-width bands for strips, on multiples of f', () => {
    const tiled = windowsOf(2000, 1000, 4, 3, 512, 512);
    expect(tiled.every((w) => w.x % 4 === 0 && w.y % 4 === 0 && w.x % 512 === 0 && w.y % 512 === 0)).toBe(true);
    expect(tiled.reduce((n, w) => n + w.w * w.h, 0)).toBe(2000 * 1000);
    const striped = windowsOf(2000, 1000, 8, 3, 2000, 3);
    expect(striped.every((w) => w.x === 0 && w.w === 2000 && w.y % 8 === 0)).toBe(true);
    expect(striped.reduce((n, w) => n + w.h, 0)).toBe(1000);
  });

  it('averages f × f, leaving out no-data, with each band’s range', () => {
    // 3 × 2 pixels, one band, f = 2: [1 2 | 9] / [3 0 | 9] with 0 as no-data.
    const r = reduceSamples(new Uint8Array([1, 2, 9, 3, 0, 9]), { x: 4, y: 2, w: 3, h: 2 }, 2, 1, 0);
    expect([r.x, r.y, r.w, r.h]).toEqual([2, 1, 2, 1]);
    expect(Array.from(r.data)).toEqual([2, 9]);
    expect([r.min, r.max]).toEqual([[1], [9]]);
  });
});

/** A BigTIFF: one uncompressed strip of 8-bit gray, each pixel its x (mod 256). */
function bigTiffGray(width: number, height: number): Uint8Array<ArrayBuffer> {
  const entries: Array<[number, number, number]> = [
    [256, 4, width],
    [257, 4, height],
    [258, 3, 8],
    [259, 3, 1],
    [262, 3, 1],
    [273, 16, 0], // set below
    [277, 3, 1],
    [278, 4, height],
    [279, 16, width * height],
  ];
  const dataAt = 16 + 8 + entries.length * 20 + 8;
  const out = new Uint8Array(dataAt + width * height);
  const v = new DataView(out.buffer);
  out.set([0x49, 0x49, 43, 0, 8, 0, 0, 0]);
  v.setBigUint64(8, 16n, true);
  v.setBigUint64(16, BigInt(entries.length), true);
  entries.forEach(([tag, type, value], i) => {
    const e = 24 + i * 20;
    v.setUint16(e, tag, true);
    v.setUint16(e + 2, type, true);
    v.setBigUint64(e + 4, 1n, true);
    const x = tag === 273 ? dataAt : value;
    if (type === 3) v.setUint16(e + 12, x, true);
    else if (type === 4) v.setUint32(e + 12, x, true);
    else v.setBigUint64(e + 12, BigInt(x), true);
  });
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out[dataAt + y * width + x] = x & 255;
  return out;
}

describe('averaging straight from the tiles', () => {
  it('gives what reading the window first gives', async () => {
    const image = await (await fromArrayBuffer(plainGeoTiff(301, 203).buffer)).getImage();
    const decoder = await tileDecoder(image);
    expect(decoder).not.toBeNull();
    const win = { x: 96, y: 32, w: 205, h: 171 };
    const fast = await reduceWindow(image, win, 4, null, decoder);
    const read = await reduceWindow(image, win, 4, null);
    expect([fast.x, fast.y, fast.w, fast.h]).toEqual([24, 8, 52, 43]);
    expect(Array.from(fast.data)).toEqual(Array.from(read.data));
    expect([fast.min, fast.max]).toEqual([read.min, read.max]);
  });
});
