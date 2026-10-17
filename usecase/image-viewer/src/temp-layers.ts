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
import { parseValue, type DrawableType, type EditTarget } from './edit-session.js';
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
  /** What new features are drawn as, for a layer designed empty; else (or null: any) the features' own type. */
  geometryType?: DrawableType | null;
  /** Attributes a new feature starts with (the defaults of a designed layer). */
  defaults?: Record<string, unknown>;
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
    ...(result.geometryType !== undefined ? { geometryType: result.geometryType } : {}),
    ...(result.defaults ? { defaults: result.defaults } : {}),
    features: format.writeFeaturesObject(result.features),
  };
}

/** The attribute types a designed layer can have. */
export type DesignType = 'string' | 'integer' | 'double' | 'date';

/** One attribute of a layer being designed, as typed in the dialog (or given by a script). */
export interface FieldDesign {
  name: string;
  type: DesignType;
  /** Heading in the table; the name when empty. */
  alias?: string;
  /** Whether a value is needed (not nullable). */
  required?: boolean;
  /** Longest text, for strings. */
  length?: number | null;
  /** Allowed range, for numbers (either end may be left open). */
  min?: number | null;
  max?: number | null;
  /** Allowed values, one per line or comma separated: `1=住宅` (code = name) or just the value. */
  codes?: string;
  /** The value new features start with, as typed. */
  defaultValue?: string;
}

/** A new, empty layer as designed by the person: its name, geometry, attributes and CRS. */
export interface LayerDesign {
  title: string;
  /** null: any (the edit toolbar asks for each new feature). */
  geometryType: DrawableType | null;
  fields: FieldDesign[];
  crs?: TargetCrs;
}

/** Names Shapefile and GeoPackage writers keep for themselves. */
const reserved = new Set(['fid', 'geom', 'geometry', 'shape']);

/** The allowed values of `text` (`1=住宅, 2=店舗` or `赤, 青`), numbers for numeric types. */
export function parseCodes(text: string, type: DesignType): Array<{ code: string | number; name: string }> | { error: string } {
  const items = text
    .split(/[\n,、]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const codes: Array<{ code: string | number; name: string }> = [];
  for (const item of items) {
    const eq = item.indexOf('=');
    const raw = (eq >= 0 ? item.slice(0, eq) : item).trim();
    const name = (eq >= 0 ? item.slice(eq + 1) : item).trim() || raw;
    if (!raw) return { error: `候補値「${item}」の値が空です` };
    let code: string | number = raw;
    if (type === 'integer' || type === 'double') {
      code = Number(raw);
      if (!Number.isFinite(code) || (type === 'integer' && !Number.isInteger(code))) return { error: `候補値「${raw}」は${type === 'integer' ? '整数' : '数値'}にしてください` };
    }
    if (codes.some((c) => c.code === code)) return { error: `候補値「${raw}」が重複しています` };
    codes.push({ code, name });
  }
  return codes;
}

/** The fields and starting values of a design, or what is wrong with it (in the person's words). */
export function designFields(design: LayerDesign): { fields: Field[]; defaults: Record<string, unknown> } | { errors: string[] } {
  const errors: string[] = [];
  const fields: Field[] = [];
  const defaults: Record<string, unknown> = {};
  const seen = new Set<string>();
  if (!design.title.trim()) errors.push('レイヤーの名前を入れてください');
  for (const [i, d] of design.fields.entries()) {
    const name = d.name.trim();
    const label = name ? `属性「${name}」` : `${i + 1} 番目の属性`;
    if (!name) {
      errors.push(`${label}の名前を入れてください`);
      continue;
    }
    if ([...name].some((c) => c.charCodeAt(0) < 0x20 || c === '"')) errors.push(`${label}の名前に使えない文字があります`);
    if (reserved.has(name.toLowerCase())) errors.push(`${label}は書き出しで使う名前なので、別の名前にしてください`);
    if (seen.has(name.toLowerCase())) errors.push(`${label}が重複しています（大文字・小文字は区別しません）`);
    seen.add(name.toLowerCase());
    const field: Field = { name, alias: d.alias?.trim() || name, type: d.type, editable: true, nullable: !d.required };
    if (d.type === 'string' && d.length != null) {
      if (!Number.isInteger(d.length) || d.length < 1) errors.push(`${label}の文字数の上限は 1 以上の整数にしてください`);
      else field.length = d.length;
    }
    if ((d.type === 'integer' || d.type === 'double') && (d.min != null || d.max != null)) {
      const min = d.min ?? -Infinity;
      const max = d.max ?? Infinity;
      if (Number.isNaN(min) || Number.isNaN(max) || min > max) errors.push(`${label}の範囲は 最小 ≦ 最大 にしてください`);
      else field.range = [min, max];
    }
    if (d.codes?.trim() && d.type !== 'date') {
      const codes = parseCodes(d.codes, d.type);
      if ('error' in codes) errors.push(`${label}: ${codes.error}`);
      else if (codes.length) field.codes = codes;
    }
    if (d.defaultValue?.trim()) {
      const value = parseValue(field, d.defaultValue);
      if (value !== null && typeof value === 'object') errors.push(`既定値: ${value.error}`);
      else if (field.codes && !field.codes.some((c) => c.code === value)) errors.push(`${label}の既定値は候補値から選んでください`);
      else defaults[name] = value;
    }
    fields.push(field);
  }
  return errors.length ? { errors } : { fields, defaults };
}

/** The record of a new, empty layer designed by the person; throws what is wrong with the design. */
export function designRecord(design: LayerDesign, made = '新規作成'): TempRecord {
  const checked = designFields(design);
  if ('errors' in checked) throw new Error(checked.errors.join('。'));
  return {
    id: crypto.randomUUID(),
    title: design.title.trim(),
    made,
    created: Date.now(),
    fields: checked.fields,
    crs: design.crs ?? wgs84,
    geometryType: design.geometryType,
    defaults: checked.defaults,
    features: format.writeFeaturesObject([]),
  };
}

/** The Japanese names of the geometry types, for menus and the information panel. */
export const geometryNames: Record<DrawableType, string> = {
  Point: 'ポイント',
  LineString: 'ライン',
  Polygon: 'ポリゴン',
  MultiPoint: 'マルチポイント',
  MultiLineString: 'マルチライン',
  MultiPolygon: 'マルチポリゴン',
};

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
    geometryType: record.geometryType !== undefined ? record.geometryType : geometryTypeOf(features),
    template: { ...record.defaults },
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
    temp: record,
    editTarget,
    fileCrs: record.crs,
    exportCrs: record.crs,
    closeWarning: `一時レイヤー「${record.title}」を閉じると、ブラウザに保存した内容も消えます。閉じますか？`,
    extent: extent && !isEmpty(extent) ? extent : null,
    info: [
      ['種類', '一時レイヤー（ブラウザに保存）'],
      ['作成', record.made],
      ['座標系', record.crs.name],
      ...(record.geometryType !== undefined ? [['ジオメトリ', record.geometryType ? geometryNames[record.geometryType] : '指定なし（混在）'] as [string, string]] : []),
      ['地物数', features.length.toLocaleString()],
    ],
    dispose: () => {
      style.forget();
      void store.delete(record.id).catch(() => {});
    },
  };
}
