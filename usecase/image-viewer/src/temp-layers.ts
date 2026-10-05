/**
 * Temporary layers: what the processing tools make (buffers, lines,
 * centroids, Voronoi cells…). Like QGIS's scratch layers they live in the
 * viewer, but they are kept in the browser (IndexedDB), so they are still
 * there after a reload, until they are closed. They can be edited (saving
 * writes them to the browser again) and exported like any vector layer.
 */
import type Feature from 'ol/Feature.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import { isEmpty } from 'ol/extent.js';
import type { DrawableType, EditTarget } from './edit-session.js';
import { nextColor, type Field, type ServiceLayer } from './services/index.js';
import { vectorLayer } from './services/vector.js';
import { LayerStyle, singleSpec } from './vector-style.js';
import { wgs84, type TargetCrs } from './vector-write.js';
import type { ProcessingResult } from './processing/common.js';

/** A temporary layer as kept in the browser. */
export interface TempRecord {
  id: string;
  title: string;
  /** What made it (`測地線バッファ 100 m（roads）`), for the information panel. */
  made: string;
  /** When it was made (ms since the epoch); layers open again in this order. */
  created: number;
  fields: Field[];
  crs: TargetCrs;
  /** The features as a GeoJSON FeatureCollection, coordinates in `EPSG:3857` as held (no rounding). */
  features: object;
}

/** Where temporary layers are kept. */
export interface TempStore {
  list(): Promise<TempRecord[]>;
  put(record: TempRecord): Promise<void>;
  delete(id: string): Promise<void>;
}

const DB = 'image-viewer-temp';
const STORE = 'layers';

/** The temporary layers in IndexedDB; a store that keeps nothing where there is no IndexedDB. */
export function browserStore(): TempStore {
  if (typeof indexedDB === 'undefined') return memoryStore();
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    (db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
  const run = async <T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest): Promise<T> => {
    const tx = (await open()).transaction(STORE, mode);
    const request = body(tx.objectStore(STORE));
    return new Promise<T>((resolve, reject) => {
      tx.oncomplete = () => resolve(request.result as T);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  return {
    list: async () => (await run<TempRecord[]>('readonly', (s) => s.getAll())).sort((a, b) => a.created - b.created),
    put: (record) => run('readwrite', (s) => s.put(record)),
    delete: (id) => run('readwrite', (s) => s.delete(id)),
  };
}

/** A store in memory (tests, and browsers without IndexedDB). */
export function memoryStore(): TempStore {
  const records = new Map<string, TempRecord>();
  return {
    list: async () => [...records.values()].sort((a, b) => a.created - b.created),
    put: async (record) => void records.set(record.id, structuredClone(record)),
    delete: async (id) => void records.delete(id),
  };
}

const format = new GeoJSON();

/** The features of a record, in `EPSG:3857`. */
export function featuresOf(record: TempRecord): Feature[] {
  return format.readFeatures(record.features);
}

/** The record of a processing result. */
export function recordOf(result: ProcessingResult, made: string): TempRecord {
  return {
    id: crypto.randomUUID(),
    title: result.title,
    made,
    created: Date.now(),
    fields: result.fields,
    crs: result.crs ?? wgs84,
    features: format.writeFeaturesObject(result.features),
  };
}

/** The one geometry type of `features`, when they all have the same; null when mixed or none. */
export function geometryTypeOf(features: Feature[]): DrawableType | null {
  const types = new Set(features.map((f) => f.getGeometry()?.getType()).filter((t) => t !== undefined));
  const [only] = types;
  return types.size === 1 && ['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon'].includes(only) ? (only as DrawableType) : null;
}

/**
 * A layer for the list from a record: editable (saving writes the record
 * again), exported in its CRS by default, and forgotten when it is closed.
 */
export function tempLayer(record: TempRecord, store: TempStore): ServiceLayer {
  const features = featuresOf(record);
  const layer = vectorLayer(features);
  const style = new LayerStyle(layer, singleSpec(nextColor()));
  const source = layer.getSource()!;
  const extent = source.getExtent();
  const save = async () => {
    record.features = format.writeFeaturesObject(source.getFeatures());
    await store.put(record);
  };
  const editTarget: EditTarget = {
    canCreate: true,
    canUpdate: true,
    canDelete: true,
    geometryType: geometryTypeOf(features),
    template: {},
    savedTo: 'ブラウザ',
    async save() {
      await save();
      return { note: 'ブラウザに保存しました' };
    },
  };
  return {
    ref: null,
    badge: '一時',
    title: record.title,
    layer,
    correction: null,
    vector: { source, fields: record.fields, truncated: false },
    style,
    styleKey: `temp:${record.id}`,
    editTarget,
    fileCrs: record.crs,
    exportCrs: record.crs,
    closeWarning: `一時レイヤー「${record.title}」を閉じると、ブラウザに保存した内容も消えます。閉じますか？`,
    extent: extent && !isEmpty(extent) ? extent : null,
    info: [
      ['種類', '一時レイヤー（ブラウザに保存）'],
      ['作成', record.made],
      ['座標系', record.crs.name],
      ['地物数', features.length.toLocaleString()],
    ],
    dispose: () => {
      style.forget();
      void store.delete(record.id).catch(() => {});
    },
  };
}
