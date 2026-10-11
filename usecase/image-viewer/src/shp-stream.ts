/**
 * Reading Shapefiles a piece at a time, for files too large to hold in memory
 * (see streamed-shapefile.ts): a .shp, .dbf or a .zip entry is read as a
 * stream of chunks, one record after another, never whole.
 */

/** Chunks of a file, in order. */
export type Chunks = AsyncIterator<Uint8Array>;

/** Bytes read from a Blob (a File) in slices of `size`. */
export async function* blobChunks(blob: Blob, size = 8 << 20): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < blob.size; at += size) {
    yield new Uint8Array(await blob.slice(at, Math.min(blob.size, at + size)).arrayBuffer());
  }
}

/** Bytes of a stream (a decompressed .zip entry). */
export async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value?.length) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Reads exactly as many bytes as asked from chunks, keeping only what is not read yet. */
export class ByteReader {
  private chunk_: Uint8Array = new Uint8Array(0);
  private at_ = 0;
  private done_ = false;
  /** Bytes read (or skipped) so far. */
  position = 0;

  constructor(private readonly chunks: Chunks) {}

  /** The next `n` bytes; null at the end of the file. Throws when the file ends inside them. */
  async read(n: number): Promise<Uint8Array | null> {
    if (this.chunk_.length - this.at_ >= n) {
      const out = this.chunk_.subarray(this.at_, this.at_ + n);
      this.at_ += n;
      this.position += n;
      return out;
    }
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      if (this.at_ >= this.chunk_.length && !(await this.more_())) {
        if (filled === 0) return null;
        throw new Error('ファイルが途中で終わっています');
      }
      const take = Math.min(n - filled, this.chunk_.length - this.at_);
      out.set(this.chunk_.subarray(this.at_, this.at_ + take), filled);
      this.at_ += take;
      filled += take;
    }
    this.position += n;
    return out;
  }

  /** Skips `n` bytes. */
  async skip(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      if (this.at_ >= this.chunk_.length && !(await this.more_())) throw new Error('ファイルが途中で終わっています');
      const take = Math.min(left, this.chunk_.length - this.at_);
      this.at_ += take;
      left -= take;
    }
    this.position += n;
  }

  private async more_(): Promise<boolean> {
    if (this.done_) return false;
    const next = await this.chunks.next();
    if (next.done) {
      this.done_ = true;
      return false;
    }
    this.chunk_ = next.value;
    this.at_ = 0;
    return true;
  }
}

// ---------------------------------------------------------------- .zip

/** A file in a .zip, read from the .zip where it is. */
export interface ZipEntry {
  name: string;
  /** 0 stored, 8 deflated. */
  method: number;
  compressedSize: number;
  size: number;
  /** Where its local header starts. */
  offset: number;
}

async function bytesAt(blob: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

const u64 = (view: DataView, at: number) => view.getUint32(at, true) + view.getUint32(at + 4, true) * 2 ** 32;

/** The files in a .zip (its central directory; zip64 too), without reading the files. */
export async function listZip(zip: Blob): Promise<ZipEntry[]> {
  const tailStart = Math.max(0, zip.size - 65_557);
  const tail = await bytesAt(zip, tailStart, zip.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('.zip として読めませんでした');
  let count = tail.getUint16(eocd + 10, true);
  let size = tail.getUint32(eocd + 12, true);
  let start = tail.getUint32(eocd + 16, true);
  if ((count === 0xffff || size === 0xffffffff || start === 0xffffffff) && eocd >= 20 && tail.getUint32(eocd - 20, true) === 0x07064b50) {
    const record = await bytesAt(zip, u64(tail, eocd - 20 + 8), u64(tail, eocd - 20 + 8) + 56);
    if (record.getUint32(0, true) === 0x06064b50) {
      count = u64(record, 32);
      size = u64(record, 40);
      start = u64(record, 48);
    }
  }
  const dir = await bytesAt(zip, start, start + size);
  const bytes = new Uint8Array(dir.buffer);
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let i = 0; i < count && at + 46 <= dir.byteLength && dir.getUint32(at, true) === 0x02014b50; i++) {
    const flags = dir.getUint16(at + 8, true);
    const method = dir.getUint16(at + 10, true);
    let compressedSize = dir.getUint32(at + 20, true);
    let fileSize = dir.getUint32(at + 24, true);
    const nameLength = dir.getUint16(at + 28, true);
    const extraLength = dir.getUint16(at + 30, true);
    const commentLength = dir.getUint16(at + 32, true);
    let offset = dir.getUint32(at + 42, true);
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
    // Zip64 sizes and offset, in that order, for the fields that do not fit.
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = dir.getUint16(extra, true);
      const length = dir.getUint16(extra + 2, true);
      if (id === 0x0001) {
        let p = extra + 4;
        if (fileSize === 0xffffffff) {
          fileSize = u64(dir, p);
          p += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = u64(dir, p);
          p += 8;
        }
        if (offset === 0xffffffff) offset = u64(dir, p);
      }
      extra += 4 + length;
    }
    entries.push({ name: zipName(nameBytes, (flags & 0x800) !== 0), method, compressedSize, size: fileSize, offset });
    at = extraEnd + commentLength;
  }
  return entries.filter((e) => !e.name.endsWith('/') && !e.name.includes('__MACOSX'));
}

/** A name in a .zip: UTF-8 when flagged or valid, else Shift_JIS (made on Japanese Windows). */
function zipName(bytes: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder().decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('shift_jis').decode(bytes);
  }
}

/** The bytes of a .zip entry, decompressed as they are read. */
export async function zipEntryChunks(zip: Blob, entry: ZipEntry): Promise<Chunks> {
  const header = await bytesAt(zip, entry.offset, entry.offset + 30);
  if (header.getUint32(0, true) !== 0x04034b50) throw new Error(`${entry.name} を .zip から読めませんでした`);
  const start = entry.offset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  const data = zip.slice(start, start + entry.compressedSize);
  if (entry.method === 0) return blobChunks(data);
  if (entry.method !== 8) throw new Error(`${entry.name} の圧縮形式（${entry.method}）は読めません`);
  return streamChunks(data.stream().pipeThrough(new DecompressionStream('deflate-raw')));
}

/** A whole (small) .zip entry. */
export async function zipEntryBytes(zip: Blob, entry: ZipEntry): Promise<Uint8Array> {
  const out = new Uint8Array(entry.size);
  let at = 0;
  const chunks = await zipEntryChunks(zip, entry);
  for (let next = await chunks.next(); !next.done; next = await chunks.next()) {
    out.set(next.value.subarray(0, out.length - at), at);
    at += next.value.length;
  }
  return out;
}

// ---------------------------------------------------------------- .shp

/** What a .shp header says. */
export interface ShpHeader {
  /** Shape type: 1 point, 3 line, 5 polygon, 8 multipoint; +10 with Z, +20 with M; 31 multipatch. */
  shapeType: number;
  /** Box of every shape, in the file's coordinates. */
  box: [number, number, number, number];
  /** File length in bytes. */
  length: number;
}

export function readShpHeader(bytes: Uint8Array): ShpHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, 100);
  if (view.getInt32(0) !== 9994) throw new Error('.shp ではありません');
  return {
    length: view.getInt32(24) * 2,
    shapeType: view.getInt32(32, true),
    box: [view.getFloat64(36, true), view.getFloat64(44, true), view.getFloat64(52, true), view.getFloat64(60, true)],
  };
}

/** Points, lines and polygons; 0 for an empty shape. */
export type ShapeKind = 0 | 1 | 2 | 3;

/** The kind of shapes a shape type holds. */
export function kindOfShapeType(type: number): ShapeKind {
  switch (type % 10) {
    case 1:
    case 8:
      return 1;
    case 3:
      return 2;
    case 5:
      return 3;
    default:
      return 0;
  }
}

/** One shape, as flat coordinates (x, y…) in the file's coordinates. */
export interface Shape {
  kind: ShapeKind;
  coords: Float64Array;
  /** Lines and polygons: where each part (ring) ends, as an index into `coords`. */
  ends: number[];
}

const emptyShape: Shape = { kind: 0, coords: new Float64Array(0), ends: [] };

/**
 * Calls `each` with every record of a .shp, in order: its number (from 0) and
 * the bytes of its content. Pass `boxesOnly` to read only the start of each
 * record (its type and box), skipping the points.
 */
export async function forEachShpRecord(reader: ByteReader, each: (index: number, content: DataView) => void | Promise<void>, boxesOnly = false): Promise<void> {
  const header = await reader.read(100);
  if (!header) throw new Error('.shp が空です');
  readShpHeader(header);
  for (let index = 0; ; index++) {
    const head = await reader.read(8);
    if (!head) return;
    const length = new DataView(head.buffer, head.byteOffset, 8).getInt32(4) * 2;
    if (length < 4) {
      await reader.skip(Math.max(0, length));
      await each(index, new DataView(new ArrayBuffer(4)));
      continue;
    }
    const keep = boxesOnly ? Math.min(length, 36) : length;
    const content = await reader.read(keep);
    if (!content) throw new Error('.shp が途中で終わっています');
    if (keep < length) await reader.skip(length - keep);
    await each(index, new DataView(content.buffer, content.byteOffset, content.byteLength));
  }
}

/** The box of a record (`[minX, minY, maxX, maxY]`), from its first bytes; null for an empty shape. */
export function recordBox(content: DataView): [number, number, number, number] | null {
  const type = content.byteLength >= 4 ? content.getInt32(0, true) : 0;
  const kind = kindOfShapeType(type);
  if (kind === 0) return null;
  if (type % 10 === 1) {
    if (content.byteLength < 20) return null;
    const x = content.getFloat64(4, true);
    const y = content.getFloat64(12, true);
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y, x, y] : null;
  }
  if (content.byteLength < 36) return null;
  const box: [number, number, number, number] = [content.getFloat64(4, true), content.getFloat64(12, true), content.getFloat64(20, true), content.getFloat64(28, true)];
  return box.every(Number.isFinite) ? box : null;
}

/** The shape of a record (Z and M values are left out). */
export function parseShape(content: DataView): Shape {
  const type = content.byteLength >= 4 ? content.getInt32(0, true) : 0;
  const kind = kindOfShapeType(type);
  if (kind === 0) return emptyShape;
  if (type % 10 === 1) {
    const x = content.getFloat64(4, true);
    const y = content.getFloat64(12, true);
    return Number.isFinite(x) && Number.isFinite(y) ? { kind, coords: Float64Array.of(x, y), ends: [] } : emptyShape;
  }
  if (type % 10 === 8) {
    const count = content.getInt32(36, true);
    const coords = new Float64Array(count * 2);
    for (let i = 0; i < count * 2; i++) coords[i] = content.getFloat64(40 + i * 8, true);
    return count ? { kind, coords, ends: [] } : emptyShape;
  }
  const parts = content.getInt32(36, true);
  const count = content.getInt32(40, true);
  if (parts <= 0 || count <= 0) return emptyShape;
  const at = 44 + parts * 4;
  const coords = new Float64Array(count * 2);
  for (let i = 0; i < count * 2; i++) coords[i] = content.getFloat64(at + i * 8, true);
  const ends: number[] = [];
  for (let p = 1; p <= parts; p++) {
    const end = p < parts ? content.getInt32(44 + p * 4, true) : count;
    const clamped = Math.min(count, Math.max(end, 0)) * 2;
    if (clamped > (ends.at(-1) ?? 0)) ends.push(clamped);
  }
  return { kind, coords, ends };
}

/** Twice the signed area of a ring (positive counter-clockwise, with y up). */
export function ringArea(coords: ArrayLike<number>, start: number, end: number): number {
  let sum = 0;
  for (let i = start, j = end - 2; i < end; j = i, i += 2) sum += (coords[j] - coords[i]) * (coords[j + 1] + coords[i + 1]);
  return sum;
}

function ringContains(coords: ArrayLike<number>, start: number, end: number, x: number, y: number): boolean {
  let inside = false;
  for (let i = start, j = end - 2; i < end; j = i, i += 2) {
    const xi = coords[i];
    const yi = coords[i + 1];
    const xj = coords[j];
    const yj = coords[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The polygons of a Shapefile polygon's rings: outer rings are clockwise and
 * holes counter-clockwise (y up); a hole goes with the smallest outer ring
 * around it. Returns the coordinates reordered polygon by polygon, the ring
 * ends, and how many rings each polygon has.
 */
export function groupRings(coords: Float64Array, ends: number[]): { coords: Float64Array; ends: number[]; polygons: number[] } {
  const rings = ends.map((end, i) => ({ start: i ? ends[i - 1] : 0, end, area: ringArea(coords, i ? ends[i - 1] : 0, end) }));
  if (rings.length <= 1) return { coords, ends, polygons: [rings.length] };
  const outers = rings.filter((r) => r.area < 0);
  if (!outers.length) return { coords, ends, polygons: rings.map(() => 1) };
  const holes: Array<typeof rings> = outers.map(() => []);
  const boxes = outers.map((r) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = r.start; i < r.end; i += 2) {
      minX = Math.min(minX, coords[i]);
      maxX = Math.max(maxX, coords[i]);
      minY = Math.min(minY, coords[i + 1]);
      maxY = Math.max(maxY, coords[i + 1]);
    }
    return [minX, minY, maxX, maxY];
  });
  const lone: typeof rings = [];
  for (const ring of rings) {
    if (ring.area < 0) continue;
    const x = coords[ring.start];
    const y = coords[ring.start + 1];
    let best = -1;
    for (let o = 0; o < outers.length; o++) {
      const b = boxes[o];
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      if ((best < 0 || -outers[o].area < -outers[best].area) && ringContains(coords, outers[o].start, outers[o].end, x, y)) best = o;
    }
    if (best >= 0) holes[best].push(ring);
    else lone.push(ring);
  }
  const out = new Float64Array(coords.length);
  const outEnds: number[] = [];
  const polygons: number[] = [];
  let at = 0;
  const put = (r: (typeof rings)[number]) => {
    out.set(coords.subarray(r.start, r.end), at);
    at += r.end - r.start;
    outEnds.push(at);
  };
  outers.forEach((outer, o) => {
    put(outer);
    for (const h of holes[o]) put(h);
    polygons.push(1 + holes[o].length);
  });
  // A counter-clockwise ring outside every outer ring: a polygon drawn the wrong way round.
  for (const r of lone) {
    put(r);
    polygons.push(1);
  }
  return { coords: out, ends: outEnds, polygons };
}

// ---------------------------------------------------------------- .dbf

/** A field of a .dbf. */
export interface DbfField {
  name: string;
  /** C text, N / F numbers, L logical, D date (others are read as text). */
  type: string;
  length: number;
  decimals: number;
}

export interface DbfHeader {
  count: number;
  headerLength: number;
  recordLength: number;
  fields: DbfField[];
  /** Language driver byte (0x13: Japanese). */
  language: number;
}

/** The header of a .dbf (its first `headerLength` bytes; 32 are enough to learn that length). */
export function readDbfHeader(bytes: Uint8Array, decode: (b: Uint8Array) => string = (b) => new TextDecoder().decode(b)): DbfHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(4, true);
  const headerLength = view.getUint16(8, true);
  const recordLength = view.getUint16(10, true);
  const fields: DbfField[] = [];
  for (let at = 32; at + 32 <= Math.min(headerLength, bytes.length) && bytes[at] !== 0x0d; at += 32) {
    const raw = bytes.subarray(at, at + 11);
    const zero = raw.indexOf(0);
    fields.push({
      name: decode(raw.subarray(0, zero < 0 ? 11 : zero)).trim(),
      type: String.fromCharCode(bytes[at + 11]).toUpperCase(),
      length: bytes[at + 16],
      decimals: bytes[at + 17],
    });
  }
  return { count, headerLength, recordLength, fields, language: bytes[29] };
}

/** The values of one .dbf record (null for empty ones); dates as ms since 1970 (UTC). */
export function readDbfRecord(record: Uint8Array, fields: DbfField[], decoder: TextDecoder): Array<string | number | boolean | null> {
  const out: Array<string | number | boolean | null> = [];
  let at = 1;
  for (const f of fields) {
    const raw = record.subarray(at, at + f.length);
    at += f.length;
    if (f.type === 'N' || f.type === 'F') {
      const text = ascii(raw).trim();
      const value = text ? Number(text) : NaN;
      out.push(Number.isFinite(value) ? value : null);
    } else if (f.type === 'L') {
      const c = String.fromCharCode(raw[0] ?? 0x3f).toUpperCase();
      out.push('YT'.includes(c) ? true : 'NF'.includes(c) ? false : null);
    } else if (f.type === 'D') {
      const m = /^(\d{4})(\d{2})(\d{2})$/.exec(ascii(raw).trim());
      out.push(m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null);
    } else {
      let end = raw.length;
      while (end > 0 && (raw[end - 1] === 0x20 || raw[end - 1] === 0)) end--;
      out.push(end ? decoder.decode(raw.subarray(0, end)) : null);
    }
  }
  return out;
}

function ascii(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/** The attribute types of `.dbf` fields, for the table. */
export function dbfFieldType(f: DbfField): 'string' | 'integer' | 'double' | 'date' | 'other' {
  if (f.type === 'N' || f.type === 'F') return f.decimals === 0 && f.length <= 15 ? 'integer' : 'double';
  if (f.type === 'D') return 'date';
  if (f.type === 'L') return 'other';
  return 'string';
}

/**
 * The text encoding of a .dbf: its .cpg when there is one, else its language
 * driver byte (0x13 is Japanese), else UTF-8 when `sample` (whole records)
 * is valid UTF-8 and Shift_JIS when it is not (Japanese data without a .cpg).
 */
export function dbfTextEncoding(language: number, sample: Uint8Array, cpg?: string): string {
  const label = cpg?.trim().toLowerCase();
  if (label) {
    if (/^(ansi\s*)?(932|cp932|ms932|windows-31j|sjis|shift[_-]?jis)$/.test(label)) return 'shift_jis';
    if (/^(utf-?8|65001)$/.test(label)) return 'utf-8';
    for (const candidate of [label, /^(ansi\s*)?(\d+)$/.exec(label) ? `windows-${/(\d+)$/.exec(label)![1]}` : '']) {
      try {
        if (candidate) return new TextDecoder(candidate).encoding;
      } catch {
        // not a label the browser knows
      }
    }
  }
  if (language === 0x13) return 'shift_jis';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return 'utf-8';
  } catch {
    return 'shift_jis';
  }
}
