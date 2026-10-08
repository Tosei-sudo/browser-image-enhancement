import { describe, expect, it } from 'vitest';
import { fromArrayBuffer } from 'geotiff';
import { cutTiles, TiledTiffWriter } from '../src/tiff-stream.js';

/** A 3-band 16-bit image of 300 × 200 pixels whose values say where they are. */
const W = 300;
const H = 200;
const value = (x: number, y: number, b: number) => (x + 7 * y + 1000 * b) % 65536;

/** Pixels `[x0, x1) × [y0, y1)` of the image, interleaved. */
function piece(x0: number, y0: number, x1: number, y1: number): Uint16Array {
  const out = new Uint16Array((x1 - x0) * (y1 - y0) * 3);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let b = 0; b < 3; b++) out[((y - y0) * (x1 - x0) + x - x0) * 3 + b] = value(x, y, b);
  return out;
}

describe('TiledTiffWriter', () => {
  for (const bigTiff of [false, true]) {
    it(`writes tiles that came in any order as one image${bigTiff ? ' (BigTIFF)' : ''}`, async () => {
      const writer = new TiledTiffWriter({ width: W, height: H, bands: 3, sample: new Uint16Array(0), tileSize: 128, photometric: 2, bigTiff });
      expect([writer.across, writer.down]).toEqual([3, 2]);
      // Two blocks of 256 × 128 tiles... the bottom row first.
      writer.add(cutTiles(piece(0, 128, 256, 200), 256, 72, 3, 128, 0, 1, 0));
      writer.add(cutTiles(piece(256, 0, 300, 200), 44, 200, 3, 128, 2, 0, 0));
      writer.add(cutTiles(piece(0, 0, 256, 128), 256, 128, 3, 128, 0, 0, 0));
      const blob = writer.finish([{ tag: 42113, type: 2, values: [...'7'].map((c) => c.charCodeAt(0)).concat(0) }]);
      const image = await (await fromArrayBuffer(await blob.arrayBuffer())).getImage();
      expect([image.getWidth(), image.getHeight(), image.getSamplesPerPixel(), image.getBitsPerSample()]).toEqual([W, H, 3, 16]);
      expect(image.getGDALNoData()).toBe(7);
      const data = (await image.readRasters({ interleave: true })) as unknown as Uint16Array;
      expect(Array.from(data)).toEqual(Array.from(piece(0, 0, W, H)));
    });
  }

  it('refuses a tile twice, outside the image, or a missing one', () => {
    const writer = new TiledTiffWriter({ width: 32, height: 32, bands: 1, sample: new Uint8Array(0), tileSize: 16, photometric: 1 });
    const tiles = cutTiles(new Uint8Array(32 * 16), 32, 16, 1, 16, 0, 0, 0);
    writer.add(tiles);
    expect(() => writer.add(tiles.slice(0, 1))).toThrow(RangeError);
    expect(() => writer.add(cutTiles(new Uint8Array(16 * 16), 16, 16, 1, 16, 5, 0, 0))).toThrow(RangeError);
    expect(() => writer.finish()).toThrow('not written');
  });
});
