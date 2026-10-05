import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fromArrayBuffer } from 'geotiff';
import { plainGeoTiff } from './fixtures.js';
import { madeOverviews, withOverviews } from '../src/overviews.js';
import { isOvrName, ovrBelongsTo, withExternalOverviews } from '../src/external-overviews.js';

/** A GeoTIFF and the .ovr GDAL 3.10 made for it (`gdaladdo -ro`, average), from test/data. */
function pair(name: string): [Blob, Blob] {
  const read = (file: string) => new Blob([readFileSync(new URL(`./data/${file}`, import.meta.url))]);
  return [read(name), read(`${name}.ovr`)];
}

async function joined(name: string) {
  const [file, ovr] = pair(name);
  const blob = await withExternalOverviews(file, ovr, { name: `${name}.ovr` });
  expect(blob).not.toBeNull();
  return { file, ovr, blob: blob!, tiff: await fromArrayBuffer(await blob!.arrayBuffer()) };
}

describe('external .ovr overviews', () => {
  it('names an .ovr for its image', () => {
    expect(isOvrName('scene.TIF.OVR')).toBe(true);
    expect(isOvrName('scene.tif')).toBe(false);
    expect(ovrBelongsTo('scene.tif.ovr', 'scene.tif')).toBe(true);
    expect(ovrBelongsTo('Scene.ovr', 'scene.TIF')).toBe(true);
    expect(ovrBelongsTo('other.tif.ovr', 'scene.tif')).toBe(false);
  });

  it('joins the levels of a deflate .ovr to the image, the pixels as GDAL averaged them', async () => {
    const { tiff, blob } = await joined('rgb.tif');
    expect(await tiff.getImageCount()).toBe(4); // 1100 → 550 → 275 → 138
    const sizes = await Promise.all([0, 1, 2, 3].map(async (i) => {
      const image = await tiff.getImage(i);
      return [image.getWidth(), image.getHeight()];
    }));
    expect(sizes).toEqual([[1100, 700], [550, 350], [275, 175], [138, 88]]);
    const full = await tiff.getImage(0);
    expect(full.getOrigin()).toEqual([500000, 4000000, 0]);
    expect(full.getGeoKeys()?.ProjectedCSTypeGeoKey).toBe(32654);
    // The pattern is (x/8 + y/8 + 40 b) mod 256: at 1/2, pixel (4, 0) covers x 8–9.
    const [r, g] = (await (await tiff.getImage(1)).readRasters({ window: [4, 0, 5, 1] })) as unknown as Uint8Array[];
    expect([r[0], g[0]]).toEqual([1, 41]);
    expect(madeOverviews(blob)).toEqual({ levels: 3, factor: 2, external: 'rgb.tif.ovr' });
  });

  it('keeps the bytes of both files, only adding directories after them', async () => {
    const { file, ovr, blob } = await joined('rgb.tif');
    const out = new Uint8Array(await blob.arrayBuffer());
    const a = new Uint8Array(await file.arrayBuffer());
    const b = new Uint8Array(await ovr.arrayBuffer());
    expect(a.subarray(8).every((v, i) => out[8 + i] === v)).toBe(true);
    const at = a.length + (a.length & 1);
    expect(b.every((v, i) => out[at + i] === v)).toBe(true);
    expect(out.length - at - b.length).toBeLessThan(2048);
  });

  it('reads JPEG (YCbCr) levels with their tables', async () => {
    const { tiff } = await joined('jpeg.tif');
    expect(await tiff.getImageCount()).toBe(4);
    const level = await tiff.getImage(3);
    const [r] = (await level.readRasters({ window: [0, 0, 138, 88] })) as unknown as Uint8Array[];
    // About the mean of the pattern: no black tiles from lost tables.
    const mean = r.reduce((s, v) => s + v, 0) / r.length;
    expect(mean).toBeGreaterThan(60);
    expect(mean).toBeLessThan(200);
  });

  it('16-bit, single band', async () => {
    const { tiff } = await joined('gray16.tif');
    expect(await tiff.getImageCount()).toBe(3); // 900 → 450 → 225
    const [v] = (await (await tiff.getImage(1)).readRasters({ window: [4, 0, 5, 1] })) as unknown as Uint16Array[];
    expect(v[0]).toBe(100);
  });

  it('a BigTIFF image with a classic TIFF .ovr gives a BigTIFF', async () => {
    const { tiff, blob } = await joined('big.tif');
    expect(new Uint8Array(await blob.slice(2, 3).arrayBuffer())[0]).toBe(43);
    expect(await tiff.getImageCount()).toBe(3); // 600 → 300 → 150
    const [v] = (await (await tiff.getImage(2)).readRasters({ window: [2, 0, 3, 1] })) as unknown as Uint8Array[];
    expect(v[0]).toBe(1); // 1/4: pixel 2 covers x 8–11
  });

  it('refuses an .ovr made for another image', async () => {
    const [, ovr] = pair('gray16.tif');
    const [file] = pair('rgb.tif');
    await expect(withExternalOverviews(file, ovr, { name: 'gray16.tif.ovr' })).rejects.toThrow(/バンド数/);
    const [, other] = pair('rgb.tif');
    await expect(withExternalOverviews(new Blob([plainGeoTiff(1100, 300)]), other, { name: 'x.ovr' })).rejects.toThrow(/合いません/);
  });

  it('is not used for an image with overviews of its own', async () => {
    const [, ovr] = pair('rgb.tif');
    const own = await withOverviews(new Blob([plainGeoTiff(1100, 700)]));
    expect(await withExternalOverviews(own!, ovr, { name: 'rgb.tif.ovr' })).toBeNull();
  });

  it('puts the image where `replace` georeferencing says', async () => {
    const [file, ovr] = pair('rgb.tif');
    const replace = [{ tag: 33922, type: 12, values: [0, 0, 0, 135, 35, 0] }];
    const blob = await withExternalOverviews(file, ovr, { name: 'rgb.tif.ovr', replace });
    const image = await (await fromArrayBuffer(await blob!.arrayBuffer())).getImage();
    expect(image.getOrigin()).toEqual([135, 35, 0]);
  });
});
