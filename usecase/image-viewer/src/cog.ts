/**
 * Writes a GeoTIFF again as a cloud optimized GeoTIFF (COG): tiled, with
 * overviews down to one tile, Deflate-compressed with the TIFF predictor, and
 * laid out as GDAL lays out a COG (the image directories first, then the
 * tiles of the smallest overview up to the full image), so QGIS, GDAL and
 * web maps read only the parts they show.
 *
 * Made a block at a time, so it works on results of many gigabytes: the full
 * image is read two tile rows at a time; each overview tile is the average
 * (or, for classes, the top-left value) of a 2 × 2 block of the level above,
 * kept uncompressed in a work file until the next overview is made from it.
 * The compressed tiles of each level go to work files too, and the COG is
 * then written in one pass: header, directories, the levels' tiles.
 */
import { fromArrayBuffer, fromBlob, type GeoTIFFImage } from 'geotiff';
import { MemorySink, type ByteSink } from './byte-sink.js';
import { typeOf, type ReduceTask, type SampleKind } from './cog-codec.js';
import { ASCII, cutTiles, directory, directorySize, LONG, LONG8, SHORT, DOUBLE, sampleFormat, type TiffEntry, type TileSamples } from './tiff-stream.js';

/** Work for cog-worker.ts. */
export type CogJob = { kind: 'encode'; tile: TileSamples; size: number; bands: number; compress: boolean } | { kind: 'reduce'; reduce: ReduceTask; compress: boolean };
export type CogReply = { ok: true; encoded: Uint8Array; raw?: TileSamples } | { ok: false; message: string };

/** Does the per-tile work: in workers, or (tests) in the page. */
export interface CogCodec {
  run(job: CogJob): Promise<{ encoded: Uint8Array; raw?: TileSamples }>;
  close(): void;
}

export interface CogOptions {
  /** Deflate with the predictor (default), or no compression. */
  compression?: 'deflate' | 'none';
  /** Overviews down to one tile (default true). */
  overviews?: boolean;
  /** How overview pixels are made: `average` (default) or `nearest` (classes). */
  resampling?: 'average' | 'nearest';
  /** Moves the image by `[dx, dy]` of its own CRS units (a layer moved on the map). */
  shift?: readonly [number, number];
  tileSize?: number;
  /** Work files (default: in the page). */
  scratch?: () => ByteSink;
  codec?: CogCodec;
  onProgress?: (fraction: number) => void;
  /** Set `cancelled` to stop. */
  control?: { cancelled: boolean };
}

/** Tags copied from the source: georeferencing, GDAL metadata and no data, palette. */
const KEEP: Record<number, number> = { 33550: DOUBLE, 33922: DOUBLE, 34264: DOUBLE, 34735: SHORT, 34736: DOUBLE, 34737: ASCII, 42112: ASCII, 42113: ASCII, 320: SHORT };
/** Of those, the ones every overview carries too. */
const ON_OVERVIEWS = new Set([42113, 320]);

/** The kind of samples of `image`. */
function sampleKind(image: GeoTIFFImage): SampleKind {
  const bits = image.getBitsPerSample(0);
  const format = image.getSampleFormat(0) || 1;
  const kind = ({ 1: { 8: 'u8', 16: 'u16', 32: 'u32' }, 2: { 8: 'i8', 16: 'i16', 32: 'i32' }, 3: { 32: 'f32', 64: 'f64' } } as Record<number, Record<number, SampleKind>>)[format]?.[bits];
  if (!kind) throw new Error(`この画素の形式（${bits} bit、SampleFormat ${format}）は COG への書き込み不可`);
  return kind;
}

/** Tag values as numbers (ASCII as character codes ending in 0). */
function valuesOf(type: number, value: unknown): number[] {
  if (type === ASCII) {
    const text = String(value);
    const codes = [...text].map((c) => c.charCodeAt(0) & 0xff);
    return codes[codes.length - 1] === 0 ? codes : [...codes, 0];
  }
  return typeof value === 'number' ? [value] : Array.from(value as ArrayLike<number>, Number);
}

/** A pool of cog-worker.ts. */
export function workerCodec(threads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))): CogCodec {
  const workers = Array.from({ length: threads }, () => new Worker(new URL('./cog-worker.ts', import.meta.url), { type: 'module' }));
  const idle = [...workers];
  const waiting: Array<() => void> = [];
  const take = async (): Promise<Worker> => {
    while (!idle.length) await new Promise<void>((resolve) => waiting.push(resolve));
    return idle.pop()!;
  };
  return {
    async run(job) {
      const worker = await take();
      try {
        return await new Promise((resolve, reject) => {
          worker.onmessage = (e: MessageEvent<CogReply>) => (e.data.ok ? resolve(e.data) : reject(new Error(e.data.message)));
          worker.onerror = (e) => reject(new Error(e.message || 'COG の処理が停止'));
          const buffer = job.kind === 'encode' ? job.tile.buffer : job.reduce.quad.buffer;
          worker.postMessage(job, [buffer as ArrayBuffer]);
        });
      } finally {
        idle.push(worker);
        waiting.shift()?.();
      }
    },
    close() {
      for (const w of workers) w.terminate();
    },
  };
}

/** One level of the COG: its size, and its compressed tiles in a work file. */
interface Level {
  width: number;
  height: number;
  across: number;
  down: number;
  /** Compressed tiles, row by row. */
  data: ByteSink;
  /** Where each tile starts in `data`, and its bytes. */
  offsets: number[];
  counts: number[];
  size: number;
  /** Uncompressed tiles, row by row, when the next level is made from them. */
  raw: ByteSink | null;
  rawFile?: Blob;
}

/**
 * Writes `input` (a GeoTIFF) as a COG into `out`: the file, named `name`.
 * Throws `中止` when stopped.
 */
export async function writeCog(input: Blob, out: ByteSink, name: string, options: CogOptions = {}): Promise<File> {
  const T = options.tileSize ?? 256;
  const compress = (options.compression ?? 'deflate') === 'deflate';
  const mode = options.resampling ?? 'average';
  const scratch: () => ByteSink = options.scratch ?? (() => new MemorySink());
  const codec = options.codec ?? workerCodec();
  const control = options.control ?? { cancelled: false };
  const stop = () => {
    if (control.cancelled) throw new Error('中止');
  };
  const sinks: ByteSink[] = [];
  const work = () => {
    const s = scratch();
    s.reserve?.(input.size);
    sinks.push(s);
    return s;
  };
  // Compressed, about as large as the input or smaller; with overviews a third more at most.
  out.reserve?.(Math.ceil(input.size * 1.4));
  try {
    // Read in parts in the browser; whole where there is no FileReader (tests).
    const image = await (typeof FileReader === 'undefined' ? await fromArrayBuffer(await input.arrayBuffer()) : await fromBlob(input)).getImage();
    const fd = image.fileDirectory;
    const width = image.getWidth();
    const height = image.getHeight();
    const bands = image.getSamplesPerPixel();
    const kind = sampleKind(image);
    const Type = typeOf(kind);
    const bytesPer = new Type(0).BYTES_PER_ELEMENT;
    const tileBytes = T * T * bands * bytesPer;
    const noData = image.getGDALNoData();
    const fill = noData !== null && Number.isFinite(noData) ? noData : 0;
    const photometric = Number(fd.getValue('PhotometricInterpretation') ?? (bands >= 3 ? 2 : 1));
    const extra = fd.hasTag(338) ? valuesOf(SHORT, await fd.loadValue(338)) : [];

    // The levels: the full image, then halves down to one tile.
    const levels: Level[] = [];
    let w = width;
    let h = height;
    for (;;) {
      levels.push({ width: w, height: h, across: Math.ceil(w / T), down: Math.ceil(h / T), data: work(), offsets: [], counts: [], size: 0, raw: null });
      if (options.overviews === false || (w <= T && h <= T)) break;
      w = Math.ceil(w / 2);
      h = Math.ceil(h / 2);
    }
    for (let k = 1; k < levels.length - 1; k++) levels[k].raw = work();
    const total = levels.reduce((n, l) => n + l.across * l.down, 0);
    let done = 0;
    const progress = (n: number) => {
      done += n;
      options.onProgress?.(done / total);
    };
    /** Adds a level's compressed tiles (in row order) to its work file. */
    const keep = async (level: Level, encoded: Uint8Array[]) => {
      for (const e of encoded) {
        level.offsets.push(level.size);
        level.counts.push(e.byteLength);
        level.size += e.byteLength;
      }
      await level.data.append(new Blob(encoded as Uint8Array<ArrayBuffer>[]));
      progress(encoded.length);
    };

    /** The uncompressed tiles of a row of the full image (from its own tiles when it is laid out so, else read and cut). */
    const sourceRow = await rowReader(image, input, T, bands, Type, fill);
    /** The uncompressed tiles of a row of a level, from its work file. */
    const rawRow = async (file: Blob, level: Level, ty: number): Promise<TileSamples[]> => {
      const buffer = await file.slice(ty * level.across * tileBytes, (ty + 1) * level.across * tileBytes).arrayBuffer();
      return Array.from({ length: level.across }, (_, tx) => new Type(buffer.slice(tx * tileBytes, (tx + 1) * tileBytes)));
    };
    /** The next level's row from two rows of `above` (the second may be past its end): compressed, and uncompressed. */
    const halve = async (above: Level, ty: number, upper: TileSamples[], lower: TileSamples[] | null) => {
      const across = Math.ceil(above.across / 2);
      const validHeight = Math.min(2 * T, above.height - 2 * ty * T);
      const made = await Promise.all(
        Array.from({ length: across }, (_, tx) => {
          const quad = new Type(4 * T * T * bands);
          if (fill !== 0) quad.fill(fill);
          const parts = [upper[2 * tx], upper[2 * tx + 1], lower?.[2 * tx], lower?.[2 * tx + 1]];
          parts.forEach((tile, p) => {
            if (!tile) return;
            const ox = (p & 1) * T;
            const oy = (p >> 1) * T;
            for (let y = 0; y < T; y++) quad.set(tile.subarray(y * T * bands, (y + 1) * T * bands), ((oy + y) * 2 * T + ox) * bands);
          });
          const validWidth = Math.min(2 * T, above.width - 2 * tx * T);
          return codec.run({ kind: 'reduce', reduce: { quad, size: T, bands, validWidth, validHeight, noData, mode }, compress });
        }),
      );
      return { encoded: made.map((m) => m.encoded), raw: made.map((m) => m.raw!) };
    };
    const asBytes = (tiles: TileSamples[]) => new Blob(tiles.map((t) => new Uint8Array(t.buffer, t.byteOffset, t.byteLength) as Uint8Array<ArrayBuffer>));

    // The full image, two tile rows at a time (compressed as they are), and the first overview from them.
    const first = levels[0];
    for (let ty = 0; ty < first.down; ty += 2) {
      stop();
      const upper = await sourceRow(ty);
      const lower = ty + 1 < first.down ? await sourceRow(ty + 1) : null;
      stop();
      const next = levels[1] ? halve(first, ty / 2, upper, lower) : null;
      for (const row of lower ? [upper, lower] : [upper]) {
        // Copies: the tiles go to the workers (and the next level needs them as they are).
        const encoded = await Promise.all(row.map((tile) => codec.run({ kind: 'encode', tile: tile.slice(), size: T, bands, compress })));
        await keep(first, encoded.map((e) => e.encoded));
      }
      if (next) {
        const made = await next;
        await keep(levels[1], made.encoded);
        if (levels[1].raw) await levels[1].raw.append(asBytes(made.raw));
      }
    }

    // The smaller overviews, each from the uncompressed tiles of the one above.
    for (let k = 2; k < levels.length; k++) {
      const above = levels[k - 1];
      const level = levels[k];
      const file = await above.raw!.close('level.raw', 'application/octet-stream');
      for (let ty = 0; ty < level.down; ty++) {
        stop();
        const upper = await rawRow(file, above, 2 * ty);
        const lower = 2 * ty + 1 < above.down ? await rawRow(file, above, 2 * ty + 1) : null;
        const made = await halve(above, ty, upper, lower);
        await keep(level, made.encoded);
        if (level.raw) await level.raw.append(asBytes(made.raw));
      }
      await sinksDone(above);
    }

    // The tags.
    const copied: TiffEntry[] = [];
    for (const [tag, type] of Object.entries(KEEP)) {
      const id = Number(tag);
      if (!fd.hasTag(id)) continue;
      const values = valuesOf(type, await fd.loadValue(id));
      copied.push({ tag: id, type, values });
    }
    const [dx, dy] = options.shift ?? [0, 0];
    if (dx || dy) {
      for (const e of copied) {
        if (e.tag === 33922) {
          for (let i = 0; i + 5 < e.values.length; i += 6) {
            e.values[i + 3] += dx;
            e.values[i + 4] += dy;
          }
        }
        if (e.tag === 34264) {
          e.values[3] += dx;
          e.values[7] += dy;
        }
      }
    }
    const predictor = compress ? (sampleFormat(new Type(0)) === 3 ? 3 : 2) : 1;
    const dataSize = levels.reduce((n, l) => n + l.size, 0);
    const big = dataSize + 1_000_000 + total * 16 > 0xffffffff;
    const entriesOf = (level: Level, k: number, offsets: number[]): TiffEntry[] =>
      [
        { tag: 254, type: LONG, values: [k ? 1 : 0] },
        { tag: 256, type: LONG, values: [level.width] },
        { tag: 257, type: LONG, values: [level.height] },
        { tag: 258, type: SHORT, values: new Array(bands).fill(bytesPer * 8) },
        { tag: 259, type: SHORT, values: [compress ? 8 : 1] },
        { tag: 262, type: SHORT, values: [photometric] },
        { tag: 277, type: SHORT, values: [bands] },
        { tag: 284, type: SHORT, values: [1] },
        ...(predictor > 1 ? [{ tag: 317, type: SHORT, values: [predictor] }] : []),
        { tag: 322, type: LONG, values: [T] },
        { tag: 323, type: LONG, values: [T] },
        { tag: 324, type: big ? LONG8 : LONG, values: offsets },
        { tag: 325, type: big ? LONG8 : LONG, values: level.counts },
        ...(extra.length ? [{ tag: 338, type: SHORT, values: extra }] : []),
        { tag: 339, type: SHORT, values: new Array(bands).fill(sampleFormat(new Type(0))) },
        ...copied.filter((e) => k === 0 || ON_OVERVIEWS.has(e.tag)),
      ].sort((a, b) => a.tag - b.tag);

    // Where everything goes: header, GDAL's note that this is a COG, the directories, then the tiles (smallest level first).
    const ghostBody = 'LAYOUT=COG\nBLOCK_ORDER=ROW_MAJOR\nBLOCK_LEADER=NONE\nBLOCK_TRAILER=NONE\nKNOWN_INCOMPATIBLE_EDITION=NO\n';
    const ghost = `GDAL_STRUCTURAL_METADATA_SIZE=${String(ghostBody.length).padStart(6, '0')} bytes\n${ghostBody}`;
    const headerSize = big ? 16 : 8;
    let at = headerSize + ghost.length;
    at += at & 1;
    const ifdAt: number[] = [];
    for (const [k, level] of levels.entries()) {
      ifdAt.push(at);
      at += directorySize(entriesOf(level, k, level.offsets), big);
      at += at & 1;
    }
    const base: number[] = new Array(levels.length);
    for (let k = levels.length - 1; k >= 0; k--) {
      base[k] = at;
      at += levels[k].size;
    }

    const head = new Uint8Array(ifdAt[0]);
    const view = new DataView(head.buffer);
    view.setUint16(0, 0x4949);
    if (big) {
      view.setUint16(2, 43, true);
      view.setUint16(4, 8, true);
      view.setBigUint64(8, BigInt(ifdAt[0]), true);
    } else {
      view.setUint16(2, 42, true);
      view.setUint32(4, ifdAt[0], true);
    }
    for (let i = 0; i < ghost.length; i++) head[headerSize + i] = ghost.charCodeAt(i);
    const parts: BlobPart[] = [head];
    for (const [k, level] of levels.entries()) {
      const ifd = directory(
        entriesOf(
          level,
          k,
          level.offsets.map((o) => base[k] + o),
        ),
        ifdAt[k],
        big,
        ifdAt[k + 1] ?? 0,
      );
      const end = k + 1 < levels.length ? ifdAt[k + 1] : base[levels.length - 1];
      parts.push(ifd, new Uint8Array(end - ifdAt[k] - ifd.byteLength));
    }
    stop();
    await out.append(new Blob(parts));
    for (let k = levels.length - 1; k >= 0; k--) {
      stop();
      const file = await levels[k].data.close('level.tif', 'application/octet-stream');
      await out.append(file);
    }
    return await out.close(name, 'image/tiff');
  } catch (error) {
    await out.abort().catch(() => {});
    throw error;
  } finally {
    if (!options.codec) codec.close();
    await Promise.all(sinks.map((s) => s.abort().catch(() => {})));
  }
}

/**
 * A reader of the full image's rows of tiles. A GeoTIFF tiled as the COG is
 * and not compressed (the viewer's own results) gives its tiles as they are,
 * a run of neighbouring tiles a read; any other is read through geotiff.js
 * and cut into tiles.
 */
async function rowReader(
  image: GeoTIFFImage,
  input: Blob,
  T: number,
  bands: number,
  Type: new (n: number | ArrayBuffer) => TileSamples,
  fill: number,
): Promise<(ty: number) => Promise<TileSamples[]>> {
  const fd = image.fileDirectory;
  const width = image.getWidth();
  const height = image.getHeight();
  const across = Math.ceil(width / T);
  const tileBytes = T * T * bands * new Type(0).BYTES_PER_ELEMENT;
  const own =
    image.isTiled &&
    image.getTileWidth() === T &&
    image.getTileHeight() === T &&
    Number(fd.getValue('Compression') ?? 1) === 1 &&
    Number(fd.getValue('PlanarConfiguration') ?? 1) === 1 &&
    (image as unknown as { littleEndian: boolean }).littleEndian &&
    new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  if (own) {
    const offsets = Array.from((await fd.loadValue('TileOffsets')) as ArrayLike<number | bigint>, Number);
    const counts = Array.from((await fd.loadValue('TileByteCounts')) as ArrayLike<number | bigint>, Number);
    if (offsets.length === across * Math.ceil(height / T) && counts.every((c) => c === tileBytes)) {
      return async (ty) => {
        const tiles: TileSamples[] = new Array(across);
        // Runs of tiles next to each other in the file: one read each.
        for (let tx = 0; tx < across; ) {
          let end = tx + 1;
          while (end < across && offsets[ty * across + end] === offsets[ty * across + end - 1] + tileBytes) end++;
          const start = offsets[ty * across + tx];
          const buffer = await input.slice(start, start + (end - tx) * tileBytes).arrayBuffer();
          for (let k = tx; k < end; k++) tiles[k] = new Type(buffer.slice((k - tx) * tileBytes, (k - tx + 1) * tileBytes));
          tx = end;
        }
        return tiles;
      };
    }
  }
  const chunk = Math.max(1, Math.floor(4096 / T));
  return async (ty) => {
    const tiles: TileSamples[] = [];
    for (let tx = 0; tx < across; tx += chunk) {
      const x0 = tx * T;
      const y0 = ty * T;
      const x1 = Math.min(width, x0 + chunk * T);
      const y1 = Math.min(height, y0 + T);
      const data = (await image.readRasters({ window: [x0, y0, x1, y1], interleave: true })) as unknown as TileSamples;
      for (const t of cutTiles(data, x1 - x0, y1 - y0, bands, T, 0, 0, fill)) tiles.push(new Type(t.bytes.buffer as ArrayBuffer));
    }
    return tiles;
  };
}

/** Frees a level's uncompressed tiles once the next level is made. */
async function sinksDone(level: Level): Promise<void> {
  await level.raw?.abort().catch(() => {});
  level.raw = null;
}
