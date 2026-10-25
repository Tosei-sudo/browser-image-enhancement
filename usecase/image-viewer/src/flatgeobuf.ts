/**
 * FlatGeobuf (.fgb): a header and features stored as FlatBuffers, read and
 * written here without a library. Reading takes every feature in order (the
 * spatial index, when there is one, is skipped); writing makes a file with
 * no index, which every reader takes (GDAL/QGIS build one on demand). Only
 * x and y are kept (z and m are dropped), and curves are not read.
 *
 * Specification: https://flatgeobuf.org (header.fbs, feature.fbs).
 */

const MAGIC = [0x66, 0x67, 0x62, 0x03, 0x66, 0x67, 0x62, 0x00];

/** Column types (ColumnType in header.fbs). */
export const enum ColumnType {
  Byte,
  UByte,
  Bool,
  Short,
  UShort,
  Int,
  UInt,
  Long,
  ULong,
  Float,
  Double,
  String,
  Json,
  DateTime,
  Binary,
}

/** Geometry types (GeometryType in header.fbs); the ones read and written here. */
export const enum GeometryType {
  Unknown,
  Point,
  LineString,
  Polygon,
  MultiPoint,
  MultiLineString,
  MultiPolygon,
  GeometryCollection,
}

/** A geometry as GeoJSON has it, in the file's coordinates. */
export type FgbGeometry =
  | { type: 'Point'; coordinates: number[] }
  | { type: 'LineString' | 'MultiPoint'; coordinates: number[][] }
  | { type: 'Polygon' | 'MultiLineString'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] }
  | { type: 'GeometryCollection'; geometries: FgbGeometry[] };

export interface FgbColumn {
  name: string;
  type: ColumnType;
  /** A heading for the column (shown as the attribute's alias). */
  title?: string;
}

export interface FgbFeature {
  geometry: FgbGeometry | null;
  properties: Record<string, unknown>;
}

export interface FgbCrs {
  org?: string | null;
  code?: number;
  wkt?: string | null;
  codeString?: string | null;
}

export interface FgbFile<G = FgbGeometry> {
  name: string | null;
  geometryType: GeometryType;
  columns: FgbColumn[];
  crs: FgbCrs | null;
  features: Array<{ geometry: G | null; properties: Record<string, unknown> }>;
}

export function isFlatGeobuf(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && bytes[0] === 0x66 && bytes[1] === 0x67 && bytes[2] === 0x62 && bytes[3] === 0x03 && bytes[4] === 0x66 && bytes[5] === 0x67 && bytes[6] === 0x62;
}

/* ---------------------------------------------------------------- reading */

/** One decoder for every string (making one per string costs more than decoding it). */
const utf8 = new TextDecoder();
const utf8Encoder = new TextEncoder();

/** A FlatBuffers table: its fields by index (the n-th field of the schema). */
class Table {
  constructor(
    private readonly view: DataView,
    readonly pos: number,
  ) {}

  /** Where field `n` is, or 0 when absent. */
  private field(n: number): number {
    const vtable = this.pos - this.view.getInt32(this.pos, true);
    const size = this.view.getUint16(vtable, true);
    const at = 4 + 2 * n;
    if (at >= size) return 0;
    const offset = this.view.getUint16(vtable + at, true);
    return offset ? this.pos + offset : 0;
  }

  private target(n: number): number {
    const at = this.field(n);
    return at ? at + this.view.getUint32(at, true) : 0;
  }

  u8(n: number, fallback = 0): number {
    const at = this.field(n);
    return at ? this.view.getUint8(at) : fallback;
  }

  u16(n: number, fallback = 0): number {
    const at = this.field(n);
    return at ? this.view.getUint16(at, true) : fallback;
  }

  i32(n: number, fallback = 0): number {
    const at = this.field(n);
    return at ? this.view.getInt32(at, true) : fallback;
  }

  u64(n: number): number {
    const at = this.field(n);
    return at ? Number(this.view.getBigUint64(at, true)) : 0;
  }

  string(n: number): string | null {
    const at = this.target(n);
    if (!at) return null;
    const length = this.view.getUint32(at, true);
    return utf8.decode(new Uint8Array(this.view.buffer, this.view.byteOffset + at + 4, length));
  }

  table(n: number): Table | null {
    const at = this.target(n);
    return at ? new Table(this.view, at) : null;
  }

  /** A vector's start (after its length) and length; null when absent. */
  private vector(n: number): { start: number; length: number } | null {
    const at = this.target(n);
    return at ? { start: at + 4, length: this.view.getUint32(at, true) } : null;
  }

  bytes(n: number): Uint8Array | null {
    const v = this.vector(n);
    return v ? new Uint8Array(this.view.buffer, this.view.byteOffset + v.start, v.length) : null;
  }

  doubles(n: number): Float64Array | null {
    const v = this.vector(n);
    if (!v) return null;
    // A copy of the bytes, read as doubles (little-endian, as every browser is): one copy, not a read per number.
    return new Float64Array(new Uint8Array(this.view.buffer, this.view.byteOffset + v.start, v.length * 8).slice().buffer);
  }

  uints(n: number): Uint32Array | null {
    const v = this.vector(n);
    if (!v) return null;
    const out = new Uint32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = this.view.getUint32(v.start + 4 * i, true);
    return out;
  }

  tables(n: number): Table[] {
    const v = this.vector(n);
    if (!v) return [];
    return Array.from({ length: v.length }, (_, i) => {
      const slot = v.start + 4 * i;
      return new Table(this.view, slot + this.view.getUint32(slot, true));
    });
  }
}

/** The root table of a size-prefixed FlatBuffer at `at`. */
function rootAt(view: DataView, at: number): Table {
  return new Table(view, at + 4 + view.getUint32(at + 4, true));
}

/** The byte size of a packed Hilbert R-tree of `items` with nodes of `nodeSize`. */
export function treeSize(items: number, nodeSize: number): number {
  if (items < 1 || nodeSize === 0) return 0;
  const size = Math.min(Math.max(nodeSize, 2), 65535);
  let n = items;
  let nodes = n;
  do {
    n = Math.ceil(n / size);
    nodes += n;
  } while (n !== 1);
  return nodes * 40;
}

function pairs(xy: Float64Array, from: number, to: number): number[][] {
  const out: number[][] = [];
  for (let i = from; i < to; i++) out.push([xy[2 * i], xy[2 * i + 1]]);
  return out;
}

/** Rings (or lines) of `xy` split at `ends` (point counts); one when there are no ends. */
function split(xy: Float64Array, ends: Uint32Array | null): number[][][] {
  const count = xy.length / 2;
  if (!ends || !ends.length) return [pairs(xy, 0, count)];
  const out: number[][][] = [];
  let from = 0;
  for (const end of ends) {
    out.push(pairs(xy, from, end));
    from = end;
  }
  return out;
}

/** A geometry as the file holds it: flat x / y, the point counts where its parts end, and the parts of a multipolygon or collection. */
export interface FlatGeometry {
  type: GeometryType;
  xy: Float64Array;
  ends: Uint32Array | null;
  parts: FlatGeometry[];
}

function readFlat(g: Table, type: GeometryType): FlatGeometry {
  const own = g.u8(6);
  return { type: own || type, xy: g.doubles(1) ?? new Float64Array(0), ends: g.uints(0), parts: g.tables(7).map((p) => readFlat(p, GeometryType.Unknown)) };
}

/** A geometry as GeoJSON has it. */
export function geoJsonOf(f: FlatGeometry): FgbGeometry | null {
  const { xy, ends, parts } = f;
  switch (f.type) {
    case GeometryType.Point:
      return xy.length >= 2 ? { type: 'Point', coordinates: [xy[0], xy[1]] } : null;
    case GeometryType.LineString:
      return { type: 'LineString', coordinates: pairs(xy, 0, xy.length / 2) };
    case GeometryType.MultiPoint:
      return { type: 'MultiPoint', coordinates: pairs(xy, 0, xy.length / 2) };
    case GeometryType.Polygon:
      return { type: 'Polygon', coordinates: split(xy, ends) };
    case GeometryType.MultiLineString:
      return { type: 'MultiLineString', coordinates: split(xy, ends) };
    case GeometryType.MultiPolygon:
      return { type: 'MultiPolygon', coordinates: parts.map((p) => split(p.xy, p.ends)) };
    case GeometryType.GeometryCollection:
      return { type: 'GeometryCollection', geometries: parts.map(geoJsonOf).filter((x): x is FgbGeometry => !!x) };
    default:
      return null;
  }
}

/** Decodes a feature's properties (pairs of a column index and its value). */
function readProperties(bytes: Uint8Array, columns: readonly FgbColumn[]): Record<string, unknown> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Record<string, unknown> = {};
  const text = (at: number, length: number) => utf8.decode(bytes.subarray(at, at + length));
  let at = 0;
  while (at + 2 <= bytes.length) {
    const column = columns[view.getUint16(at, true)];
    at += 2;
    if (!column) break;
    let value: unknown;
    switch (column.type) {
      case ColumnType.Bool:
        value = view.getUint8(at) !== 0;
        at += 1;
        break;
      case ColumnType.Byte:
        value = view.getInt8(at);
        at += 1;
        break;
      case ColumnType.UByte:
        value = view.getUint8(at);
        at += 1;
        break;
      case ColumnType.Short:
        value = view.getInt16(at, true);
        at += 2;
        break;
      case ColumnType.UShort:
        value = view.getUint16(at, true);
        at += 2;
        break;
      case ColumnType.Int:
        value = view.getInt32(at, true);
        at += 4;
        break;
      case ColumnType.UInt:
        value = view.getUint32(at, true);
        at += 4;
        break;
      case ColumnType.Long:
        value = Number(view.getBigInt64(at, true));
        at += 8;
        break;
      case ColumnType.ULong:
        value = Number(view.getBigUint64(at, true));
        at += 8;
        break;
      case ColumnType.Float:
        value = view.getFloat32(at, true);
        at += 4;
        break;
      case ColumnType.Double:
        value = view.getFloat64(at, true);
        at += 8;
        break;
      case ColumnType.DateTime: {
        const length = view.getUint32(at, true);
        const time = Date.parse(text(at + 4, length));
        value = Number.isNaN(time) ? text(at + 4, length) : time;
        at += 4 + length;
        break;
      }
      case ColumnType.String:
      case ColumnType.Json: {
        const length = view.getUint32(at, true);
        value = text(at + 4, length);
        at += 4 + length;
        break;
      }
      case ColumnType.Binary: {
        const length = view.getUint32(at, true);
        value = null;
        at += 4 + length;
        break;
      }
      default:
        return out;
    }
    out[column.name] = value;
  }
  return out;
}

function readColumns(t: Table | null, index: number): FgbColumn[] {
  return t
    ? t.tables(index).map((c) => {
        const title = c.string(2);
        return { name: c.string(0) ?? '', type: c.u8(1) as ColumnType, ...(title ? { title } : {}) };
      })
    : [];
}

/**
 * Reads a whole FlatGeobuf file, the geometries as GeoJSON has them or as
 * `geometryOf` makes them from the file's flat coordinates.
 */
export function readFlatGeobuf(bytes: Uint8Array): FgbFile;
export function readFlatGeobuf<G>(bytes: Uint8Array, geometryOf: (g: FlatGeometry) => G | null): FgbFile<G>;
export function readFlatGeobuf<G>(bytes: Uint8Array, geometryOf: (g: FlatGeometry) => G | null = geoJsonOf as never): FgbFile<G> {
  if (!isFlatGeobuf(bytes)) throw new Error('FlatGeobuf 以外');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = view.getUint32(8, true);
  const header = rootAt(view, 8);
  const geometryType = header.u8(2) as GeometryType;
  const columns = readColumns(header, 7);
  const count = header.u64(8);
  const nodeSize = header.u16(9, 16);
  const crsTable = header.table(10);
  const crs: FgbCrs | null = crsTable ? { org: crsTable.string(0), code: crsTable.i32(1), wkt: crsTable.string(4), codeString: crsTable.string(5) } : null;
  let at = 12 + headerSize + treeSize(count, nodeSize);
  const features: FgbFile<G>['features'] = [];
  while (at + 4 <= bytes.length) {
    const size = view.getUint32(at, true);
    if (!size || at + 4 + size > bytes.length) break;
    const f = rootAt(view, at);
    const g = f.table(0);
    const own = readColumns(f, 2);
    const props = f.bytes(1);
    features.push({ geometry: g ? geometryOf(readFlat(g, geometryType)) : null, properties: props ? readProperties(props, own.length ? own : columns) : {} });
    at += 4 + size;
  }
  return { name: header.string(0), geometryType, columns, crs, features };
}

/* ---------------------------------------------------------------- writing */

/** A value of a table to write: a scalar of a given width, or something written after the table and pointed to. */
type Slot =
  | { kind: 'u8'; value: number }
  | { kind: 'u16'; value: number }
  | { kind: 'i32'; value: number }
  | { kind: 'u64'; value: number }
  | { kind: 'ref'; value: Child };
type Child =
  | { kind: 'string'; value: string }
  | { kind: 'f64'; value: ArrayLike<number> }
  | { kind: 'u32'; value: ArrayLike<number> }
  | { kind: 'bytes'; value: Uint8Array }
  | { kind: 'table'; value: Array<Slot | null> }
  | { kind: 'tables'; value: Array<Array<Slot | null>> };

const SIZES = { u8: 1, u16: 2, i32: 4, u64: 8, ref: 4 } as const;

/**
 * Writes FlatBuffers front to back: a table, then what it points to (offsets
 * only point forward), each aligned to its own size from the buffer's start.
 */
class Builder {
  private buf = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  pos = 0;

  private room(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  align(n: number): void {
    const pad = (n - (this.pos % n)) % n;
    this.room(pad);
    this.pos += pad;
  }

  u8(v: number): void {
    this.room(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
  }

  u16(v: number): void {
    this.room(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
  }

  u32(v: number): void {
    this.room(4);
    this.view.setUint32(this.pos, v, true);
    this.pos += 4;
  }

  i32(v: number): void {
    this.room(4);
    this.view.setInt32(this.pos, v, true);
    this.pos += 4;
  }

  u64(v: number): void {
    this.room(8);
    this.view.setBigUint64(this.pos, BigInt(Math.max(0, Math.round(v))), true);
    this.pos += 8;
  }

  i64(v: number): void {
    this.room(8);
    this.view.setBigInt64(this.pos, BigInt(Math.round(v)), true);
    this.pos += 8;
  }

  /** What has been written. */
  bytes(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }

  f64(v: number): void {
    this.room(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }

  raw(bytes: Uint8Array): void {
    this.room(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
  }

  patch32(at: number, v: number): void {
    this.view.setUint32(at, v, true);
  }

  /** Writes a table (its vtable first) and its children; returns where the table starts. */
  table(slots: Array<Slot | null>): number {
    // Inline layout: the soffset, then the fields widest first so each is aligned.
    const order = slots.map((s, i) => ({ s, i })).filter((x): x is { s: Slot; i: number } => !!x.s).sort((a, b) => SIZES[b.s.kind] - SIZES[a.s.kind]);
    const offsets = new Array<number>(slots.length).fill(0);
    let size = 4;
    const widest = order.length ? SIZES[order[0].s.kind] : 4;
    for (const { s, i } of order) {
      const w = SIZES[s.kind];
      size = Math.ceil(size / w) * w;
      offsets[i] = size;
      size += w;
    }
    // The vtable, then the table.
    this.align(2);
    const vtable = this.pos;
    this.u16(4 + 2 * slots.length);
    this.u16(size);
    for (const o of offsets) this.u16(o);
    // A table whose fields are 8 wide starts at an 8-aligned position (so they are 8-aligned too).
    this.align(Math.max(4, widest));
    const start = this.pos;
    this.room(size);
    this.buf.fill(0, start, start + size);
    this.view.setInt32(start, start - vtable, true);
    const refs: Array<{ at: number; child: Child }> = [];
    for (const { s, i } of order) {
      const at = start + offsets[i];
      if (s.kind === 'u8') this.view.setUint8(at, s.value);
      else if (s.kind === 'u16') this.view.setUint16(at, s.value, true);
      else if (s.kind === 'i32') this.view.setInt32(at, s.value, true);
      else if (s.kind === 'u64') this.view.setBigUint64(at, BigInt(Math.max(0, Math.round(s.value))), true);
      else refs.push({ at, child: s.value });
    }
    this.pos = start + size;
    for (const { at, child } of refs) {
      const target = this.child(child);
      this.patch32(at, target - at);
    }
    return start;
  }

  /** Writes a string, a vector or a table; returns the position offsets point at. */
  private child(c: Child): number {
    switch (c.kind) {
      case 'string': {
        const bytes = utf8Encoder.encode(c.value);
        this.align(4);
        const at = this.pos;
        this.u32(bytes.length);
        this.raw(bytes);
        this.u8(0);
        return at;
      }
      case 'f64': {
        // The length right before 8-aligned doubles.
        this.align(4);
        if ((this.pos + 4) % 8) this.u32(0);
        const at = this.pos;
        this.u32(c.value.length);
        for (let i = 0; i < c.value.length; i++) this.f64(c.value[i]);
        return at;
      }
      case 'u32': {
        this.align(4);
        const at = this.pos;
        this.u32(c.value.length);
        for (let i = 0; i < c.value.length; i++) this.u32(c.value[i]);
        return at;
      }
      case 'bytes': {
        this.align(4);
        const at = this.pos;
        this.u32(c.value.length);
        this.raw(c.value);
        return at;
      }
      case 'table':
        return this.table(c.value);
      case 'tables': {
        this.align(4);
        const at = this.pos;
        this.u32(c.value.length);
        const slots = this.pos;
        this.room(4 * c.value.length);
        this.pos += 4 * c.value.length;
        c.value.forEach((t, i) => {
          const start = this.table(t);
          this.patch32(slots + 4 * i, start - (slots + 4 * i));
        });
        return at;
      }
    }
  }

  /** A size-prefixed buffer with `root` as its root table, padded to 8 bytes. */
  static sizePrefixed(root: Array<Slot | null>): Uint8Array {
    const b = new Builder();
    b.u32(0); // size
    b.u32(0); // root offset
    const start = b.table(root);
    b.patch32(4, start - 4);
    b.align(8);
    b.patch32(0, b.pos - 4);
    return b.bytes();
  }
}

const u8 = (value: number): Slot => ({ kind: 'u8', value });
const ref = (value: Child): Slot => ({ kind: 'ref', value });

/** The coordinates of a geometry, flat, and the ends of its rings or lines. */
function flatOf(coords: number[][]): number[] {
  const out: number[] = [];
  for (const c of coords) out.push(c[0], c[1]);
  return out;
}

function geometrySlots(g: FgbGeometry): Array<Slot | null> {
  const slots: Array<Slot | null> = new Array(8).fill(null);
  const lines = (rings: number[][][]) => {
    const xy: number[] = [];
    const ends: number[] = [];
    for (const r of rings) {
      for (const c of r) xy.push(c[0], c[1]);
      ends.push(xy.length / 2);
    }
    return { xy, ends };
  };
  switch (g.type) {
    case 'Point':
      slots[1] = ref({ kind: 'f64', value: [g.coordinates[0], g.coordinates[1]] });
      slots[6] = u8(GeometryType.Point);
      break;
    case 'LineString':
    case 'MultiPoint':
      slots[1] = ref({ kind: 'f64', value: flatOf(g.coordinates) });
      slots[6] = u8(g.type === 'LineString' ? GeometryType.LineString : GeometryType.MultiPoint);
      break;
    case 'Polygon':
    case 'MultiLineString': {
      const { xy, ends } = lines(g.coordinates);
      if (ends.length > 1) slots[0] = ref({ kind: 'u32', value: ends });
      slots[1] = ref({ kind: 'f64', value: xy });
      slots[6] = u8(g.type === 'Polygon' ? GeometryType.Polygon : GeometryType.MultiLineString);
      break;
    }
    case 'MultiPolygon':
      slots[6] = u8(GeometryType.MultiPolygon);
      slots[7] = ref({ kind: 'tables', value: g.coordinates.map((p) => geometrySlots({ type: 'Polygon', coordinates: p })) });
      break;
    case 'GeometryCollection':
      slots[6] = u8(GeometryType.GeometryCollection);
      slots[7] = ref({ kind: 'tables', value: g.geometries.map(geometrySlots) });
      break;
  }
  return slots;
}

/** Encodes properties for `columns`: absent and null values are left out. */
function writeProperties(properties: Record<string, unknown>, columns: readonly FgbColumn[]): Uint8Array {
  const b = new Builder();
  columns.forEach((column, i) => {
    const v = properties[column.name];
    if (v === null || v === undefined || v === '') return;
    if (column.type === ColumnType.Double) {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      b.u16(i);
      b.f64(n);
    } else if (column.type === ColumnType.Long) {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      b.u16(i);
      b.i64(n);
    } else if (column.type === ColumnType.Bool) {
      b.u16(i);
      b.u8(v ? 1 : 0);
    } else {
      const text = column.type === ColumnType.DateTime ? (typeof v === 'number' ? new Date(v).toISOString() : String(v)) : typeof v === 'object' ? JSON.stringify(v) : String(v);
      const bytes = utf8Encoder.encode(text);
      b.u16(i);
      b.u32(bytes.length);
      b.raw(bytes);
    }
  });
  return b.bytes();
}

/** The single geometry type of `features`, or Unknown when they mix. */
function commonType(features: readonly FgbFeature[]): GeometryType {
  const types = new Set(features.map((f) => f.geometry?.type).filter(Boolean));
  if (types.size !== 1) return GeometryType.Unknown;
  return ({ Point: 1, LineString: 2, Polygon: 3, MultiPoint: 4, MultiLineString: 5, MultiPolygon: 6, GeometryCollection: 7 } as const)[[...types][0]!];
}

/** Writes a FlatGeobuf file (no spatial index). */
export function writeFlatGeobuf(file: { name?: string; columns: FgbColumn[]; crs?: FgbCrs | null; features: FgbFeature[] }): Uint8Array<ArrayBuffer> {
  const type = commonType(file.features);
  // The envelope of every coordinate.
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (g: FgbGeometry | null): void => {
    if (!g) return;
    if (g.type === 'GeometryCollection') return g.geometries.forEach(visit);
    const walk = (c: unknown): void => {
      if (Array.isArray(c) && typeof c[0] === 'number') {
        box[0] = Math.min(box[0], c[0]);
        box[1] = Math.min(box[1], c[1]);
        box[2] = Math.max(box[2], c[0]);
        box[3] = Math.max(box[3], c[1]);
      } else if (Array.isArray(c)) c.forEach(walk);
    };
    walk(g.coordinates);
  };
  file.features.forEach((f) => visit(f.geometry));
  const crs = file.crs;
  const header = Builder.sizePrefixed([
    file.name ? ref({ kind: 'string', value: file.name }) : null,
    Number.isFinite(box[0]) ? ref({ kind: 'f64', value: box }) : null,
    u8(type),
    null,
    null,
    null,
    null,
    file.columns.length ? ref({ kind: 'tables', value: file.columns.map((c) => [ref({ kind: 'string', value: c.name }), u8(c.type), ...(c.title ? [ref({ kind: 'string', value: c.title })] : [])]) }) : null,
    { kind: 'u64', value: file.features.length },
    { kind: 'u16', value: 0 },
    crs
      ? ref({
          kind: 'table',
          value: [
            crs.org ? ref({ kind: 'string', value: crs.org }) : null,
            crs.code ? { kind: 'i32', value: crs.code } : null,
            null,
            null,
            crs.wkt ? ref({ kind: 'string', value: crs.wkt }) : null,
            crs.codeString ? ref({ kind: 'string', value: crs.codeString }) : null,
          ],
        })
      : null,
  ]);
  const parts: Uint8Array[] = [new Uint8Array(MAGIC), header];
  for (const f of file.features) {
    const props = writeProperties(f.properties, file.columns);
    parts.push(
      Builder.sizePrefixed([
        f.geometry ? ref({ kind: 'table', value: geometrySlots(f.geometry) }) : null,
        props.length ? ref({ kind: 'bytes', value: props }) : null,
      ]),
    );
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
