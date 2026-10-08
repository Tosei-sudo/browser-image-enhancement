/**
 * Writes a tiled GeoTIFF a block of tiles at a time, for images too large to
 * hold in memory at once. Each block becomes a Blob of its own as it comes
 * (the browser keeps large Blobs on disk), and the image directory goes at
 * the end, once every tile is in: header, tiles in the order they came, then
 * the directory. Uncompressed and without overviews (the viewer appends an
 * RSET when it opens the file); a BigTIFF when it would pass 4 GB.
 */

const ASCII = 2;
const SHORT = 3;
const LONG = 4;
const DOUBLE = 12;
const LONG8 = 16;
const TYPE_SIZE: Record<number, number> = { [ASCII]: 1, [SHORT]: 2, [LONG]: 4, [DOUBLE]: 8, [LONG8]: 8 };

/** A TIFF tag: values as numbers (ASCII as character codes ending in 0). */
export interface TiffEntry {
  tag: number;
  type: number;
  values: number[];
}

/** Pixel values a tile can hold. */
export type TileSamples = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;

/** One tile, `size` × `size` pixels, as little-endian bytes; `tx`, `ty` count tiles across and down. */
export interface Tile {
  tx: number;
  ty: number;
  bytes: Uint8Array;
}

export interface TiledTiffOptions {
  width: number;
  height: number;
  bands: number;
  /** Sample type, as an array of it (only its type matters). */
  sample: TileSamples;
  tileSize: number;
  /** PhotometricInterpretation (1 = gray, 2 = RGB). */
  photometric: number;
  /** ExtraSamples, one per band beyond the color ones. */
  extraSamples?: number[];
  /** Whether to write a BigTIFF. Default: only when the file would pass 4 GB. */
  bigTiff?: boolean;
}

export class TiledTiffWriter {
  readonly across: number;
  readonly down: number;
  readonly big: boolean;
  private readonly tileBytes_: number;
  private readonly offsets_: number[];
  private readonly parts_: Blob[] = [];
  private at_: number;

  constructor(private readonly options: TiledTiffOptions) {
    const { width, height, bands, tileSize, sample } = options;
    if (tileSize % 16 !== 0 || tileSize <= 0) throw new RangeError('tileSize must be a positive multiple of 16.');
    this.across = Math.ceil(width / tileSize);
    this.down = Math.ceil(height / tileSize);
    this.tileBytes_ = tileSize * tileSize * bands * sample.BYTES_PER_ELEMENT;
    // Room for the directory too: two offsets per tile and some tags.
    const total = 16 + this.across * this.down * (this.tileBytes_ + 16) + 65536;
    this.big = options.bigTiff ?? total > 0xffffffff;
    this.at_ = this.big ? 16 : 8;
    this.offsets_ = new Array<number>(this.across * this.down).fill(-1);
  }

  /** Adds tiles; each must be a whole tile (`tileSize`² × `bands` samples). */
  add(tiles: Tile[]): void {
    for (const t of tiles) {
      if (t.bytes.length !== this.tileBytes_) throw new RangeError(`A tile must be ${this.tileBytes_} bytes, got ${t.bytes.length}.`);
      const k = t.ty * this.across + t.tx;
      if (!(t.tx >= 0 && t.tx < this.across && t.ty >= 0 && t.ty < this.down) || this.offsets_[k] >= 0) throw new RangeError(`Tile ${t.tx}, ${t.ty} is outside the image or written twice.`);
      this.offsets_[k] = this.at_;
      this.at_ += t.bytes.length;
    }
    this.parts_.push(new Blob(tiles.map((t) => t.bytes as Uint8Array<ArrayBuffer>)));
  }

  /** The file, with `entries` (georeferencing, no data, metadata) added to the image's own tags. */
  finish(entries: TiffEntry[] = []): Blob {
    if (this.offsets_.some((o) => o < 0)) throw new Error('Some tiles were not written.');
    const { width, height, bands, sample, tileSize, photometric, extraSamples } = this.options;
    const all: TiffEntry[] = [
      { tag: 256, type: LONG, values: [width] },
      { tag: 257, type: LONG, values: [height] },
      { tag: 258, type: SHORT, values: new Array(bands).fill(sample.BYTES_PER_ELEMENT * 8) },
      { tag: 259, type: SHORT, values: [1] }, // no compression
      { tag: 262, type: SHORT, values: [photometric] },
      { tag: 277, type: SHORT, values: [bands] },
      { tag: 284, type: SHORT, values: [1] }, // interleaved
      { tag: 322, type: LONG, values: [tileSize] },
      { tag: 323, type: LONG, values: [tileSize] },
      { tag: 324, type: this.big ? LONG8 : LONG, values: this.offsets_ },
      { tag: 325, type: LONG, values: new Array(this.offsets_.length).fill(this.tileBytes_) },
      { tag: 339, type: SHORT, values: new Array(bands).fill(sampleFormat(sample)) },
      ...(extraSamples?.length ? [{ tag: 338, type: SHORT, values: extraSamples }] : []),
      ...entries,
    ].sort((a, b) => a.tag - b.tag);

    const ifdAt = this.at_ + (this.at_ & 1);
    const header = new DataView(new ArrayBuffer(this.big ? 16 : 8));
    header.setUint16(0, 0x4949); // "II": little-endian
    if (this.big) {
      header.setUint16(2, 43, true);
      header.setUint16(4, 8, true);
      header.setBigUint64(8, BigInt(ifdAt), true);
    } else {
      header.setUint16(2, 42, true);
      header.setUint32(4, ifdAt, true);
    }
    const ifd = directory(all, ifdAt, this.big);
    return new Blob([header.buffer, ...this.parts_, new Uint8Array(ifdAt - this.at_), ifd], { type: 'image/tiff' });
  }
}

/** The image directory at `at`, with its out-of-line values after it. */
function directory(entries: TiffEntry[], at: number, big: boolean): ArrayBuffer {
  const slot = big ? 8 : 4;
  const head = (big ? 8 : 2) + entries.length * (big ? 20 : 12) + slot;
  let size = head;
  for (const e of entries) {
    const n = TYPE_SIZE[e.type] * e.values.length;
    if (n > slot) size += n + (n & 1);
  }
  const view = new DataView(new ArrayBuffer(size));
  if (big) view.setBigUint64(0, BigInt(entries.length), true);
  else view.setUint16(0, entries.length, true);
  let p = big ? 8 : 2;
  let extra = head;
  for (const e of entries) {
    const n = TYPE_SIZE[e.type] * e.values.length;
    view.setUint16(p, e.tag, true);
    view.setUint16(p + 2, e.type, true);
    if (big) view.setBigUint64(p + 4, BigInt(e.values.length), true);
    else view.setUint32(p + 4, e.values.length, true);
    const valueAt = p + (big ? 12 : 8);
    if (n <= slot) writeValues(view, valueAt, e);
    else {
      if (big) view.setBigUint64(valueAt, BigInt(at + extra), true);
      else view.setUint32(valueAt, at + extra, true);
      writeValues(view, extra, e);
      extra += n + (n & 1);
    }
    p += big ? 20 : 12;
  }
  // The next directory: none (0, already).
  return view.buffer;
}

function writeValues(view: DataView, at: number, e: TiffEntry): void {
  const step = TYPE_SIZE[e.type];
  e.values.forEach((v, k) => {
    if (e.type === ASCII) view.setUint8(at + k, v);
    else if (e.type === SHORT) view.setUint16(at + k * step, v, true);
    else if (e.type === LONG) view.setUint32(at + k * step, v, true);
    else if (e.type === LONG8) view.setBigUint64(at + k * step, BigInt(v), true);
    else view.setFloat64(at + k * step, v, true);
  });
}

function sampleFormat(sample: TileSamples): number {
  if (sample instanceof Float32Array || sample instanceof Float64Array) return 3;
  if (sample instanceof Int8Array || sample instanceof Int16Array || sample instanceof Int32Array) return 2;
  return 1;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Cuts `width` × `height` pixels of `data` into tiles of `size`, the first at
 * tile `(tx0, ty0)`; tiles past the edge are filled with `fill`.
 */
export function cutTiles(
  data: TileSamples,
  width: number,
  height: number,
  bands: number,
  size: number,
  tx0: number,
  ty0: number,
  fill: number,
): Tile[] {
  const Type = data.constructor as new (n: number) => TileSamples;
  const tiles: Tile[] = [];
  for (let ty = 0; ty < Math.ceil(height / size); ty++) {
    for (let tx = 0; tx < Math.ceil(width / size); tx++) {
      const out = new Type(size * size * bands);
      const w = Math.min(size, width - tx * size);
      const h = Math.min(size, height - ty * size);
      if (fill !== 0 && (w < size || h < size)) out.fill(fill);
      for (let y = 0; y < h; y++) {
        const from = ((ty * size + y) * width + tx * size) * bands;
        out.set(data.subarray(from, from + w * bands), y * size * bands);
      }
      tiles.push({ tx: tx0 + tx, ty: ty0 + ty, bytes: littleEndian(out) });
    }
  }
  return tiles;
}

function littleEndian(a: TileSamples): Uint8Array {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  if (LITTLE_ENDIAN || a.BYTES_PER_ELEMENT === 1) return bytes;
  const out = new Uint8Array(bytes.length);
  const n = a.BYTES_PER_ELEMENT;
  for (let i = 0; i < bytes.length; i += n) for (let k = 0; k < n; k++) out[i + k] = bytes[i + n - 1 - k];
  return out;
}
