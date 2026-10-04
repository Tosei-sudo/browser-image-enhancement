import { describe, expect, it } from 'vitest';
import { fromArrayBuffer } from 'geotiff';
import { plainGeoTiff } from './fixtures.js';
import { isTiff, withOverviews } from '../src/overviews.js';

describe('withOverviews', () => {
  it('rewrites a GeoTIFF without overviews as a tiled one with them, keeping pixels and georeferencing', async () => {
    const file = new Blob([plainGeoTiff(1100, 700)]);
    expect(await isTiff(file)).toBe(true);
    const out = await withOverviews(file);
    expect(out).not.toBeNull();
    const tiff = await fromArrayBuffer(await out!.arrayBuffer());
    expect(await tiff.getImageCount()).toBe(4); // 1100 → 550 → 275 → 138
    const full = await tiff.getImage(0);
    expect([full.getWidth(), full.getHeight(), full.getSamplesPerPixel(), full.isTiled]).toEqual([1100, 700, 3, true]);
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
