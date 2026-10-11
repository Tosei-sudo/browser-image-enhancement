/**
 * The worker behind a streamed Shapefile (see streamed-shapefile.ts). It
 * reads the .shp and .dbf a piece at a time into IndexedDB, in Hilbert order
 * (so features near each other are near each other in the database), with
 * copies simplified for a few scales, and keeps a packed R-tree per scale.
 * Then, for a view (box and resolution), it reads just the features there,
 * thins out those smaller than a pixel, simplifies and clips them, and sends
 * them as flat coordinates in `EPSG:3857`.
 */
import proj4 from 'proj4';
import {
  blobChunks,
  ByteReader,
  dbfFieldType,
  dbfTextEncoding,
  forEachShpRecord,
  groupRings,
  kindOfShapeType,
  parseShape,
  readDbfHeader,
  readDbfRecord,
  readShpHeader,
  recordBox,
  zipEntryChunks,
  type Chunks,
  type ShapeKind,
  type ZipEntry,
} from './shp-stream.js';
import { CellSet, clipToBox, hilbert, PackedRTree, pointCount, simplify, type FlatShape } from './spatial.js';

/** A file the worker reads: a File, or an entry of a .zip File. */
export type StreamSource = { blob: Blob } | { zip: Blob; entry: ZipEntry };

export interface ImportRequest {
  type: 'import';
  db: string;
  shp: StreamSource;
  dbf?: StreamSource;
  prj?: string;
  cpg?: string;
}

export interface LoadRequest {
  type: 'load';
  id: number;
  /** View box (with a margin) in `EPSG:3857`. */
  extent: number[];
  /** Map units a pixel. */
  resolution: number;
}

export type ShpRequest = ImportRequest | LoadRequest;

/** What an imported Shapefile holds. */
export interface ImportedShapefile {
  count: number;
  /** Features with a shape. */
  shapes: number;
  vertices: number;
  kind: ShapeKind;
  /** Box of every shape, `EPSG:3857`. */
  extent: number[] | null;
  fields: Array<{ name: string; type: 'string' | 'integer' | 'double' | 'date' | 'other'; length: number }>;
  encoding?: string;
  /** Resolution down to which each simplified copy is drawn, coarsest first. */
  tolerances: number[];
}

/**
 * Features for a view, packed: feature `i` has id `fids[i]`, coordinates
 * `coords[coordStart[i] .. coordStart[i + 1])` (absent: unchanged since the
 * last load), part ends `ends[endStart[i] .. endStart[i + 1])` relative to its
 * coordinates, and for polygons ring counts `polygons[polyStart[i] .. polyStart[i + 1])`.
 */
export interface LoadedFeatures {
  fids: Uint32Array;
  hasShape: Uint8Array;
  coords: Float64Array;
  coordStart: Uint32Array;
  ends: Uint32Array;
  endStart: Uint32Array;
  polygons: Uint32Array;
  polyStart: Uint32Array;
  /** Attributes of the features the last load did not send (null for the others). */
  attributes: Array<unknown[] | null>;
  /** Cut to the view box (the rest is left out). */
  clipped: Uint8Array;
  /** Small features were thinned out (one a few pixels). */
  thinned: boolean;
  level: number;
}

export type ShpReply =
  | { type: 'progress'; message: string; fraction: number }
  | { type: 'imported'; info: ImportedShapefile }
  | { type: 'loaded'; id: number; features: LoadedFeatures }
  | { type: 'error'; id?: number; message: string };

/** Most features sent for one view (OpenLayers features are heavy). */
export const MAX_LOADED = 60_000;
/** Most points sent for one view: beyond it, shapes are simplified further. */
const MAX_POINTS = 800_000;
/** A feature with more points than this, reaching out of the view, is clipped to it. */
const CLIP_POINTS = 20_000;
/** Feature records written per transaction. */
const BATCH = 4_000;
const BATCH_BYTES = 16 << 20;
const GEOM = 'geom';
const ATTR = 'attr';

interface StoredShape {
  r: number;
  ox: number;
  oy: number;
  c: Float32Array | Float64Array;
  e?: Uint32Array;
  p?: Uint32Array;
}

let state: {
  db: IDBDatabase;
  info: ImportedShapefile;
  origin: [number, number];
  /** Box of each feature by rank, relative to `origin`. */
  boxes: Float32Array;
  fidOf: Uint32Array;
  /** Bit k: the feature is drawn at level k; bit 7: it has a shape. */
  drawn: Uint8Array;
  /** Bit k: the feature has its own simplified copy at level k (else level k reads the full shape). */
  own: Uint8Array;
  trees: PackedRTree[];
  /** What the last load sent: ranks, which of them were clipped, and at what resolution. */
  sent: Set<number>;
  sentClipped: Set<number>;
  sentResolution: number;
} | null = null;

const post = (reply: ShpReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(reply, transfer);

self.onmessage = async (event: MessageEvent<ShpRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'import') post({ type: 'imported', info: await importShapefile(request) });
    else {
      const features = await load(request);
      post({ type: 'loaded', id: request.id, features }, [features.fids.buffer, features.coords.buffer, features.coordStart.buffer, features.ends.buffer, features.endStart.buffer, features.polygons.buffer, features.polyStart.buffer]);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: 'error',
      id: request.type === 'load' ? request.id : undefined,
      message: /quota/i.test(message) || (error as DOMException)?.name === 'QuotaExceededError' ? 'ブラウザの保存領域が足りません' : message,
    });
  }
};

async function chunksOf(source: StreamSource): Promise<Chunks> {
  return 'blob' in source ? blobChunks(source.blob) : zipEntryChunks(source.zip, source.entry);
}

/** The first 100 bytes of a file. */
async function headOf(source: StreamSource): Promise<Uint8Array> {
  if ('blob' in source) return new Uint8Array(await source.blob.slice(0, 100).arrayBuffer());
  const chunks = await chunksOf(source);
  const head = await new ByteReader(chunks).read(100);
  await chunks.return?.();
  if (!head) throw new Error('.shp が空です');
  return head;
}

const sizeOf = (source: StreamSource) => ('blob' in source ? source.blob.size : source.entry.size);

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(GEOM);
      request.result.createObjectStore(ATTR);
    };
    request.onsuccess = () => {
      // Another tab clearing out stores left behind: this one is in use, keep it open.
      request.result.onversionchange = null;
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB に書き込めませんでした'));
  });
}

/** Puts records a batch at a time. */
class Writer {
  private puts: Array<[string, IDBValidKey, unknown]> = [];
  private bytes = 0;
  constructor(private readonly db: IDBDatabase) {}

  async put(store: string, key: IDBValidKey, value: unknown, bytes: number): Promise<void> {
    this.puts.push([store, key, value]);
    this.bytes += bytes;
    if (this.puts.length >= BATCH || this.bytes >= BATCH_BYTES) await this.flush();
  }

  async flush(): Promise<void> {
    if (!this.puts.length) return;
    const stores = [...new Set(this.puts.map((p) => p[0]))];
    const tx = this.db.transaction(stores, 'readwrite', { durability: 'relaxed' });
    for (const [store, key, value] of this.puts) tx.objectStore(store).put(value, key);
    this.puts = [];
    this.bytes = 0;
    await done(tx);
  }
}

/** From the file's coordinates to `EPSG:3857`, in place; latitudes beyond Web Mercator's are clamped. */
function projector(prj: string | undefined): (coords: Float64Array) => void {
  const R = 6378137;
  const maxLat = 85.0511287798;
  const mercator = (coords: Float64Array, i: number, lon: number, lat: number) => {
    const phi = (Math.max(-maxLat, Math.min(maxLat, lat)) * Math.PI) / 180;
    coords[i] = (R * lon * Math.PI) / 180;
    coords[i + 1] = R * Math.log(Math.tan(Math.PI / 4 + phi / 2));
  };
  const geographic = !prj || /^\s*GEOGCS\[/i.test(prj);
  if (geographic) {
    return (coords) => {
      for (let i = 0; i < coords.length; i += 2) mercator(coords, i, coords[i], coords[i + 1]);
    };
  }
  let forward: (xy: number[]) => number[];
  try {
    forward = proj4(prj, 'EPSG:4326').forward;
  } catch {
    throw new Error('.prj の座標系を読めませんでした');
  }
  const xy = [0, 0];
  return (coords) => {
    for (let i = 0; i < coords.length; i += 2) {
      xy[0] = coords[i];
      xy[1] = coords[i + 1];
      const [lon, lat] = forward(xy);
      mercator(coords, i, lon, lat);
    }
  };
}

function boxOf(coords: Float64Array): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < coords.length; i += 2) {
    const x = coords[i];
    const y = coords[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/** A shape as kept: coordinates relative to its corner, in 32-bit floats unless it is large. */
function stored(r: number, shape: FlatShape, box: number[]): { value: StoredShape; bytes: number } {
  const ox = box[0];
  const oy = box[1];
  const wide = Math.max(box[2] - box[0], box[3] - box[1]) > 100_000;
  const c = wide ? new Float64Array(shape.coords.length) : new Float32Array(shape.coords.length);
  for (let i = 0; i < c.length; i += 2) {
    c[i] = shape.coords[i] - ox;
    c[i + 1] = shape.coords[i + 1] - oy;
  }
  const value: StoredShape = { r, ox, oy, c };
  if (shape.ends.length > 1) value.e = Uint32Array.from(shape.ends);
  if (shape.polygons && shape.polygons.length > 1) value.p = Uint32Array.from(shape.polygons);
  return { value, bytes: c.byteLength + 64 };
}

function unstored(value: StoredShape, kind: ShapeKind): FlatShape {
  const coords = new Float64Array(value.c.length);
  for (let i = 0; i < coords.length; i += 2) {
    coords[i] = value.c[i] + value.ox;
    coords[i + 1] = value.c[i + 1] + value.oy;
  }
  const ends = value.e ? Array.from(value.e) : [coords.length];
  return kind === 3 ? { coords, ends, polygons: value.p ? Array.from(value.p) : [ends.length] } : { coords, ends };
}

class Growing<T extends Float64Array | Uint32Array> {
  data: T;
  length = 0;
  constructor(private readonly make: (n: number) => T) {
    this.data = make(1 << 16);
  }
  push(v: number): void {
    if (this.length === this.data.length) {
      const bigger = this.make(this.data.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    this.data[this.length++] = v;
  }
}

async function importShapefile(request: ImportRequest): Promise<ImportedShapefile> {
  const db = await openDb(request.db);
  const shpSize = sizeOf(request.shp);
  // The .shp is read twice: once quickly for the order, then for the shapes.
  const total = shpSize * 1.25 + (request.dbf ? sizeOf(request.dbf) : 0);
  const project = projector(request.prj);
  let lastProgress = 0;
  const progress = (message: string, read: number) => {
    const now = Date.now();
    if (now - lastProgress < 250) return;
    lastProgress = now;
    post({ type: 'progress', message, fraction: Math.min(1, read / total) });
  };

  // Where the shapes are: the header's box, in Web Mercator.
  const header = readShpHeader(await headOf(request.shp));
  if (header.shapeType === 31) throw new Error('マルチパッチは大容量読み込みに対応していません');
  const kind = kindOfShapeType(header.shapeType);
  if (!request.prj) {
    const [x0, y0, x1, y1] = header.box;
    if (!(x0 >= -180 && x1 <= 180 && y0 >= -90 && y1 <= 90)) throw new Error('.prj（座標系）がありません。.shp と一緒に .prj も選んでください');
  }
  const corners = new Float64Array(2 * 25);
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      corners[(i * 5 + j) * 2] = header.box[0] + ((header.box[2] - header.box[0]) * i) / 4;
      corners[(i * 5 + j) * 2 + 1] = header.box[1] + ((header.box[3] - header.box[1]) * j) / 4;
    }
  }
  project(corners);
  const roughBox = boxOf(corners);
  const span = Math.max(roughBox[2] - roughBox[0], roughBox[3] - roughBox[1], 1);

  // 1. Each record's place along a Hilbert curve (from its box alone), so storage follows space.
  const keys = new Growing((n) => new Float64Array(n));
  const center = new Float64Array(2);
  const cells = (1 << 13) - 1;
  const firstPass = new ByteReader(await chunksOf(request.shp));
  await forEachShpRecord(
    firstPass,
    (fid, content) => {
      const box = recordBox(content);
      let h = 2 ** 26 - 1;
      if (box) {
        center[0] = (box[0] + box[2]) / 2;
        center[1] = (box[1] + box[3]) / 2;
        project(center);
        const hx = Math.max(0, Math.min(cells, Math.floor(((center[0] - roughBox[0]) / span) * cells)));
        const hy = Math.max(0, Math.min(cells, Math.floor(((center[1] - roughBox[1]) / span) * cells)));
        if (Number.isFinite(hx) && Number.isFinite(hy)) h = hilbert(hx, hy);
      }
      keys.push(h * 2 ** 27 + fid);
      progress('並べ替えています', firstPass.position / 4);
    },
    true,
  );
  const count = keys.length;
  const sorted = keys.data.subarray(0, count).sort();
  const fidOf = new Uint32Array(count);
  const rankOf = new Uint32Array(count);
  for (let r = 0; r < count; r++) {
    const fid = sorted[r] % 2 ** 27;
    fidOf[r] = fid;
    rankOf[fid] = r;
  }
  keys.data = new Float64Array(0);

  // Simplified copies at scales a quarter apart, from the whole layer on ~512 px down to ~1 m a pixel.
  const tolerances: number[] = [];
  for (let width = 512; tolerances.length < 7; width *= 4) {
    const tolerance = span / width;
    if (tolerance < 1 && tolerances.length) break;
    tolerances.push(tolerance);
  }
  const levels = tolerances.length;
  const cellSets = tolerances.map((t) => new CellSet(Math.ceil(span / t) + 1));
  const origin: [number, number] = [roughBox[0], roughBox[1]];
  const boxes = new Float32Array(count * 4);
  const drawn = new Uint8Array(count);
  const own = new Uint8Array(count);
  const writer = new Writer(db);
  let vertices = 0;
  let shapes = 0;
  const extent = [Infinity, Infinity, -Infinity, -Infinity];

  // 2. The shapes: projected, rings grouped into polygons, kept whole and simplified per level.
  const shp = new ByteReader(await chunksOf(request.shp));
  await forEachShpRecord(shp, async (fid, content) => {
    const r = rankOf[fid];
    const parsed = parseShape(content);
    if (parsed.kind === 0) return;
    project(parsed.coords);
    let shape: FlatShape = { coords: parsed.coords, ends: parsed.ends.length ? parsed.ends : [parsed.coords.length] };
    if (parsed.kind === 3) shape = groupRings(parsed.coords, shape.ends);
    const box = boxOf(shape.coords);
    if (!box.every(Number.isFinite)) return;
    // Rounded outwards for 32 bits.
    const pad = Math.max(1, span * 1e-6);
    boxes.set([box[0] - origin[0] - pad, box[1] - origin[1] - pad, box[2] - origin[0] + pad, box[3] - origin[1] + pad], r * 4);
    extent[0] = Math.min(extent[0], box[0]);
    extent[1] = Math.min(extent[1], box[1]);
    extent[2] = Math.max(extent[2], box[2]);
    extent[3] = Math.max(extent[3], box[3]);
    const points = pointCount(shape);
    vertices += points;
    shapes++;
    let flags = 0x80;
    let owned = 0;
    const full = stored(r, shape, box);
    await writer.put(GEOM, [levels, r], full.value, full.bytes);
    // Finest level first: each simplifies the one before it.
    const size = Math.max(box[2] - box[0], box[3] - box[1]);
    let simpler = shape;
    for (let k = levels - 1; k >= 0; k--) {
      const t = tolerances[k];
      if (size < t || parsed.kind === 1) {
        // Smaller than a pixel at this level: one feature a cell is drawn (and then at every coarser level too).
        const cx = Math.floor(((box[0] + box[2]) / 2 - origin[0]) / t);
        const cy = Math.floor(((box[1] + box[3]) / 2 - origin[1]) / t);
        if (!cellSets[k].take(cx, cy)) break;
        if (parsed.kind !== 1 || points > 1) {
          simpler = simplify(parsed.kind, simpler, t);
          if (parsed.kind === 1) simpler = { coords: simpler.coords.subarray(0, 2), ends: [2] };
          const copy = stored(r, simpler, box);
          await writer.put(GEOM, [k, r], copy.value, copy.bytes);
          owned |= 1 << k;
        }
      } else {
        simpler = simplify(parsed.kind, simpler, t);
        if (pointCount(simpler) <= points * 0.75) {
          const copy = stored(r, simpler, box);
          await writer.put(GEOM, [k, r], copy.value, copy.bytes);
          owned |= 1 << k;
        }
      }
      flags |= 1 << k;
    }
    drawn[r] = flags;
    own[r] = owned;
    progress('図形を読み込んでいます', shpSize / 4 + shp.position);
  });

  // 3. The attributes, in the same order.
  let fields: ImportedShapefile['fields'] = [];
  let encoding: string | undefined;
  if (request.dbf) {
    const dbf = new ByteReader(await chunksOf(request.dbf));
    const start = (await dbf.read(32))!;
    const headerLength = start[8] | (start[9] << 8);
    const rest = await dbf.read(Math.max(0, headerLength - 32));
    const headerBytes = new Uint8Array(headerLength);
    headerBytes.set(start.subarray(0, Math.min(32, headerLength)));
    if (rest) headerBytes.set(rest, 32);
    // Field names are ASCII almost always; Japanese ones are decoded once the encoding is known.
    const rough = readDbfHeader(headerBytes);
    const records = Math.min(rough.count, count);
    const sampleCount = Math.min(records, Math.max(1, Math.floor((1 << 20) / Math.max(1, rough.recordLength))));
    const sample = records ? await dbf.read(sampleCount * rough.recordLength) : null;
    encoding = dbfTextEncoding(rough.language, sample ?? new Uint8Array(0), request.cpg);
    const decoder = new TextDecoder(encoding);
    const dbfHeader = readDbfHeader(headerBytes, (b) => decoder.decode(b));
    fields = dbfHeader.fields.map((f) => ({ name: f.name, type: dbfFieldType(f), length: f.length }));
    const put = async (fid: number, record: Uint8Array) => {
      await writer.put(ATTR, rankOf[fid], readDbfRecord(record, dbfHeader.fields, decoder), record.length + 16 * fields.length);
    };
    for (let fid = 0; fid < sampleCount; fid++) await put(fid, sample!.subarray(fid * rough.recordLength, (fid + 1) * rough.recordLength));
    for (let fid = sampleCount; fid < records; fid++) {
      const record = await dbf.read(rough.recordLength);
      if (!record) break;
      await put(fid, record);
      if ((fid & 1023) === 0) progress('属性を読み込んでいます', shpSize * 1.25 + dbf.position);
    }
  }
  await writer.flush();

  // 4. One R-tree a level, and one of every shape.
  const trees: PackedRTree[] = [];
  for (let k = 0; k <= levels; k++) {
    const bit = k === levels ? 0x80 : 1 << k;
    let n = 0;
    for (let r = 0; r < count; r++) if (drawn[r] & bit) n++;
    const ids = new Uint32Array(n);
    const levelBoxes = new Float32Array(n * 4);
    n = 0;
    for (let r = 0; r < count; r++) {
      if (!(drawn[r] & bit)) continue;
      ids[n] = r;
      levelBoxes.set(boxes.subarray(r * 4, r * 4 + 4), n * 4);
      n++;
    }
    trees.push(new PackedRTree(levelBoxes, ids));
  }

  const info: ImportedShapefile = {
    count,
    shapes,
    vertices,
    kind,
    extent: shapes ? extent : null,
    fields,
    encoding,
    tolerances,
  };
  state = { db, info, origin, boxes, fidOf, drawn, own, trees, sent: new Set(), sentClipped: new Set(), sentResolution: NaN };
  return info;
}

/** Records of `ranks` (sorted) at `level` (geometry) or in the attribute store, read a range at a time. */
async function readRanks(db: IDBDatabase, store: string, level: number | null, ranks: number[]): Promise<Map<number, unknown>> {
  const out = new Map<number, unknown>();
  if (!ranks.length) return out;
  const tx = db.transaction(store, 'readonly');
  const os = tx.objectStore(store);
  const requests: Array<Promise<void>> = [];
  const wanted = new Set(ranks);
  const key = (r: number) => (level === null ? r : [level, r]);
  for (let i = 0; i < ranks.length; ) {
    let j = i;
    // Neighbors in Hilbert order: one range read, gaps of a few records included.
    while (j + 1 < ranks.length && ranks[j + 1] - ranks[j] <= 8) j++;
    const first = ranks[i];
    const last = ranks[j];
    requests.push(
      new Promise((resolve, reject) => {
        const req = first === last ? os.get(key(first)) : os.getAll(IDBKeyRange.bound(key(first), key(last)));
        req.onsuccess = () => {
          if (first === last) {
            if (req.result !== undefined) out.set(first, req.result);
          } else if (level === null) {
            // Attribute records are arrays without their key: get the keys too.
            const keysReq = os.getAllKeys(IDBKeyRange.bound(first, last));
            keysReq.onsuccess = () => {
              (keysReq.result as number[]).forEach((k, n) => wanted.has(k) && out.set(k, (req.result as unknown[])[n]));
              resolve();
            };
            keysReq.onerror = () => reject(keysReq.error);
            return;
          } else {
            for (const v of req.result as StoredShape[]) if (wanted.has(v.r)) out.set(v.r, v);
          }
          resolve();
        };
        req.onerror = () => reject(req.error);
      }),
    );
    i = j + 1;
  }
  await Promise.all(requests);
  return out;
}

async function load({ extent, resolution }: LoadRequest): Promise<LoadedFeatures> {
  if (!state) throw new Error('まだ読み込んでいません');
  const s = state;
  const { tolerances } = s.info;
  const levels = tolerances.length;
  let level = tolerances.findIndex((t) => t <= resolution);
  if (level < 0) level = levels;
  const [ox, oy] = s.origin;
  const found = s.trees[level].search(extent[0] - ox, extent[1] - oy, extent[2] - ox, extent[3] - oy).sort((a, b) => a - b);

  // Shapes smaller than a cell of a few pixels: one a cell, with larger cells until few enough are left.
  let cell = resolution * 2;
  let chosen: number[] = found;
  let thinned = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const taken = new Set<number>();
    const out: number[] = [];
    for (const r of found) {
      const b = r * 4;
      const w = s.boxes[b + 2] - s.boxes[b];
      const h = s.boxes[b + 3] - s.boxes[b + 1];
      if (Math.max(w, h) < cell) {
        const cx = Math.floor((s.boxes[b] + w / 2) / cell);
        const cy = Math.floor((s.boxes[b + 1] + h / 2) / cell);
        const key = cx * 67_108_864 + cy;
        if (taken.has(key)) {
          thinned = true;
          continue;
        }
        taken.add(key);
      }
      out.push(r);
    }
    chosen = out;
    if (out.length <= MAX_LOADED) break;
    cell *= 2;
  }
  if (chosen.length > MAX_LOADED) {
    const step = chosen.length / MAX_LOADED;
    chosen = Array.from({ length: MAX_LOADED }, (_, i) => chosen[Math.floor(i * step)]);
    thinned = true;
  }

  // What the main thread has already, drawn at this resolution, needs no new shape.
  const same = resolution === s.sentResolution;
  const needShape = chosen.filter((r) => !(same && s.sent.has(r) && !s.sentClipped.has(r)));
  const needAttributes = chosen.filter((r) => !s.sent.has(r));
  const bit = level === levels ? 0 : 1 << level;
  const ownCopy = needShape.filter((r) => bit && s.own[r] & bit);
  const fullCopy = needShape.filter((r) => !(bit && s.own[r] & bit));
  const [levelShapes, fullShapes, attributes] = await Promise.all([
    readRanks(s.db, GEOM, level, ownCopy),
    readRanks(s.db, GEOM, levels, fullCopy),
    readRanks(s.db, ATTR, null, needAttributes),
  ]);

  const kind = s.info.kind;
  const n = chosen.length;
  const fids = new Uint32Array(n);
  const hasShape = new Uint8Array(n);
  const clipped = new Uint8Array(n);
  const coordStart = new Uint32Array(n + 1);
  const endStart = new Uint32Array(n + 1);
  const polyStart = new Uint32Array(n + 1);
  const shapesOut: Array<FlatShape | null> = new Array(n).fill(null);
  let coordCount = 0;
  let endCount = 0;
  let polyCount = 0;
  const outAttributes: Array<unknown[] | null> = new Array(n).fill(null);
  const sentClipped = new Set<number>();
  chosen.forEach((r, i) => {
    fids[i] = s.fidOf[r];
    outAttributes[i] = (attributes.get(r) as unknown[] | undefined) ?? null;
    const value = (levelShapes.get(r) ?? fullShapes.get(r)) as StoredShape | undefined;
    if (value) {
      let shape = unstored(value, kind);
      // Simplified to a pixel (the stored copy may be finer).
      if (kind !== 1 && pointCount(shape) > 16 && (level === levels || tolerances[level] < resolution / 2)) shape = simplify(kind, shape, resolution);
      if (pointCount(shape) > CLIP_POINTS) {
        const b = r * 4;
        const inside = s.boxes[b] + ox >= extent[0] && s.boxes[b + 1] + oy >= extent[1] && s.boxes[b + 2] + ox <= extent[2] && s.boxes[b + 3] + oy <= extent[3];
        if (!inside) {
          const cut = clipToBox(kind, shape, extent);
          if (cut) {
            shape = cut;
            clipped[i] = 1;
            sentClipped.add(r);
          }
        }
      }
      hasShape[i] = 1;
      shapesOut[i] = shape;
      coordCount += shape.coords.length;
    } else if (s.sentClipped.has(r) && same) {
      sentClipped.add(r);
    }
  });
  // Too many points for the map to draw smoothly: simplified more, till few enough.
  for (let tolerance = resolution * 2; kind !== 1 && coordCount / 2 > MAX_POINTS && tolerance < resolution * 64; tolerance *= 2) {
    coordCount = 0;
    for (let i = 0; i < n; i++) {
      const shape = shapesOut[i];
      if (!shape) continue;
      if (pointCount(shape) > 8) shapesOut[i] = simplify(kind, shape, tolerance);
      coordCount += shapesOut[i]!.coords.length;
    }
  }
  for (const shape of shapesOut) {
    if (!shape) continue;
    endCount += shape.ends.length;
    polyCount += shape.polygons?.length ?? 0;
  }
  const coords = new Float64Array(coordCount);
  const ends = new Uint32Array(endCount);
  const polygons = new Uint32Array(polyCount);
  let c = 0;
  let e = 0;
  let p = 0;
  for (let i = 0; i < n; i++) {
    coordStart[i] = c;
    endStart[i] = e;
    polyStart[i] = p;
    const shape = shapesOut[i];
    if (!shape) continue;
    coords.set(shape.coords, c);
    c += shape.coords.length;
    ends.set(shape.ends, e);
    e += shape.ends.length;
    if (shape.polygons) {
      polygons.set(shape.polygons, p);
      p += shape.polygons.length;
    }
  }
  coordStart[n] = c;
  endStart[n] = e;
  polyStart[n] = p;
  s.sent = new Set(chosen);
  s.sentClipped = sentClipped;
  s.sentResolution = resolution;
  return { fids, hasShape, coords, coordStart, ends, endStart, polygons, polyStart, attributes: outAttributes, clipped, thinned, level };
}
