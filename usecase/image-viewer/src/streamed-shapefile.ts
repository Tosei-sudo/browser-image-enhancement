/**
 * Shapefiles too large to hold in memory (many points or many features):
 * a worker (shp-worker.ts) reads the .shp and .dbf a piece at a time into
 * IndexedDB with a spatial index, and the layer holds only what the view
 * shows: the features in it (with a margin), simplified for the scale, the
 * ones smaller than a pixel thinned out. Moving the map loads the new ones.
 * Features keep their object (and id, the record number) while they stay in
 * view, so the selection and the attribute table follow them. The layer is
 * read-only; the browser's copy is deleted when the layer is closed.
 */
import Feature from 'ol/Feature.js';
import type OlMap from 'ol/Map.js';
import type { EventsKey } from 'ol/events.js';
import { buffer, containsExtent, getHeight, getWidth, type Extent } from 'ol/extent.js';
import VectorLayer from 'ol/layer/Vector.js';
import { unByKey } from 'ol/Observable.js';
import VectorSource from 'ol/source/Vector.js';
import LineString from 'ol/geom/LineString.js';
import MultiLineString from 'ol/geom/MultiLineString.js';
import MultiPoint from 'ol/geom/MultiPoint.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import type Geometry from 'ol/geom/Geometry.js';
import { nextColor, type Field, type ServiceLayer } from './services/index.js';
import { LayerStyle, singleSpec, type VectorStyleSpec } from './vector-style.js';
import { listZip, readShpHeader, zipEntryBytes, type ZipEntry } from './shp-stream.js';
import type { ImportedShapefile, LoadedFeatures, ShpReply, ShpRequest, StreamSource } from './shp-worker.js';
import { stem } from './vector-files.js';

/** When Shapefiles are streamed: `auto` for large ones (see {@link needsStreaming}); `always` and `never` for tests. */
export const streaming = {
  mode: 'auto' as 'auto' | 'always' | 'never',
  /** A .shp larger than this is streamed. */
  minBytes: 48 << 20,
  /** As is one with more features than this (by its .shx), which would not all be read otherwise. */
  minFeatures: 50_000,
};

/** Whether a Shapefile of these sizes is streamed. */
export function needsStreaming(shpBytes: number, shxBytes?: number): boolean {
  if (streaming.mode !== 'auto') return streaming.mode === 'always';
  return shpBytes > streaming.minBytes || (shxBytes !== undefined && (shxBytes - 100) / 8 > streaming.minFeatures);
}

/** The parts of one Shapefile to stream. */
export interface StreamedParts {
  title: string;
  shp: StreamSource;
  dbf?: StreamSource;
  prj?: string;
  cpg?: string;
  qml?: string;
}

const parts = ['.shp', '.shx', '.dbf', '.prj', '.cpg', '.qml'];

function splitName(name: string): { key: string; ext: string } {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? { key: name, ext: '' } : { key: name.slice(0, dot), ext: name.slice(dot).toLowerCase() };
}

/**
 * Takes the Shapefiles to stream out of `files` (chosen together, or in a
 * .zip); returns them and the files left to read as usual. Other vector
 * files in a .zip with a streamed Shapefile are taken out of it.
 */
export async function planStreaming(files: File[]): Promise<{ streamed: StreamedParts[]; rest: File[] }> {
  const streamed: StreamedParts[] = [];
  const rest: File[] = [];
  const loose = new Map<string, Record<string, File>>();
  for (const file of files) {
    const { key, ext } = splitName(file.name);
    if (parts.includes(ext)) {
      const group = loose.get(key) ?? {};
      group[ext] = file;
      loose.set(key, group);
    } else if (ext === '.zip' && streaming.mode !== 'never' && (streaming.mode === 'always' || file.size > Math.min(streaming.minBytes, 4 << 20))) {
      rest.push(...(await planZip(file, streamed)));
    } else {
      rest.push(file);
    }
  }
  for (const [key, group] of loose) {
    const shp = group['.shp'];
    if (shp && needsStreaming(shp.size, group['.shx']?.size) && streamable(new Uint8Array(await shp.slice(0, 100).arrayBuffer()))) {
      streamed.push({
        title: stem(key + '.x'),
        shp: { blob: shp },
        dbf: group['.dbf'] ? { blob: group['.dbf'] } : undefined,
        prj: await group['.prj']?.text(),
        cpg: await group['.cpg']?.text(),
        qml: await group['.qml']?.text(),
      });
    } else {
      rest.push(...Object.values(group));
    }
  }
  return { streamed, rest };
}

/** A .zip: its large Shapefiles streamed from it; when it has any, its other files extracted, else the .zip as it is. */
async function planZip(zip: File, streamed: StreamedParts[]): Promise<File[]> {
  let entries: ZipEntry[];
  try {
    entries = await listZip(zip);
  } catch {
    return [zip];
  }
  const groups = new Map<string, Record<string, ZipEntry>>();
  for (const entry of entries) {
    const { key, ext } = splitName(entry.name);
    if (!parts.includes(ext)) continue;
    const group = groups.get(key) ?? {};
    group[ext] = entry;
    groups.set(key, group);
  }
  const big = [...groups].filter(([, g]) => g['.shp'] && needsStreaming(g['.shp'].size, g['.shx']?.size));
  if (!big.length) return [zip];
  const text = async (entry?: ZipEntry) => (entry ? new TextDecoder().decode(await zipEntryBytes(zip, entry)) : undefined);
  const taken = new Set<ZipEntry>();
  for (const [key, g] of big) {
    for (const e of Object.values(g)) taken.add(e);
    streamed.push({
      title: stem(key + '.x'),
      shp: { zip, entry: g['.shp'] },
      dbf: g['.dbf'] ? { zip, entry: g['.dbf'] } : undefined,
      prj: await text(g['.prj']),
      cpg: await text(g['.cpg']),
      qml: await text(g['.qml']),
    });
  }
  const others: File[] = [];
  for (const entry of entries) {
    if (taken.has(entry) || entry.size > 512 << 20) continue;
    others.push(new File([(await zipEntryBytes(zip, entry)) as BlobPart], entry.name.split('/').pop()!));
  }
  return others;
}

const DB_PREFIX = 'image-viewer-shp-';
/** Databases of the layers open in this page. */
const inUse = new Set<string>();

/** Deletes the browser copies of streamed Shapefiles left behind (a closed tab or a reload); a copy another tab uses goes when it closes. */
export async function clearStreamedCopies(): Promise<void> {
  if (typeof indexedDB === 'undefined' || !indexedDB.databases) return;
  try {
    for (const { name } of await indexedDB.databases()) {
      if (name?.startsWith(DB_PREFIX) && !inUse.has(name)) indexedDB.deleteDatabase(name);
    }
  } catch {
    // nothing to clear
  }
}

/**
 * Reads a Shapefile into the browser and makes its layer. `progress` hears
 * what is being read (fraction 0–1); `style` is the one that came with it.
 */
export async function openStreamedShapefile(source: StreamedParts, progress: (message: string, fraction: number) => void, style?: VectorStyleSpec | null): Promise<ServiceLayer> {
  await clearStreamedCopies();
  const db = `${DB_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  inUse.add(db);
  const worker = new Worker(new URL('./shp-worker.ts', import.meta.url), { type: 'module' });
  const forget = () => {
    worker.terminate();
    inUse.delete(db);
    if (typeof indexedDB !== 'undefined') indexedDB.deleteDatabase(db);
  };
  let info: ImportedShapefile;
  try {
    info = await new Promise<ImportedShapefile>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<ShpReply>) => {
        const reply = event.data;
        if (reply.type === 'progress') progress(reply.message, reply.fraction);
        else if (reply.type === 'imported') resolve(reply.info);
        else if (reply.type === 'error') reject(new Error(reply.message));
      };
      worker.onerror = (event) => reject(new Error(event.message || 'ワーカーが止まりました'));
      worker.postMessage({ type: 'import', db, shp: source.shp, dbf: source.dbf, prj: source.prj, cpg: source.cpg } satisfies ShpRequest);
    });
  } catch (error) {
    forget();
    throw error;
  }
  const streamed = new StreamedVector(worker, info);
  const fields: Field[] = info.fields.map((f) => ({ name: f.name, alias: f.name, type: f.type, editable: false, nullable: true, ...(f.type === 'string' ? { length: f.length } : {}) }));
  streamed.fieldNames = info.fields.map((f) => f.name);
  const layerStyle = new LayerStyle(streamed.layer, style ?? singleSpec(nextColor()));
  layerStyle.expectFeatures(info.shapes);
  const crs = source.prj ? (/^\s*\w+\["([^"]+)"/.exec(source.prj)?.[1] ?? '.prj') : 'WGS 84（.prj なし）';
  const info_: Array<[string, string]> = [
    ['種類', 'Shapefile（大容量・読み取り専用）'],
    ['座標系', crs],
    ['地物数', info.count.toLocaleString()],
    ['頂点数', info.vertices.toLocaleString()],
    ['表示', '表示範囲の地物だけを読み込み、縮小時は頂点と小さな地物を間引いています（ブラウザに一時保存、閉じると削除）'],
  ];
  if (info.encoding) info_.push(['文字コード', info.encoding === 'shift_jis' ? 'Shift_JIS' : info.encoding.toUpperCase()]);
  return {
    ref: null,
    badge: 'SHP',
    title: source.title,
    layer: streamed.layer,
    correction: null,
    vector: { source: streamed.source, fields, truncated: false, note: '表示範囲の地物のみ（縮小時は間引き）' },
    style: layerStyle,
    extent: info.extent,
    info: info_,
    dispose: () => {
      streamed.dispose();
      forget();
    },
  };
}

/** Whether a .shp header can be streamed (multipatches cannot). */
export function streamable(header: Uint8Array): boolean {
  try {
    return readShpHeader(header).shapeType !== 31;
  } catch {
    return false;
  }
}

/** The layer of a streamed Shapefile, loading the features of the view whenever the map stops moving. */
export class StreamedVector {
  readonly source = new VectorSource<Feature>();
  readonly layer = new VectorLayer({ source: this.source });
  /** Attribute names, in the order the worker sends values. */
  fieldNames: string[] = [];
  private features_ = new Map<number, Feature>();
  /** Features let go of, while something else (the selection) still holds them: taken again when back in view. */
  private released_ = new Map<number, WeakRef<Feature>>();
  private map_: OlMap | null = null;
  private mapKeys_: EventsKey[] = [];
  private readonly keys_: EventsKey[];
  private next_ = 0;
  private waiting_: number | null = null;
  private again_ = false;
  private loaded_: { extent: Extent; resolution: number } | null = null;
  /** Called after each load (tests wait on it). */
  onLoad: ((features: LoadedFeatures) => void) | null = null;

  constructor(
    private readonly worker: Worker,
    readonly info: ImportedShapefile,
  ) {
    worker.onmessage = (event: MessageEvent<ShpReply>) => this.reply_(event.data);
    this.keys_ = [
      // Added to the map, or taken off it.
      this.layer.on('propertychange', (e) => e.key === 'map' && this.attach_()),
      this.layer.on(['change:visible', 'change:maxResolution', 'change:minResolution'], () => this.request()),
    ].flat();
    this.attach_();
  }

  /** Loads what the view shows, unless it is loaded already (or a load is running: it runs again after). */
  request(): void {
    const map = this.map_;
    const size = map?.getSize();
    const view = map?.getView();
    const resolution = view?.getResolution();
    if (!map || !size || !view || !resolution || !this.layer.getVisible()) return;
    if (resolution > this.layer.getMaxResolution() || resolution < this.layer.getMinResolution()) return;
    const shown = view.calculateExtent(size);
    if (this.loaded_ && this.loaded_.resolution === resolution && containsExtent(this.loaded_.extent, shown)) return;
    if (this.waiting_ !== null) {
      this.again_ = true;
      return;
    }
    const extent = buffer(shown, Math.max(getWidth(shown), getHeight(shown)) * 0.25);
    this.waiting_ = ++this.next_;
    this.loaded_ = { extent, resolution };
    this.worker.postMessage({ type: 'load', id: this.waiting_, extent, resolution } satisfies ShpRequest);
  }

  dispose(): void {
    unByKey(this.keys_);
    unByKey(this.mapKeys_);
    this.source.clear(true);
    this.features_.clear();
    this.released_.clear();
  }

  private attach_(): void {
    const map = (this.layer.get('map') as OlMap | null) ?? null;
    if (map === this.map_) return;
    unByKey(this.mapKeys_);
    this.map_ = map;
    this.mapKeys_ = map ? [map.on('moveend', () => this.request())] : [];
    this.request();
  }

  private reply_(reply: ShpReply): void {
    if (reply.type === 'progress' || reply.type === 'imported') return;
    if (reply.type === 'error') {
      console.error(reply.message);
      this.loaded_ = null;
    } else {
      this.apply_(reply.features);
      this.onLoad?.(reply.features);
    }
    this.waiting_ = null;
    if (this.again_) {
      this.again_ = false;
      this.request();
    }
  }

  private apply_(loaded: LoadedFeatures): void {
    const kind = this.info.kind;
    const next = new Map<number, Feature>();
    const added: Feature[] = [];
    for (let i = 0; i < loaded.fids.length; i++) {
      const fid = loaded.fids[i];
      let feature = this.features_.get(fid);
      const held = !!feature;
      feature ??= this.released_.get(fid)?.deref();
      if (!feature) {
        feature = new Feature();
        feature.setId(fid);
      }
      const values = loaded.attributes[i];
      if (values) {
        const properties: Record<string, unknown> = {};
        this.fieldNames.forEach((name, n) => (properties[name] = values[n]));
        feature.setProperties(properties, true);
      }
      if (loaded.hasShape[i]) feature.setGeometry(geometryOf(kind, loaded, i));
      next.set(fid, feature);
      if (!held) added.push(feature);
    }
    const removed: Feature[] = [];
    for (const [fid, feature] of this.features_) {
      if (next.has(fid)) continue;
      removed.push(feature);
      this.released_.set(fid, new WeakRef(feature));
    }
    if (this.released_.size > 4 * next.size + 10_000) {
      for (const [fid, ref] of this.released_) if (!ref.deref()) this.released_.delete(fid);
    }
    for (const f of added) this.released_.delete(f.getId() as number);
    if (removed.length) this.source.removeFeatures(removed);
    if (added.length) this.source.addFeatures(added);
    this.features_ = next;
  }
}

/** The OpenLayers geometry of loaded feature `i`. */
function geometryOf(kind: number, loaded: LoadedFeatures, i: number): Geometry {
  const flat = Array.from(loaded.coords.subarray(loaded.coordStart[i], loaded.coordStart[i + 1]));
  const ends = Array.from(loaded.ends.subarray(loaded.endStart[i], loaded.endStart[i + 1]));
  if (kind === 1) return flat.length === 2 ? new Point(flat) : new MultiPoint(flat, 'XY');
  if (kind === 2) return ends.length <= 1 ? new LineString(flat, 'XY') : new MultiLineString(flat, 'XY', ends);
  const rings = Array.from(loaded.polygons.subarray(loaded.polyStart[i], loaded.polyStart[i + 1]));
  if (rings.length <= 1) return new Polygon(flat, 'XY', ends);
  const endss: number[][] = [];
  let r = 0;
  for (const count of rings) {
    endss.push(ends.slice(r, r + count));
    r += count;
  }
  return new MultiPolygon(flat, 'XY', endss);
}
