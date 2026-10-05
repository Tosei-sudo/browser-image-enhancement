/**
 * Writing vector layers to files: GeoJSON, Shapefile (.shp, .shx, .dbf,
 * .prj and .cpg, in a .zip) and GeoPackage. Features are in the map's
 * projection (`EPSG:3857`) and are written in the CRS asked for; the
 * attributes are the layer's fields. A style can go with a Shapefile (a
 * `.qml` beside it) or into a GeoPackage (its `layer_styles` table), as QGIS
 * keeps them.
 */
import type Feature from 'ol/Feature.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import type Geometry from 'ol/geom/Geometry.js';
import type LineString from 'ol/geom/LineString.js';
import type MultiLineString from 'ol/geom/MultiLineString.js';
import type MultiPoint from 'ol/geom/MultiPoint.js';
import type MultiPolygon from 'ol/geom/MultiPolygon.js';
import type Point from 'ol/geom/Point.js';
import type Polygon from 'ol/geom/Polygon.js';
import { encodeGeometry, openGeoPackageDb, quote } from './geopackage.js';
import type { Field } from './services/index.js';
import type { SqlValue } from './sqlite.js';
import type { NamedBytes } from './vector-files.js';
import { styleQml, symbolKindOf, type SymbolKind } from './style-file.js';
import type { VectorStyleSpec } from './vector-style.js';

/** The CRS a file is written in. */
export interface TargetCrs {
  /** OpenLayers projection code (`EPSG:4326`, or one registered from the file's WKT). */
  projection: string;
  /** Name for people and for GeoJSON's legacy `crs` member. */
  name: string;
  /** WKT for the .prj and the GeoPackage definition; null when unknown. */
  wkt: string | null;
  /** EPSG code, when it has one. */
  epsg: number | null;
}

/** WGS 84 longitude / latitude, the CRS GeoJSON (RFC 7946) is in. */
export const wgs84: TargetCrs = {
  projection: 'EPSG:4326',
  name: 'WGS 84（EPSG:4326）',
  epsg: 4326,
  wkt: 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]',
};

/** Web Mercator, the map's own projection. */
export const webMercator: TargetCrs = {
  projection: 'EPSG:3857',
  name: 'Web メルカトル（EPSG:3857）',
  epsg: 3857,
  wkt: 'PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],UNIT["Meter",1.0]]',
};

/** A feature's geometry in `crs` (a copy). */
function geometryIn(feature: Feature, crs: TargetCrs): Geometry | null {
  const g = feature.getGeometry();
  return g ? g.clone().transform('EPSG:3857', crs.projection) : null;
}

/** Fields that are written: geometry-less values the formats can hold. */
function writable(fields: Field[]): Field[] {
  return fields.filter((f) => f.type !== 'other');
}

/** A date value (epoch milliseconds, or text) as a Date; null when it is not one. */
function asDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(typeof value === 'number' ? value : String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A value for a text column: objects as JSON. */
function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : typeof value === 'boolean' ? Number(value) : Number(value);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- GeoJSON

/**
 * GeoJSON text. WGS 84 is plain RFC 7946; any other CRS is named in the
 * legacy `crs` member (GDAL and QGIS read it). Dates are ISO 8601 text.
 */
export function writeGeoJson(features: Feature[], fields: Field[], crs: TargetCrs = wgs84): string {
  const format = new GeoJSON();
  const dates = new Set(fields.filter((f) => f.type === 'date').map((f) => f.name));
  const list = writable(fields);
  const out = {
    type: 'FeatureCollection',
    ...(crs.projection === 'EPSG:4326' ? {} : { crs: { type: 'name', properties: { name: crs.epsg ? `urn:ogc:def:crs:EPSG::${crs.epsg}` : crs.name } } }),
    features: features.map((f) => {
      const geometry = geometryIn(f, crs);
      const properties: Record<string, unknown> = {};
      for (const field of list) {
        const value = f.get(field.name);
        properties[field.name] = dates.has(field.name) ? (asDate(value)?.toISOString() ?? null) : value instanceof Uint8Array ? null : (value ?? null);
      }
      return { type: 'Feature', ...(f.getId() !== undefined ? { id: f.getId() } : {}), geometry: geometry ? format.writeGeometryObject(geometry, { decimals: crs.projection === 'EPSG:4326' ? 8 : 3 }) : null, properties };
    }),
  };
  return JSON.stringify(out);
}

// ---------------------------------------------------------------- Shapefile

type ShapeKind = 'point' | 'multipoint' | 'line' | 'polygon';
const shapeTypes: Record<ShapeKind, number> = { point: 1, line: 3, polygon: 5, multipoint: 8 };

function shapeKind(g: Geometry): ShapeKind | null {
  switch (g.getType()) {
    case 'Point':
      return 'point';
    case 'MultiPoint':
      return 'multipoint';
    case 'LineString':
    case 'MultiLineString':
      return 'line';
    case 'Polygon':
    case 'MultiPolygon':
      return 'polygon';
    default:
      return null;
  }
}

/** Twice the signed area of a ring (positive: counter-clockwise, y up). */
function ringArea(ring: number[][]): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return a;
}

/** The parts of a line or polygon geometry; polygon outer rings clockwise and holes counter-clockwise, as Shapefiles want. */
function partsOf(g: Geometry): number[][][] {
  const ring = (r: number[][], outer: boolean) => (ringArea(r) > 0 === outer ? [...r].reverse() : r);
  switch (g.getType()) {
    case 'LineString':
      return [(g as LineString).getCoordinates()];
    case 'MultiLineString':
      return (g as MultiLineString).getCoordinates();
    case 'Polygon':
      return (g as Polygon).getCoordinates().map((r, i) => ring(r, i === 0));
    case 'MultiPolygon':
      return (g as MultiPolygon).getCoordinates().flatMap((p) => p.map((r, i) => ring(r, i === 0)));
    default:
      return [];
  }
}

/** The record content (shape type onwards) of a geometry; null shape for none. */
function shapeRecord(g: Geometry | null, kind: ShapeKind): Uint8Array {
  if (!g) return new Uint8Array(4);
  if (kind === 'point') {
    const [x, y] = (g as Point).getCoordinates();
    const out = new Uint8Array(20);
    const v = new DataView(out.buffer);
    v.setInt32(0, 1, true);
    v.setFloat64(4, x, true);
    v.setFloat64(12, y, true);
    return out;
  }
  const [minX, minY, maxX, maxY] = g.getExtent();
  const parts = kind === 'multipoint' ? [(g as MultiPoint).getCoordinates()] : partsOf(g);
  const points = parts.flat();
  const head = kind === 'multipoint' ? 40 : 44 + parts.length * 4;
  const out = new Uint8Array(head + points.length * 16);
  const v = new DataView(out.buffer);
  v.setInt32(0, shapeTypes[kind], true);
  [minX, minY, maxX, maxY].forEach((b, i) => v.setFloat64(4 + i * 8, b, true));
  if (kind === 'multipoint') {
    v.setInt32(36, points.length, true);
  } else {
    v.setInt32(36, parts.length, true);
    v.setInt32(40, points.length, true);
    let start = 0;
    parts.forEach((p, i) => {
      v.setInt32(44 + i * 4, start, true);
      start += p.length;
    });
  }
  points.forEach(([x, y], i) => {
    v.setFloat64(head + i * 16, x, true);
    v.setFloat64(head + i * 16 + 8, y, true);
  });
  return out;
}

/** The .shp and .shx of geometries of one kind. */
function shpAndShx(geometries: Array<Geometry | null>, kind: ShapeKind): { shp: Uint8Array<ArrayBuffer>; shx: Uint8Array<ArrayBuffer> } {
  const records = geometries.map((g) => shapeRecord(g, kind));
  const shpLength = 100 + records.reduce((n, r) => n + 8 + r.length, 0);
  const shp = new Uint8Array(shpLength);
  const shx = new Uint8Array(100 + records.length * 8);
  const extent = [Infinity, Infinity, -Infinity, -Infinity];
  for (const g of geometries) {
    if (!g) continue;
    const [a, b, c, d] = g.getExtent();
    extent[0] = Math.min(extent[0], a);
    extent[1] = Math.min(extent[1], b);
    extent[2] = Math.max(extent[2], c);
    extent[3] = Math.max(extent[3], d);
  }
  if (!Number.isFinite(extent[0])) extent.fill(0);
  for (const [bytes, length] of [
    [shp, shpLength],
    [shx, shx.length],
  ] as const) {
    const v = new DataView(bytes.buffer);
    v.setInt32(0, 9994);
    v.setInt32(24, length / 2);
    v.setInt32(28, 1000, true);
    v.setInt32(32, shapeTypes[kind], true);
    extent.forEach((b, i) => v.setFloat64(36 + i * 8, b, true));
  }
  const shpView = new DataView(shp.buffer);
  const shxView = new DataView(shx.buffer);
  let at = 100;
  records.forEach((r, i) => {
    shxView.setInt32(100 + i * 8, at / 2);
    shxView.setInt32(104 + i * 8, r.length / 2);
    shpView.setInt32(at, i + 1);
    shpView.setInt32(at + 4, r.length / 2);
    shp.set(r, at + 8);
    at += 8 + r.length;
  });
  return { shp, shx };
}

const utf8 = new TextEncoder();

/** `text` as UTF-8, cut to at most `bytes` bytes without splitting a character. */
function utf8Cut(text: string, bytes: number): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const b = utf8.encode(ch);
    if (out.length + b.length > bytes) break;
    out.push(...b);
  }
  return new Uint8Array(out);
}

interface DbfField {
  field: Field;
  name: Uint8Array;
  type: 'C' | 'N' | 'D';
  length: number;
  decimals: number;
}

/** Column definitions for the .dbf: names cut to 10 bytes and made unique, widths from the values. */
function dbfFields(fields: Field[], features: Feature[]): DbfField[] {
  const used = new Set<string>();
  return writable(fields).map((field) => {
    let name = utf8Cut(field.name, 10);
    for (let n = 1; used.has(new TextDecoder().decode(name).toUpperCase()); n++) {
      const suffix = utf8.encode(`_${n}`);
      name = new Uint8Array([...utf8Cut(field.name, 10 - suffix.length), ...suffix]);
    }
    used.add(new TextDecoder().decode(name).toUpperCase());
    const values = features.map((f) => f.get(field.name));
    if (field.type === 'date') return { field, name, type: 'D', length: 8, decimals: 0 };
    if (field.type === 'integer' || field.type === 'oid') return { field, name, type: 'N', length: 18, decimals: 0 };
    if (field.type === 'double') {
      let decimals = 0;
      for (const v of values) {
        const n = asNumber(v);
        if (n === null || Number.isInteger(n)) continue;
        decimals = Math.max(decimals, Math.min(15, (String(n).split('.')[1] ?? '').replace(/e.*$/i, '').length));
      }
      return { field, name, type: 'N', length: 24, decimals };
    }
    const length = Math.min(254, Math.max(1, field.length ?? 0, ...values.map((v) => utf8.encode(asText(v) ?? '').length)));
    return { field, name, type: 'C', length, decimals: 0 };
  });
}

/** A .dbf of the features' attributes, text in UTF-8. */
function writeDbf(columns: DbfField[], features: Feature[]): Uint8Array<ArrayBuffer> {
  const headerLength = 32 + columns.length * 32 + 1;
  const recordLength = 1 + columns.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(headerLength + features.length * recordLength + 1);
  const v = new DataView(out.buffer);
  const today = new Date();
  out.set([0x03, today.getFullYear() - 1900, today.getMonth() + 1, today.getDate()]);
  v.setUint32(4, features.length, true);
  v.setUint16(8, headerLength, true);
  v.setUint16(10, recordLength, true);
  columns.forEach((c, i) => {
    const at = 32 + i * 32;
    out.set(c.name, at);
    out[at + 11] = c.type.charCodeAt(0);
    out[at + 16] = c.length;
    out[at + 17] = c.decimals;
  });
  out[headerLength - 1] = 0x0d;
  out.fill(0x20, headerLength, out.length - 1);
  features.forEach((f, r) => {
    let at = headerLength + r * recordLength + 1;
    for (const c of columns) {
      const value = f.get(c.field.name);
      let cell: Uint8Array | null = null;
      if (c.type === 'C') {
        const text = asText(value instanceof Uint8Array ? null : value);
        if (text !== null) cell = utf8Cut(text, c.length);
      } else if (c.type === 'D') {
        const d = asDate(value);
        if (d) cell = utf8.encode(`${d.getUTCFullYear()}`.padStart(4, '0') + `${d.getUTCMonth() + 1}`.padStart(2, '0') + `${d.getUTCDate()}`.padStart(2, '0'));
      } else {
        const n = asNumber(value);
        if (n !== null) {
          let text = c.decimals ? n.toFixed(c.decimals) : String(Math.round(n));
          if (text.length > c.length) text = n.toExponential(c.length - 7);
          cell = utf8.encode(text.padStart(c.length));
        }
      }
      if (cell) out.set(cell.subarray(0, c.length), at);
      at += c.length;
    }
  });
  out[out.length - 1] = 0x1a;
  return out;
}

/**
 * The files of a Shapefile: .shp, .shx, .dbf, .prj (when the CRS has WKT)
 * and .cpg (UTF-8). A Shapefile holds one kind of geometry: features of
 * different kinds go to one Shapefile per kind (`name_point`, `name_line`…).
 */
export function writeShapefile(name: string, features: Feature[], fields: Field[], crs: TargetCrs = wgs84, style?: VectorStyleSpec): NamedBytes[] {
  const groups = new Map<ShapeKind, Array<{ feature: Feature; geometry: Geometry | null }>>();
  const empty: Feature[] = [];
  for (const feature of features) {
    const geometry = geometryIn(feature, crs);
    const kind = geometry ? shapeKind(geometry) : null;
    if (!kind) {
      empty.push(feature);
      continue;
    }
    groups.set(kind, [...(groups.get(kind) ?? []), { feature, geometry }]);
  }
  // Features without a geometry (or with a collection) go with the first kind, as null shapes.
  if (!groups.size) groups.set('point', []);
  const [first] = groups.values();
  first.push(...empty.map((feature) => ({ feature, geometry: null })));

  const out: NamedBytes[] = [];
  for (const [kind, items] of groups) {
    const base = groups.size > 1 ? `${name}_${kind}` : name;
    const list = items.map((i) => i.feature);
    const { shp, shx } = shpAndShx(
      items.map((i) => i.geometry),
      kind,
    );
    const columns = dbfFields(fields, list);
    out.push({ name: `${base}.shp`, bytes: shp }, { name: `${base}.shx`, bytes: shx }, { name: `${base}.dbf`, bytes: writeDbf(columns, list) });
    if (crs.wkt) out.push({ name: `${base}.prj`, bytes: utf8.encode(crs.wkt) });
    out.push({ name: `${base}.cpg`, bytes: utf8.encode('UTF-8') });
    if (style) {
      // QGIS reads `name.qml` with `name.shp`; the style names the columns as written.
      const rename = new Map(columns.map((c) => [c.field.name, new TextDecoder().decode(c.name)]));
      out.push({ name: `${base}.qml`, bytes: utf8.encode(styleQml(style, kind === 'multipoint' ? 'point' : kind, rename)) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- .zip

let crcTable: Uint32Array | null = null;

function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = ~0;
  for (const b of data) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** A .zip of `files`, stored without compression (names in UTF-8). */
export function zipFiles(files: NamedBytes[]): Uint8Array<ArrayBuffer> {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = utf8.encode(f.name);
    const crc = crc32(f.bytes);
    const l = new Uint8Array(30 + name.length);
    const lv = new DataView(l.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // names in UTF-8
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.bytes.length, true);
    lv.setUint32(22, f.bytes.length, true);
    lv.setUint16(26, name.length, true);
    l.set(name, 30);
    const c = new Uint8Array(46 + name.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.bytes.length, true);
    cv.setUint32(24, f.bytes.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    c.set(name, 46);
    local.push(l, f.bytes);
    central.push(c);
    offset += l.length + f.bytes.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, files.length, true);
  v.setUint16(10, files.length, true);
  v.setUint32(12, size, true);
  v.setUint32(16, offset, true);
  const parts = [...local, ...central, end];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- GeoPackage

/** The SQL column type of a field in a new GeoPackage. */
function sqlType(field: Field, features: Feature[]): string {
  switch (field.type) {
    case 'integer':
    case 'oid':
      return 'INTEGER';
    case 'double':
      return 'REAL';
    case 'date': {
      // DATE when every value is a day (midnight UTC), else DATETIME.
      const days = features.every((f) => {
        const d = asDate(f.get(field.name));
        return !d || d.getTime() % 86_400_000 === 0;
      });
      return days ? 'DATE' : 'DATETIME';
    }
    default:
      return field.length ? `TEXT(${field.length})` : 'TEXT';
  }
}

/** A value for a GeoPackage column of `type` (as declared). */
export function sqlValue(value: unknown, type: string): SqlValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Uint8Array) return value;
  if (/^(DATE|DATETIME)\b/i.test(type)) {
    const d = asDate(value);
    if (!d) return null;
    return /^DATE\b/i.test(type) && !/^DATETIME/i.test(type) ? d.toISOString().slice(0, 10) : d.toISOString();
  }
  if (/^(INTEGER|INT|MEDIUMINT|SMALLINT|TINYINT|BOOLEAN|REAL|DOUBLE|FLOAT|NUMERIC)\b/i.test(type)) {
    const n = asNumber(value);
    return n === null ? null : /^(REAL|DOUBLE|FLOAT|NUMERIC)/i.test(type) ? n : Math.round(n);
  }
  return asText(value);
}

/** OGC WKT of a CRS for `gpkg_spatial_ref_sys`, or `undefined` as the spec allows. */
function srsRow(crs: TargetCrs): { id: number; organization: string; code: number; name: string; definition: string } {
  if (crs.epsg) return { id: crs.epsg, organization: 'EPSG', code: crs.epsg, name: crs.name, definition: crs.wkt ?? 'undefined' };
  return { id: 100000, organization: 'NONE', code: 100000, name: crs.name, definition: crs.wkt ?? 'undefined' };
}

/** The GeoPackage geometry type name of features: the one type they share, else GEOMETRY. */
function geometryTypeName(geometries: Array<Geometry | null>): string {
  const types = new Set(geometries.filter((g): g is Geometry => !!g).map((g) => g.getType().toUpperCase()));
  return types.size === 1 ? [...types][0] : 'GEOMETRY';
}

/**
 * A new GeoPackage with one feature table named `name`: an integer `fid`,
 * a `geom` column and one column per field, with an R-tree spatial index.
 */
export async function writeGeoPackage(name: string, features: Feature[], fields: Field[], crs: TargetCrs = wgs84, style?: VectorStyleSpec): Promise<Uint8Array<ArrayBuffer>> {
  const db = await openGeoPackageDb();
  try {
    const srs = srsRow(crs);
    const geometries = features.map((f) => geometryIn(f, crs));
    const list = writable(fields);
    // Column names: unique ignoring case (SQLite), and not the id or geometry column.
    const used = new Set(['fid', 'geom']);
    const columns = list.map((field) => {
      let column = field.name;
      for (let n = 1; used.has(column.toLowerCase()); n++) column = `${field.name}_${n}`;
      used.add(column.toLowerCase());
      return { field, column, type: sqlType(field, features) };
    });
    const geometryType = geometryTypeName(geometries);
    const extent = [Infinity, Infinity, -Infinity, -Infinity];
    for (const g of geometries) {
      if (!g) continue;
      const [a, b, c, d] = g.getExtent();
      extent[0] = Math.min(extent[0], a);
      extent[1] = Math.min(extent[1], b);
      extent[2] = Math.max(extent[2], c);
      extent[3] = Math.max(extent[3], d);
    }
    const table = quote(name);
    const rtree = quote(`rtree_${name}_geom`);
    db.exec(`PRAGMA application_id = 1196444487; PRAGMA user_version = 10400;
      CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL, srs_id INTEGER PRIMARY KEY, organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT);
      CREATE TABLE gpkg_contents (table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE, description TEXT DEFAULT '', last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER, CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id));
      CREATE TABLE gpkg_geometry_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL, CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name), CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name), CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id));
      CREATE TABLE gpkg_extensions (table_name TEXT, column_name TEXT, extension_name TEXT NOT NULL, definition TEXT NOT NULL, scope TEXT NOT NULL, CONSTRAINT ge_tce UNIQUE (table_name, column_name, extension_name));
      INSERT INTO gpkg_spatial_ref_sys VALUES ('Undefined cartesian SRS', -1, 'NONE', -1, 'undefined', 'undefined cartesian coordinate reference system');
      INSERT INTO gpkg_spatial_ref_sys VALUES ('Undefined geographic SRS', 0, 'NONE', 0, 'undefined', 'undefined geographic coordinate reference system');`);
    db.run('INSERT OR REPLACE INTO gpkg_spatial_ref_sys VALUES (?, ?, ?, ?, ?, NULL)', [srs.name, srs.id, srs.organization, srs.code, srs.definition]);
    if (srs.id !== 4326) db.run('INSERT OR IGNORE INTO gpkg_spatial_ref_sys VALUES (?, 4326, ?, 4326, ?, NULL)', [wgs84.name, 'EPSG', wgs84.wkt]);
    db.exec(`CREATE TABLE ${table} (fid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, geom ${geometryType}${columns.map((c) => `, ${quote(c.column)} ${c.type}`).join('')})`);
    db.run('INSERT INTO gpkg_contents (table_name, data_type, identifier, min_x, min_y, max_x, max_y, srs_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      name,
      'features',
      name,
      ...(Number.isFinite(extent[0]) ? extent : [null, null, null, null]),
      srs.id,
    ]);
    db.run('INSERT INTO gpkg_geometry_columns VALUES (?, ?, ?, ?, 0, 0)', [name, 'geom', geometryType, srs.id]);
    db.run(`INSERT INTO gpkg_extensions VALUES (?, 'geom', 'gpkg_rtree_index', 'http://www.geopackage.org/spec120/#extension_rtree', 'write-only')`, [name]);

    db.exec('BEGIN');
    const insert = `INSERT INTO ${table} (geom${columns.map((c) => `, ${quote(c.column)}`).join('')}) VALUES (?${', ?'.repeat(columns.length)})`;
    features.forEach((f, i) => {
      const g = geometries[i];
      db.run(insert, [g ? encodeGeometry(g, srs.id) : null, ...columns.map((c) => sqlValue(f.get(c.field.name), c.type))]);
    });
    db.exec('COMMIT');

    // The spatial index, filled once, and the triggers that keep it right when other programs edit the file.
    db.exec(`CREATE VIRTUAL TABLE ${rtree} USING rtree(id, minx, maxx, miny, maxy)`);
    db.exec(`INSERT INTO ${rtree} SELECT fid, ST_MinX(geom), ST_MaxX(geom), ST_MinY(geom), ST_MaxY(geom) FROM ${table} WHERE geom NOT NULL AND NOT ST_IsEmpty(geom)`);
    db.exec(rtreeTriggers(name));
    if (style) writeLayerStyle(db, name, style, symbolKindOf(geometryType) ?? commonKind(geometries), new Map(columns.map((c) => [c.field.name, c.column])));
    return db.export();
  } finally {
    db.close();
  }
}

/** The kind of symbol most of `geometries` need (polygons when there are none). */
function commonKind(geometries: Array<Geometry | null>): SymbolKind {
  const counts = new Map<SymbolKind, number>();
  for (const g of geometries) {
    const kind = symbolKindOf(g?.getType());
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'polygon';
}

/** The `layer_styles` table QGIS reads a GeoPackage layer's default style from, with `style` in it. */
function writeLayerStyle(db: Awaited<ReturnType<typeof openGeoPackageDb>>, table: string, style: VectorStyleSpec, kind: SymbolKind, rename: Map<string, string>): void {
  db.exec(`CREATE TABLE IF NOT EXISTS layer_styles (id INTEGER PRIMARY KEY AUTOINCREMENT, f_table_catalog TEXT(256), f_table_schema TEXT(256), f_table_name TEXT(256), f_geometry_column TEXT(256), styleName TEXT(30), styleQML TEXT, styleSLD TEXT, useAsDefault BOOLEAN, description TEXT, owner TEXT(30), ui TEXT(30), update_time DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
  db.run(`INSERT OR IGNORE INTO gpkg_contents (table_name, data_type, identifier) VALUES ('layer_styles', 'attributes', 'layer_styles')`);
  db.run(`INSERT INTO layer_styles (f_table_catalog, f_table_schema, f_table_name, f_geometry_column, styleName, styleQML, styleSLD, useAsDefault, description, owner) VALUES ('', '', ?, 'geom', ?, ?, '', 1, ?, '')`, [
    table,
    table,
    styleQml(style, kind, rename),
    'browser-image-viewer',
  ]);
}

/** The R-tree triggers of the GeoPackage spec (1.2) for a table's `geom` column, keyed by `fid`. */
function rtreeTriggers(name: string): string {
  const t = quote(name);
  const r = quote(`rtree_${name}_geom`);
  const n = (suffix: string) => quote(`rtree_${name}_geom_${suffix}`);
  const insert = `INSERT OR REPLACE INTO ${r} VALUES (NEW.fid, ST_MinX(NEW.geom), ST_MaxX(NEW.geom), ST_MinY(NEW.geom), ST_MaxY(NEW.geom))`;
  return `
    CREATE TRIGGER ${n('insert')} AFTER INSERT ON ${t} WHEN (new.geom NOT NULL AND NOT ST_IsEmpty(NEW.geom)) BEGIN ${insert}; END;
    CREATE TRIGGER ${n('update1')} AFTER UPDATE OF geom ON ${t} WHEN OLD.fid = NEW.fid AND (NEW.geom NOTNULL AND NOT ST_IsEmpty(NEW.geom)) BEGIN ${insert}; END;
    CREATE TRIGGER ${n('update2')} AFTER UPDATE OF geom ON ${t} WHEN OLD.fid = NEW.fid AND (NEW.geom ISNULL OR ST_IsEmpty(NEW.geom)) BEGIN DELETE FROM ${r} WHERE id = OLD.fid; END;
    CREATE TRIGGER ${n('update3')} AFTER UPDATE ON ${t} WHEN OLD.fid != NEW.fid AND (NEW.geom NOTNULL AND NOT ST_IsEmpty(NEW.geom)) BEGIN DELETE FROM ${r} WHERE id = OLD.fid; ${insert}; END;
    CREATE TRIGGER ${n('update4')} AFTER UPDATE ON ${t} WHEN OLD.fid != NEW.fid AND (NEW.geom ISNULL OR ST_IsEmpty(NEW.geom)) BEGIN DELETE FROM ${r} WHERE id IN (OLD.fid, NEW.fid); END;
    CREATE TRIGGER ${n('delete')} AFTER DELETE ON ${t} WHEN old.geom NOT NULL BEGIN DELETE FROM ${r} WHERE id = OLD.fid; END;`;
}
