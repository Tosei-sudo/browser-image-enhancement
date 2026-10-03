import { describe, expect, it } from 'vitest';
import { fromArrayBuffer } from 'geotiff';
import { imageToGeoTIFF } from '../../src/openlayers/geotiff-writer.js';
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
