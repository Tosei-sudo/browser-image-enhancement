/**
 * What crosses between a script and the viewer: features as GeoJSON in
 * longitude / latitude (WGS 84), as a script expects them, and the viewer's
 * OpenLayers features in the map's projection. Everything coming from a
 * script is checked here: its shape, its size, and attribute values reduced
 * to text, numbers, booleans and null.
 */
import Feature from 'ol/Feature.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import WKT from 'ol/format/WKT.js';
import type Geometry from 'ol/geom/Geometry.js';
import Point from 'ol/geom/Point.js';
import { toLonLat } from 'ol/proj.js';
import type { Field } from '../services/index.js';
import { defuse } from '../table-text.js';

/** Most features a script reads or hands over in one call. */
export const MAX_FEATURES = 200_000;
/** Most attributes on one feature, and the longest text value kept. */
const MAX_PROPERTIES = 500;
const MAX_TEXT = 100_000;

const format = new GeoJSON();

/** A GeoJSON feature as a script sees it: `id` names it in later calls. */
export interface ScriptFeature {
  type: 'Feature';
  id?: string | number;
  geometry: object | null;
  properties: Record<string, string | number | boolean | null>;
}

export interface ScriptFeatureCollection {
  type: 'FeatureCollection';
  features: ScriptFeature[];
}

const ids = new WeakMap<Feature, string>();
let nextId = 1;

/** The id a script names `feature` by (the same in every call and run while the page is open). */
export function scriptId(feature: Feature): string {
  let id = ids.get(feature);
  if (!id) ids.set(feature, (id = `f${nextId++}`));
  return id;
}

/** A value a script may set: text, a number, a boolean or null; a `Date` becomes milliseconds. */
export function cleanValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'bigint') return Number(value);
  const text = (() => {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  })();
  return text.slice(0, MAX_TEXT);
}

/** The attributes of an object from a script (at most {@link MAX_PROPERTIES}). */
export function cleanProperties(value: unknown): Record<string, string | number | boolean | null> {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('properties はオブジェクトで指定してください');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_PROPERTIES) throw new RangeError(`属性が多すぎます（${MAX_PROPERTIES} 個まで）`);
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, v] of entries) {
    if (key === '' || key === 'geometry' || key.length > 255 || key === '__proto__') continue;
    out[key] = cleanValue(v);
  }
  return out;
}

const geometryTypes = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection']);

/** A GeoJSON geometry (longitude / latitude) from a script as a map geometry; throws when it is not one. */
export function readGeometry(value: unknown, projection: string): Geometry {
  const g = value as { type?: unknown; geometry?: unknown } | null;
  // A feature given where a geometry is asked: its geometry.
  if (g && typeof g === 'object' && g.type === 'Feature') return readGeometry(g.geometry, projection);
  if (!g || typeof g !== 'object' || typeof g.type !== 'string' || !geometryTypes.has(g.type)) throw new TypeError('GeoJSON のジオメトリ（type と coordinates）を指定してください');
  let geometry: Geometry;
  try {
    geometry = format.readGeometry(g, { dataProjection: 'EPSG:4326', featureProjection: projection });
  } catch (error) {
    throw new TypeError(`${g.type} の座標を読めません`, { cause: error });
  }
  const flat = (geometry as Geometry & { getFlatCoordinates?: () => number[] }).getFlatCoordinates?.() ?? [];
  if (flat.some((v) => !Number.isFinite(v))) throw new TypeError(`${g.type} の座標に数値でないものがあります`);
  return geometry;
}

/** A map geometry as GeoJSON in longitude / latitude. */
export function writeGeometry(geometry: Geometry, projection: string): object {
  return format.writeGeometryObject(geometry, { dataProjection: 'EPSG:4326', featureProjection: projection });
}

/**
 * Features from a script: a FeatureCollection, an array of features, one
 * feature, or bare geometries. Coordinates are longitude / latitude.
 */
export function readFeatures(value: unknown, projection: string): Array<{ geometry: Geometry | null; properties: Record<string, string | number | boolean | null>; id?: string }> {
  const v = value as { type?: unknown; features?: unknown } | null;
  const list: unknown[] = Array.isArray(value) ? value : v && typeof v === 'object' && v.type === 'FeatureCollection' && Array.isArray(v.features) ? v.features : [value];
  if (list.length > MAX_FEATURES) throw new RangeError(`地物が多すぎます（一度に ${MAX_FEATURES.toLocaleString()} 件まで）`);
  return list.map((item, i) => {
    const f = item as { type?: unknown; geometry?: unknown; properties?: unknown; id?: unknown } | null;
    if (!f || typeof f !== 'object') throw new TypeError(`${i + 1} 件目が地物ではありません`);
    try {
      if (f.type === 'Feature') {
        return {
          geometry: f.geometry === null || f.geometry === undefined ? null : readGeometry(f.geometry, projection),
          properties: cleanProperties(f.properties),
          ...(typeof f.id === 'string' || typeof f.id === 'number' ? { id: String(f.id) } : {}),
        };
      }
      return { geometry: readGeometry(f, projection), properties: {} };
    } catch (error) {
      throw new TypeError(`${i + 1} 件目: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  });
}

/** The attributes of a feature for a script (geometry left out; only plain values). */
export function propertiesOf(feature: Feature, fields?: readonly string[]): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  const geometryName = feature.getGeometryName();
  const names = fields ?? Object.keys(feature.getProperties());
  for (const name of names) {
    if (name === geometryName) continue;
    out[name] = cleanValue(feature.get(name));
  }
  return out;
}

/** Features as a FeatureCollection for a script, each with its {@link scriptId}. */
export function writeFeatures(features: readonly Feature[], projection: string, fields?: readonly string[]): ScriptFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: features.map((f) => {
      const geometry = f.getGeometry();
      return { type: 'Feature', id: scriptId(f), geometry: geometry ? writeGeometry(geometry, projection) : null, properties: propertiesOf(f, fields) };
    }),
  };
}

/** OpenLayers features from what a script handed over. */
export function toOlFeatures(items: ReturnType<typeof readFeatures>): Feature[] {
  return items.map(({ geometry, properties }) => {
    const f = new Feature(properties);
    if (geometry) f.setGeometry(geometry);
    return f;
  });
}

/** Fields for features a script made: the type each attribute's values have (numbers, whole numbers, text). */
export function inferFields(features: readonly Feature[]): Field[] {
  const kinds = new Map<string, Set<string>>();
  for (const f of features) {
    for (const [name, value] of Object.entries(propertiesOf(f))) {
      const set = kinds.get(name) ?? new Set<string>();
      kinds.set(name, set);
      if (value === null) continue;
      set.add(typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'double') : 'string');
    }
  }
  return [...kinds].map(([name, set]) => {
    const type: Field['type'] = set.has('string') || set.size === 0 ? 'string' : set.has('double') ? 'double' : 'integer';
    return { name, alias: name, type, editable: true, nullable: true };
  });
}

/** Fields a script described (`{ name, type, alias }`), checked. */
export function readFields(value: unknown): Field[] {
  if (!Array.isArray(value)) throw new TypeError('fields は配列で指定してください');
  const types = new Set(['string', 'integer', 'double', 'date']);
  const seen = new Set<string>();
  return value.map((item, i) => {
    const f = item as { name?: unknown; type?: unknown; alias?: unknown } | null;
    const name = typeof f === 'string' ? f : f?.name;
    if (typeof name !== 'string' || !name || name.length > 255) throw new TypeError(`fields の ${i + 1} 番目に name がありません`);
    if (seen.has(name)) throw new TypeError(`fields の ${name} が重複しています`);
    seen.add(name);
    const type = typeof f === 'object' && f && typeof f.type === 'string' ? f.type : 'string';
    if (!types.has(type)) throw new TypeError(`fields の ${name}: type は string・integer・double・date のどれかです`);
    const alias = typeof f === 'object' && f && typeof f.alias === 'string' ? f.alias.slice(0, 255) : name;
    return { name, alias, type: type as Field['type'], editable: true, nullable: true };
  });
}

/**
 * Features as CSV for a spreadsheet (BOM, CRLF, formulas defused): the
 * attributes, then the longitude and latitude of points, or WKT for other
 * geometries.
 */
export function featuresCsv(features: readonly Feature[], fields: readonly Field[], projection: string): string {
  const quote = (v: unknown) => {
    const s = defuse(v === null || v === undefined ? '' : String(v));
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const columns = fields.filter((f) => f.type !== 'other');
  const geometries = features.map((f) => f.getGeometry());
  const points = geometries.every((g) => !g || g instanceof Point);
  const any = geometries.some((g) => g);
  const wkt = new WKT();
  const head = [...columns.map((f) => f.name), ...(any ? (points ? ['経度', '緯度'] : ['WKT']) : [])];
  const rows = features.map((f, i) => {
    const g = geometries[i];
    const values = columns.map((c) => {
      const v = f.get(c.name);
      return c.type === 'date' && typeof v === 'number' ? new Date(v).toISOString() : v;
    });
    if (any && points) {
      const lonLat = g ? toLonLat((g as Point).getCoordinates(), projection) : null;
      values.push(lonLat ? lonLat[0] : '', lonLat ? lonLat[1] : '');
    } else if (any) {
      values.push(g ? wkt.writeGeometry(g, { dataProjection: 'EPSG:4326', featureProjection: projection, decimals: 8 }) : '');
    }
    return values;
  });
  return `\uFEFF${[head, ...rows].map((r) => r.map(quote).join(',')).join('\r\n')}`;
}

/** Text file types a script may save, by extension. */
export const TEXT_TYPES: Record<string, string> = {
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  json: 'application/json',
  geojson: 'application/geo+json',
  md: 'text/markdown',
};

/** A file name from a script: no folders or characters file systems refuse, and one of `extensions`. */
export function fileName(value: unknown, fallback: string, extensions: readonly string[]): string {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  const base = [...raw.split(/[\\/]/).pop()!]
    .map((c) => (c.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(c) ? '_' : c))
    .join('')
    .replace(/^\.+/, '')
    .slice(0, 120);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (extensions.includes(ext)) return base;
  return `${base || 'script'}.${extensions[0]}`;
}
