/**
 * JPEG 2000 codestreams (NITF IC C8 / M8) read a tile at a time: the main
 * header and where each tile's tile-parts are in the file, so a TIFF header
 * can point at every tile (see nitf-tiff.ts), and the decoder (see
 * j2k-decoder.ts) makes each one a codestream of its own and decodes it with
 * OpenJPEG (WebAssembly, bundled with the site).
 *
 * A tile becomes a codestream of its own by giving the main header an image
 * area of just that tile, at the same place on the reference grid, so its
 * wavelet and precinct partitions are those of the whole image.
 */
import { addDecoder, type BaseDecoder } from 'geotiff';

/** The private TIFF compression code of JPEG 2000 tiles. */
export const J2K_COMPRESSION = 65100;
/** The private TIFF tag (BYTE) holding the codestream's main header (without TLM and PLM). */
export const J2K_TAG = 65097;

/** What the SIZ marker says. */
export interface J2kSize {
  /** Image area on the reference grid: x0, y0 (XOsiz, YOsiz) to width, height (Xsiz, Ysiz). */
  x0: number;
  y0: number;
  width: number;
  height: number;
  /** Tile size and the tiling's origin. */
  tileWidth: number;
  tileHeight: number;
  tileX0: number;
  tileY0: number;
  components: Array<{ bits: number; signed: boolean; dx: number; dy: number }>;
  /** Where the SIZ marker is in the header. */
  at: number;
}

/** The tiles across and down. */
export function tileGrid(siz: J2kSize): [number, number] {
  return [Math.ceil((siz.width - siz.tileX0) / siz.tileWidth), Math.ceil((siz.height - siz.tileY0) / siz.tileHeight)];
}

/** Tile `index`'s area on the reference grid: x0, y0, x1, y1. */
export function tileArea(siz: J2kSize, index: number): [number, number, number, number] {
  const [across] = tileGrid(siz);
  const p = index % across;
  const q = Math.floor(index / across);
  return [
    Math.max(siz.tileX0 + p * siz.tileWidth, siz.x0),
    Math.max(siz.tileY0 + q * siz.tileHeight, siz.y0),
    Math.min(siz.tileX0 + (p + 1) * siz.tileWidth, siz.width),
    Math.min(siz.tileY0 + (q + 1) * siz.tileHeight, siz.height),
  ];
}

/** Reads the SIZ marker of a main header. */
export function readSiz(header: Uint8Array): J2kSize {
  const v = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (v.getUint16(0) !== 0xff4f || v.getUint16(2) !== 0xff51) throw new Error('JPEG 2000 のコードストリームではありません');
  const at = 2;
  const count = v.getUint16(at + 38);
  const components = Array.from({ length: count }, (_, i) => {
    const s = v.getUint8(at + 40 + i * 3);
    return { bits: (s & 0x7f) + 1, signed: (s & 0x80) !== 0, dx: v.getUint8(at + 41 + i * 3), dy: v.getUint8(at + 42 + i * 3) };
  });
  return {
    width: v.getUint32(at + 6),
    height: v.getUint32(at + 10),
    x0: v.getUint32(at + 14),
    y0: v.getUint32(at + 18),
    tileWidth: v.getUint32(at + 22),
    tileHeight: v.getUint32(at + 26),
    tileX0: v.getUint32(at + 30),
    tileY0: v.getUint32(at + 34),
    components,
    at,
  };
}

/** A codestream's main header and where each tile's bytes are. */
export interface J2kLayout {
  /** The main header, TLM and PLM left out (they describe every tile). */
  header: Uint8Array;
  siz: J2kSize;
  /** For each tile: where its tile-parts start in the file, and the bytes up to the end of its last one. */
  tiles: Array<{ offset: number; length: number }>;
  /** Whether a tile's tile-parts are apart, with other tiles' between (each tile then reads more than its own bytes). */
  interleaved: boolean;
}

/** Reads the main header of the codestream at `start` (to `end`) in `file`, and finds every tile-part. */
export async function readJ2kLayout(file: Blob, start: number, end: number): Promise<J2kLayout> {
  const read = async (from: number, length: number) => new Uint8Array(await file.slice(from, Math.min(from + length, end)).arrayBuffer());
  // The main header: markers up to the first SOT.
  let bytes = await read(start, 65536);
  let at = 2;
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  for (;;) {
    while (at + 4 > bytes.length) {
      if (start + bytes.length >= end) throw new Error('JPEG 2000 のヘッダーが途中で切れています');
      const more = await read(start + bytes.length, 1 << 20);
      const joined = new Uint8Array(bytes.length + more.length);
      joined.set(bytes);
      joined.set(more, bytes.length);
      bytes = joined;
    }
    const marker = (bytes[at] << 8) | bytes[at + 1];
    if (marker === 0xff90) break; // SOT: the first tile-part
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if ((marker & 0xff00) !== 0xff00 || length < 2) throw new Error('JPEG 2000 のヘッダーが読めません');
    if (marker === 0xff60) throw new Error('パケットヘッダーをメインヘッダーにまとめた（PPM）JPEG 2000 には対応していません');
    while (at + 2 + length > bytes.length) {
      const more = await read(start + bytes.length, 1 << 20);
      if (!more.length) throw new Error('JPEG 2000 のヘッダーが途中で切れています');
      const joined = new Uint8Array(bytes.length + more.length);
      joined.set(bytes);
      joined.set(more, bytes.length);
      bytes = joined;
    }
    if (marker !== 0xff55 && marker !== 0xff57) kept.push(bytes.subarray(at, at + 2 + length)); // TLM, PLM
    at += 2 + length;
  }
  const header = new Uint8Array(kept.reduce((n, k) => n + k.length, 0));
  kept.reduce((p, k) => (header.set(k, p), p + k.length), 0);
  const siz = readSiz(header);
  const [across, down] = tileGrid(siz);
  const parts: Array<Array<{ offset: number; length: number }>> = Array.from({ length: across * down }, () => []);

  // Each tile-part's SOT says which tile it is and how long it is.
  let p = start + at;
  while (p + 12 <= end) {
    const sot = new DataView((await read(p, 12)).buffer);
    if (sot.getUint16(0) !== 0xff90) break; // EOC, or the end
    const tile = sot.getUint16(4);
    let length = sot.getUint32(6);
    if (length === 0) length = end - p; // the last tile-part, to the end
    if (tile < parts.length) parts[tile].push({ offset: p, length });
    p += length;
  }
  let interleaved = false;
  const tiles = parts.map((list) => {
    if (!list.length) return { offset: 0, length: 0 };
    const first = list[0].offset;
    const last = list[list.length - 1];
    if (list.some((t, i) => i > 0 && t.offset !== list[i - 1].offset + list[i - 1].length)) interleaved = true;
    return { offset: first, length: last.offset + last.length - first };
  });
  return { header, siz, tiles, interleaved };
}

/**
 * A codestream of tile `index` alone: the main header with the image area
 * cut to the tile, then the tile's tile-parts (from `bytes`, which may hold
 * other tiles' too) as tile 0, then EOC.
 */
export function tileCodestream(header: Uint8Array, bytes: Uint8Array): { codestream: Uint8Array; index: number } {
  const siz = readSiz(header);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0) !== 0xff90) throw new Error('JPEG 2000 のタイルが読めません');
  const index = view.getUint16(4);
  const own: Uint8Array[] = [];
  for (let p = 0; p + 12 <= bytes.length && view.getUint16(p) === 0xff90; ) {
    let length = view.getUint32(p + 6);
    if (length === 0 || p + length > bytes.length) length = bytes.length - p;
    if (view.getUint16(p + 4) === index) {
      const part = bytes.slice(p, p + length);
      part[4] = 0;
      part[5] = 0;
      // A last tile-part (Psot 0) ends where the bytes do; it is followed by EOC here.
      if (length >= 2 && part[length - 2] === 0xff && part[length - 1] === 0xd9) own.push(part.subarray(0, length - 2));
      else own.push(part);
    }
    p += length;
  }
  const [x0, y0, x1, y1] = tileArea(siz, index);
  const head = header.slice();
  const h = new DataView(head.buffer);
  const at = siz.at;
  h.setUint32(at + 6, x1);
  h.setUint32(at + 10, y1);
  h.setUint32(at + 14, x0);
  h.setUint32(at + 18, y0);
  h.setUint32(at + 22, x1 - x0);
  h.setUint32(at + 26, y1 - y0);
  h.setUint32(at + 30, x0);
  h.setUint32(at + 34, y0);
  const total = head.length + own.reduce((n, o) => n + o.length, 0) + 2;
  const codestream = new Uint8Array(total);
  codestream.set(head);
  let p = head.length;
  for (const o of own) {
    codestream.set(o, p);
    p += o.length;
  }
  codestream[p] = 0xff;
  codestream[p + 1] = 0xd9;
  return { codestream, index };
}

addDecoder(
  J2K_COMPRESSION,
  () => import('./j2k-decoder.js').then((m) => m.default as unknown as typeof BaseDecoder),
  async (fd) => ({
    tileWidth: Number(await fd.loadValue('TileWidth')),
    tileHeight: Number(await fd.loadValue('TileLength')),
    planarConfiguration: 1,
    bitsPerSample: Array.from((await fd.loadValue('BitsPerSample')) as ArrayLike<number>, Number),
    predictor: 1,
    j2kHeader: Uint8Array.from((await fd.loadValue(J2K_TAG)) as ArrayLike<number>),
  }) as unknown as ConstructorParameters<typeof BaseDecoder>[0],
  // OpenJPEG is loaded where the tiles are read; geotiff.js's worker pool would not know this decoder.
  false,
);
