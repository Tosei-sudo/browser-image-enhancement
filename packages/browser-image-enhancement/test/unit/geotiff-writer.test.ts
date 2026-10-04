import { describe, expect, it } from 'vitest';
import { fromArrayBuffer } from 'geotiff';
import { imageToGeoTIFF, rasterToGeoTIFF } from '../../src/openlayers/geotiff-writer.js';
import { noiseImage } from '../helpers.js';

async function read(blob: Blob) {
  const tiff = await fromArrayBuffer(await blob.arrayBuffer());
  const count = await tiff.getImageCount();
  const images = await Promise.all(Array.from({ length: count }, (_, i) => tiff.getImage(i)));
  return images;
}

describe('imageToGeoTIFF', () => {
  it('writes RGB tiles, overviews and georeferencing that geotiff.js reads back', async () => {
    const img = noiseImage(600, 300, 1);
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    const images = await read(imageToGeoTIFF(img, { extent: [1000, 2000, 7000, 5000], epsg: 3857 }));

    // Overviews halve the size until the image fits one 256-pixel tile.
    expect(images.map((i) => [i.getWidth(), i.getHeight()])).toEqual([[600, 300], [300, 150], [150, 75]]);
    const full = images[0];
    expect(full.getSamplesPerPixel()).toBe(3);
    expect(full.getTileWidth()).toBe(256);
    expect(full.getBoundingBox()).toEqual([1000, 2000, 7000, 5000]);
    expect(full.getGeoKeys()!.ProjectedCSTypeGeoKey).toBe(3857);

    const [r, g, b] = (await full.readRasters({ window: [0, 0, 600, 300] })) as unknown as Uint8Array[];
    for (const k of [0, 1234, 300 * 600 - 1, 257 * 600 + 299]) {
      expect([r[k], g[k], b[k]]).toEqual([img.data[k * 4], img.data[k * 4 + 1], img.data[k * 4 + 2]]);
    }
  });

  it('keeps gray images to one band and adds alpha only when needed', async () => {
    const img = { width: 40, height: 30, data: new Uint8ClampedArray(40 * 30 * 4) };
    for (let p = 0; p < 40 * 30; p++) {
      img.data.fill(p % 256, p * 4, p * 4 + 3);
      img.data[p * 4 + 3] = p === 5 ? 0 : 255;
    }
    const [full] = await read(imageToGeoTIFF(img, { extent: [139, 35, 140, 36], epsg: 4326 }));
    expect(full.getSamplesPerPixel()).toBe(2);
    expect(full.getGeoKeys()!.GeographicTypeGeoKey).toBe(4326);
    const [v, a] = (await full.readRasters()) as unknown as Uint8Array[];
    expect(v[7]).toBe(7);
    expect(a[5]).toBe(0);
    expect(a[6]).toBe(255);
  });
});

describe('rasterToGeoTIFF', () => {
  const width = 600;
  const height = 300;
  const bands = 3;
  function raster(): Uint16Array {
    const data = new Uint16Array(width * height * bands);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * bands;
        data[i] = 1000 + x;
        data[i + 1] = 2000 + y;
        data[i + 2] = x < 2 && y < 2 ? 0 : 3000; // a 2×2 block of no-data
      }
    }
    return data;
  }
  const geo = {
    modelPixelScale: [10, 10, 0],
    modelTiepoint: [0, 0, 0, 500000, 4000000, 0],
    geoKeyDirectory: [1, 1, 0, 5, 1024, 0, 1, 1, 1025, 0, 1, 1, 1026, 34737, 22, 0, 3072, 0, 1, 32654, 3076, 0, 1, 9001],
    geoAsciiParams: 'WGS 84 / UTM zone 54N|',
  };

  it('keeps the sample type, bands, values, no-data and georeferencing, and adds overviews', async () => {
    const data = raster();
    const blob = rasterToGeoTIFF({ width, height, bands, data, noData: 0, geo });
    const tiff = await fromArrayBuffer(await blob.arrayBuffer());
    expect(await tiff.getImageCount()).toBe(3); // 600 → 300 → 150
    const full = await tiff.getImage(0);
    expect([full.getWidth(), full.getHeight(), full.getSamplesPerPixel(), full.isTiled]).toEqual([width, height, bands, true]);
    expect(full.getBitsPerSample()).toBe(16);
    expect(full.getGDALNoData()).toBe(0);
    expect(full.getResolution()).toEqual([10, -10, 0]);
    expect(full.getOrigin()).toEqual([500000, 4000000, 0]);
    expect(full.getGeoKeys()?.ProjectedCSTypeGeoKey).toBe(32654);
    expect(full.getGeoKeys()?.GTCitationGeoKey).toBe('WGS 84 / UTM zone 54N');
    const back = (await full.readRasters({ interleave: true })) as unknown as Uint16Array;
    expect(back).toBeInstanceOf(Uint16Array);
    expect(Array.from(back)).toEqual(Array.from(data));

    const half = await tiff.getImage(1);
    expect([half.getWidth(), half.getHeight()]).toEqual([300, 150]);
    const h = (await half.readRasters({ interleave: true })) as unknown as Uint16Array;
    // Pixel (1, 1) of the overview averages x 2–3, y 2–3 of the full image.
    expect([h[(1 * 300 + 1) * 3], h[(1 * 300 + 1) * 3 + 1]]).toEqual([1000 + 2.5, 2000 + 2.5].map(Math.round));
    expect(h[2]).toBe(0); // the block that was all no-data stays no-data
  });

  it('writes floats and checks its input', async () => {
    const data = new Float32Array(20 * 10).map((_, i) => i / 3);
    const blob = rasterToGeoTIFF({ width: 20, height: 10, bands: 1, data, geo: {} });
    const image = await (await fromArrayBuffer(await blob.arrayBuffer())).getImage();
    expect(image.getSampleFormat()).toBe(3);
    expect(Array.from((await image.readRasters({ interleave: true })) as unknown as Float32Array)).toEqual(Array.from(data));
    expect(() => rasterToGeoTIFF({ width: 20, height: 10, bands: 2, data, geo: {} })).toThrow(RangeError);
  });
});
