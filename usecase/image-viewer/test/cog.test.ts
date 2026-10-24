import { describe, expect, it } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { MemorySink } from "../src/byte-sink.js";
import { encodeTile, predict, reduceQuad } from "../src/cog-codec.js";
import { writeCog, type CogCodec } from "../src/cog.js";
import {
  cutTiles,
  TiledTiffWriter,
  type TileSamples,
} from "../src/tiff-stream.js";

/** The per-tile work in the test itself, as cog-worker.ts does it. */
const inline: CogCodec = {
  async run(job) {
    if (job.kind === "encode") return { encoded: await encodeTile(job) };
    const raw = reduceQuad(job.reduce);
    return {
      raw,
      encoded: await encodeTile({
        tile: raw.slice(),
        size: job.reduce.size,
        bands: job.reduce.bands,
        compress: job.compress,
      }),
    };
  },
  close() {},
};

/** A GeoTIFF of `width` × `height`, `bands` bands of `data` in tiles of `tileSize`, with georeferencing and no data. */
async function source(
  data: TileSamples,
  width: number,
  height: number,
  bands: number,
  noData: string,
  tileSize = 128,
): Promise<File> {
  const writer = new TiledTiffWriter({
    width,
    height,
    bands,
    sample: data.subarray(0, 0) as TileSamples,
    tileSize,
    photometric: bands === 3 ? 2 : 1,
  });
  // The bottom row first: the tiles need not be in order.
  const tiles = cutTiles(data, width, height, bands, tileSize, 0, 0, 0);
  await writer.add(tiles.filter((t) => t.ty > 0));
  await writer.add(tiles.filter((t) => t.ty === 0));
  const ascii = (text: string) =>
    [...text].map((c) => c.charCodeAt(0)).concat(0);
  return writer.finish([
    { tag: 33550, type: 12, values: [10, 10, 0] },
    { tag: 33922, type: 12, values: [0, 0, 0, 500000, 4000000, 0] },
    {
      tag: 34735,
      type: 3,
      values: [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32654],
    },
    { tag: 42113, type: 2, values: ascii(noData) },
  ]);
}

async function cog(input: Blob, options: Parameters<typeof writeCog>[3] = {}) {
  const file = await writeCog(input, new MemorySink(), "out.tif", {
    codec: inline,
    ...options,
  });
  const buffer = await file.arrayBuffer();
  const tiff = await fromArrayBuffer(buffer);
  return { buffer, tiff, count: await tiff.getImageCount() };
}

describe("writeCog", () => {
  for (const tileSize of [128, 256])
    it(`writes overviews down to one tile, compressed, directories first and the smallest level first (from tiles of ${tileSize})`, async () => {
      const W = 700;
      const H = 500;
      const data = new Uint16Array(W * H * 3);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++)
          for (let b = 0; b < 3; b++)
            data[(y * W + x) * 3 + b] = (x * 3 + y * 5 + b * 1000) % 60000;
      const input = await source(data, W, H, 3, "0", tileSize);
      const { buffer, tiff, count } = await cog(input, { shift: [5, -5] });
      expect(count).toBe(3);
      const text = new TextDecoder("latin1").decode(
        new Uint8Array(buffer, 8, 60),
      );
      expect(text).toMatch(
        /^GDAL_STRUCTURAL_METADATA_SIZE=\d{6} bytes\nLAYOUT=COG\n/,
      );

      const full = await tiff.getImage(0);
      expect([
        full.getWidth(),
        full.getHeight(),
        full.getTileWidth(),
        full.getSamplesPerPixel(),
        full.getBitsPerSample(),
      ]).toEqual([W, H, 256, 3, 16]);
      expect(full.fileDirectory.getValue("Compression")).toBe(8);
      expect(await full.fileDirectory.loadValue("Predictor")).toBe(2);
      expect(full.getGDALNoData()).toBe(0);
      expect(full.getGeoKeys()?.ProjectedCSTypeGeoKey).toBe(32654);
      // Moved as the layer was.
      expect(full.getOrigin().slice(0, 2)).toEqual([500005, 3999995]);
      const read = (await full.readRasters({
        interleave: true,
      })) as unknown as Uint16Array;
      expect(read.length).toBe(data.length);
      expect(Array.from(read.subarray(0, 3000))).toEqual(
        Array.from(data.subarray(0, 3000)),
      );
      expect(Array.from(read.subarray(-3000))).toEqual(
        Array.from(data.subarray(-3000)),
      );

      const half = await tiff.getImage(1);
      expect([half.getWidth(), half.getHeight()]).toEqual([350, 250]);
      expect(half.getGDALNoData()).toBe(0);
      const h = (await half.readRasters({
        interleave: true,
      })) as unknown as Uint16Array;
      // Each pixel the average of its four (the values are a ramp: x·3 + y·5 → (2x + 0.5)·3 + (2y + 0.5)·5, rounded).
      const at = (x: number, y: number, b: number) => h[(y * 350 + x) * 3 + b];
      expect(at(10, 20, 0)).toBe(
        Math.round((2 * 10 + 0.5) * 3 + (2 * 20 + 0.5) * 5),
      );
      expect(at(300, 200, 1)).toBe(
        Math.round(((2 * 300 + 0.5) * 3 + (2 * 200 + 0.5) * 5 + 1000) % 60000),
      );
      const quarter = await tiff.getImage(2);
      expect([quarter.getWidth(), quarter.getHeight()]).toEqual([175, 125]);

      // The tiles of the smallest level come first, those of the full image last.
      const offsets = async (k: number) =>
        Array.from(
          (await (
            await tiff.getImage(k)
          ).fileDirectory.loadValue("TileOffsets")) as ArrayLike<number>,
        );
      const [o0, o1, o2] = [
        await offsets(0),
        await offsets(1),
        await offsets(2),
      ];
      expect(Math.max(...o2)).toBeLessThan(Math.min(...o1));
      expect(Math.max(...o1)).toBeLessThan(Math.min(...o0));
      // Row by row.
      expect(o0).toEqual([...o0].sort((a, b) => a - b));
      expect(buffer.byteLength).toBeLessThan(data.byteLength);
    });

  it("keeps floats exactly (floating point predictor) and leaves no data out of the averages", async () => {
    const W = 300;
    const H = 260;
    const data = new Float32Array(W * H);
    for (let i = 0; i < data.length; i++)
      data[i] = Math.sin(i / 97) * 1000 + i / 3;
    // A no-data corner.
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++) data[y * W + x] = NaN;
    data[1 * W + 1] = 8;
    const { tiff, count } = await cog(await source(data, W, H, 1, "nan"));
    expect(count).toBe(2);
    const full = await tiff.getImage(0);
    expect(await full.fileDirectory.loadValue("Predictor")).toBe(3);
    const read = (await full.readRasters({
      interleave: true,
    })) as unknown as Float32Array;
    expect(Array.from(read.subarray(2))).toEqual(Array.from(data.subarray(2)));
    const half = (await (
      await tiff.getImage(1)
    ).readRasters({ interleave: true })) as unknown as Float32Array;
    expect(half[0]).toBe(8);
  });

  it("picks values for classes, and writes as it is without compression", async () => {
    const W = 260;
    const H = 260;
    const data = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) data[y * W + x] = (x + y) % 2 ? 3 : 7;
    const { tiff } = await cog(await source(data, W, H, 1, "0"), {
      resampling: "nearest",
      compression: "none",
    });
    const full = await tiff.getImage(0);
    expect(full.fileDirectory.getValue("Compression")).toBe(1);
    const half = (await (
      await tiff.getImage(1)
    ).readRasters({ interleave: true })) as unknown as Uint8Array;
    expect(new Set(half)).toEqual(new Set([7]));
  });

  it("can be stopped", async () => {
    const data = new Uint8Array(600 * 600);
    const control = { cancelled: true };
    await expect(
      cog(await source(data, 600, 600, 1, "0"), { control }),
    ).rejects.toThrow("中止");
  });
});

describe("predict", () => {
  it("differences each sample from its left neighbour, row by row", () => {
    const tile = new Uint8Array([10, 12, 11, 5, 5, 9]);
    expect(Array.from(predict(tile, 3, 1, 2))).toEqual([10, 2, 255, 5, 0, 4]);
  });
});
