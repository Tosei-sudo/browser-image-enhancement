/**
 * External overviews: the `.ovr` file GDAL writes next to a GeoTIFF
 * (`gdaladdo -ro`, or QGIS's 「ピラミッドを作成」 with the external option).
 * It is a TIFF whose images are the overview levels of the image, finest
 * first, without georeferencing.
 *
 * Like the overviews the viewer makes (overviews.ts), they are joined to the
 * image as one TIFF, without copying pixels: a Blob made of the image file and
 * the .ovr file as they are, followed by a copy of the image's first
 * directory leading on to copies of the .ovr's directories, their tile
 * offsets moved by where the .ovr now starts. Only the directories are read
 * when the file opens; the tiles are read from the two files when shown.
 */
import { recordOverviews } from './overviews.js';

/** Whether `name` is an external overview file (`image.tif.ovr`, or `image.ovr`). */
export function isOvrName(name: string): boolean {
  return /\.ovr$/i.test(name);
}

/** Whether `ovr` is named for the image `image` (`a.tif.ovr` or `a.ovr` for `a.tif`), ignoring case. */
export function ovrBelongsTo(ovr: string, image: string): boolean {
  const name = ovr.toLowerCase().replace(/\.ovr$/, '');
  const of = image.toLowerCase();
  return name === of || name === of.replace(/\.[^.]*$/, '');
}

/**
 * The GeoTIFF `file` with the levels of its external overview file `ovr`.
 * `replace` entries (new georeferencing) take the place of the image's own.
 * Null when the image has overviews of its own, which GDAL uses before an
 * .ovr too. Throws, with a message for the user, when the .ovr does not fit
 * the image.
 */
export async function withExternalOverviews(
  file: Blob,
  ovr: Blob,
  { name, replace = [] }: { name: string; replace?: Array<{ tag: number; type: number; values: number[] }> },
): Promise<Blob | null> {
  const main = await readTiff(file, 2);
  const le = main.le;
  if (main.ifds.slice(1).some((ifd) => !((numberOf(ifd, 254, le) ?? 0) & 4))) return null;
  const over = await readTiff(ovr, Infinity);
  if (over.le !== le) throw new Error('バイト順が画像と違います');
  const image = main.ifds[0];
  const width = numberOf(image, 256, le)!;
  const height = numberOf(image, 257, le)!;
  const bands = numberOf(image, 277, le) ?? 1;
  const bits = numberOf(image, 258, le);
  // Masks (of a mask band) are left out; GDAL keeps those in a .msk file anyway.
  const levels = over.ifds.filter((ifd) => !((numberOf(ifd, 254, le) ?? 0) & 4));
  if (!levels.length) throw new Error('縮小画像がありません');
  let previous = width;
  for (const level of levels) {
    const w = numberOf(level, 256, le)!;
    const h = numberOf(level, 257, le)!;
    if ((numberOf(level, 277, le) ?? 1) !== bands) throw new Error(`バンド数が画像（${bands}）と違います`);
    if (numberOf(level, 258, le) !== bits) throw new Error(`ビット深度が画像（${bits}）と違います`);
    // Each level is smaller, with the image's shape (to a pixel or two of rounding, or 2 %).
    if (!(w < previous) || Math.abs((w * height) / width - h) > Math.max(2, h * 0.02)) {
      throw new Error(`${w}×${h} の縮小画像が ${width}×${height} の画像に合いません`);
    }
    previous = w;
  }

  // BigTIFF when either file is one, or when together they pass what a TIFF can address.
  const big = main.big || over.big || file.size + ovr.size + 64 * 1024 * 1024 > 0xffffffff;
  const headerLength = big ? 16 : 8;
  // A BigTIFF header is longer than a TIFF's: what it covers must not be pixels.
  if (!main.big && big && dataOffsets(image, le).some((o) => o < headerLength)) throw new Error('画像の先頭に画素があり、BigTIFF にできません');

  const ovrAt = file.size + (file.size & 1);
  const replaced = new Set(replace.map((e) => e.tag));
  const first = [...image.entries.filter((e) => !replaced.has(e.tag)), ...replace.map((e) => entry(e.tag, e.type, e.values, le))];
  const copies = levels.map((level) => [
    entry(254, LONG, [1], le), // NewSubfileType: reduced-resolution image
    ...level.entries
      // Pointers to other directories (sub-images, Exif) would point into the .ovr as it was.
      .filter((e) => ![254, 330, 34665, 34853].includes(e.tag))
      .map((e) => (e.tag === 273 || e.tag === 324 ? entry(e.tag, big ? LONG8 : LONG, valuesOf(e, le).map((o) => o + ovrAt), le) : e)),
  ]);
  const directories = writeDirectories([first, ...copies], ovrAt + ovr.size + (ovr.size & 1), le, big);

  const header = new DataView(new ArrayBuffer(headerLength));
  header.setUint16(0, le ? 0x4949 : 0x4d4d);
  header.setUint16(2, big ? 43 : 42, le);
  if (big) {
    header.setUint16(4, 8, le);
    header.setBigUint64(8, BigInt(directories.at), le);
  } else {
    header.setUint32(4, directories.at, le);
  }
  const blob = new Blob(
    [header.buffer, file.slice(headerLength), new Uint8Array(ovrAt - file.size), ovr, new Uint8Array(ovr.size & 1), directories.bytes],
    { type: 'image/tiff' },
  );
  const factor = Math.round(width / numberOf(levels[0], 256, le)!);
  recordOverviews(blob, { levels: levels.length, factor, external: name });
  return blob;
}

// ---- Reading and writing image directories, whole ----

const BYTE = 1;
const ASCII = 2;
const SHORT = 3;
const LONG = 4;
const DOUBLE = 12;
const LONG8 = 16;
/** Bytes of one value of each TIFF type. */
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };

/** An entry with its values as bytes in the file's byte order: whatever its type, it is written back as it was read. */
interface TiffEntry {
  tag: number;
  type: number;
  count: number;
  bytes: Uint8Array;
}

interface Ifd {
  entries: TiffEntry[];
}

/** The byte order, TIFF or BigTIFF, and the first `max` directories of `file`, their values read. */
async function readTiff(file: Blob, max: number): Promise<{ le: boolean; big: boolean; ifds: Ifd[] }> {
  const read = async (from: number, length: number) => new Uint8Array(await file.slice(from, from + length).arrayBuffer());
  const head = new DataView((await read(0, 16)).buffer);
  const order = head.byteLength >= 4 ? head.getUint16(0) : 0;
  if (order !== 0x4949 && order !== 0x4d4d) throw new Error('TIFF ではありません');
  const le = order === 0x4949;
  const big = head.getUint16(2, le) === 43;
  const pointerSize = big ? 8 : 4;
  const entrySize = big ? 20 : 12;
  const countSize = big ? 8 : 2;
  const ifds: Ifd[] = [];
  const seen = new Set<number>();
  let next = big ? Number(head.getBigUint64(8, le)) : head.getUint32(4, le);
  while (next && ifds.length < max && !seen.has(next)) {
    seen.add(next);
    const countView = new DataView((await read(next, countSize)).buffer);
    const count = big ? Number(countView.getBigUint64(0, le)) : countView.getUint16(0, le);
    const body = await read(next + countSize, count * entrySize + pointerSize);
    const view = new DataView(body.buffer);
    const entries: TiffEntry[] = [];
    for (let i = 0; i < count; i++) {
      const e = i * entrySize;
      const tag = view.getUint16(e, le);
      const type = view.getUint16(e + 2, le);
      const n = big ? Number(view.getBigUint64(e + 4, le)) : view.getUint32(e + 4, le);
      const size = (TYPE_SIZE[type] ?? 1) * n;
      const valueAt = e + (big ? 12 : 8);
      let bytes: Uint8Array;
      if (size <= pointerSize) bytes = body.slice(valueAt, valueAt + size);
      else bytes = await read(big ? Number(view.getBigUint64(valueAt, le)) : view.getUint32(valueAt, le), size);
      entries.push({ tag, type, count: n, bytes });
    }
    ifds.push({ entries });
    const p = count * entrySize;
    next = big ? Number(view.getBigUint64(p, le)) : view.getUint32(p, le);
  }
  if (!ifds.length) throw new Error('画像がありません');
  return { le, big, ifds };
}

/** The numbers of an integer (or floating-point) entry. */
function valuesOf(e: TiffEntry, le: boolean): number[] {
  const view = new DataView(e.bytes.buffer, e.bytes.byteOffset, e.bytes.byteLength);
  const step = TYPE_SIZE[e.type];
  return Array.from({ length: e.count }, (_, k) => {
    const p = k * step;
    switch (e.type) {
      case BYTE:
      case 7:
        return view.getUint8(p);
      case SHORT:
        return view.getUint16(p, le);
      case LONG:
      case 13:
        return view.getUint32(p, le);
      case LONG8:
      case 18:
        return Number(view.getBigUint64(p, le));
      case DOUBLE:
        return view.getFloat64(p, le);
      default:
        return NaN;
    }
  });
}

function numberOf(ifd: Ifd, tag: number, le: boolean): number | undefined {
  const e = ifd.entries.find((x) => x.tag === tag);
  return e ? valuesOf(e, le)[0] : undefined;
}

/** Where a directory's tiles or strips start in the file. */
function dataOffsets(ifd: Ifd, le: boolean): number[] {
  return ifd.entries.filter((e) => e.tag === 273 || e.tag === 324).flatMap((e) => valuesOf(e, le));
}

/** A new entry of `values`, in byte order `le`. */
function entry(tag: number, type: number, values: number[], le: boolean): TiffEntry {
  const step = TYPE_SIZE[type];
  const bytes = new Uint8Array(step * values.length);
  const view = new DataView(bytes.buffer);
  values.forEach((v, k) => {
    const p = k * step;
    if (type === BYTE || type === ASCII) view.setUint8(p, v);
    else if (type === SHORT) view.setUint16(p, v, le);
    else if (type === LONG) view.setUint32(p, v, le);
    else if (type === LONG8) view.setBigUint64(p, BigInt(v), le);
    else if (type === DOUBLE) view.setFloat64(p, v, le);
    else throw new TypeError(`TIFF type ${type} cannot be written`);
  });
  return { tag, type, count: values.length, bytes };
}

/** `directories`, each leading on to the next, written from `at` on; with `at` rounded to a word. */
function writeDirectories(directories: TiffEntry[][], at: number, le: boolean, big: boolean): { at: number; bytes: Uint8Array<ArrayBuffer> } {
  const entrySize = big ? 20 : 12;
  const countSize = big ? 8 : 2;
  const pointerSize = big ? 8 : 4;
  const sorted = directories.map((d) => [...d].sort((a, b) => a.tag - b.tag));
  const outOfLine = (d: TiffEntry[]) => d.reduce((n, e) => (e.bytes.length > pointerSize ? n + e.bytes.length + (e.bytes.length & 1) : n), 0);
  const starts: number[] = [];
  let end = at;
  for (const d of sorted) {
    starts.push(end);
    end += countSize + d.length * entrySize + pointerSize + outOfLine(d);
    end += end & 1;
  }
  if (!big && end > 0xffffffff) throw new RangeError('4 GB を超えるため TIFF にできません');
  const bytes = new Uint8Array(end - at);
  const view = new DataView(bytes.buffer);
  const pointer = (p: number, value: number) => (big ? view.setBigUint64(p - at, BigInt(value), le) : view.setUint32(p - at, value, le));
  sorted.forEach((d, i) => {
    const start = starts[i];
    if (big) view.setBigUint64(start - at, BigInt(d.length), le);
    else view.setUint16(start - at, d.length, le);
    let e = start + countSize;
    let extra = e + d.length * entrySize + pointerSize;
    for (const x of d) {
      view.setUint16(e - at, x.tag, le);
      view.setUint16(e - at + 2, x.type, le);
      if (big) view.setBigUint64(e - at + 4, BigInt(x.count), le);
      else view.setUint32(e - at + 4, x.count, le);
      const valueAt = e + (big ? 12 : 8);
      if (x.bytes.length <= pointerSize) bytes.set(x.bytes, valueAt - at);
      else {
        pointer(valueAt, extra);
        bytes.set(x.bytes, extra - at);
        extra += x.bytes.length + (x.bytes.length & 1);
      }
      e += entrySize;
    }
    pointer(e, starts[i + 1] ?? 0);
  });
  return { at, bytes };
}
