/**
 * GeoPackage (an SQLite file, OGC 12-128): reading its feature tables as
 * vector layers. The database stays open in memory, so edits can be written
 * into it and the whole file saved with its other tables untouched.
 */
import Feature from 'ol/Feature.js';
import WKB from 'ol/format/WKB.js';
import type Geometry from 'ol/geom/Geometry.js';
import { get as getProjection } from 'ol/proj.js';
import { register } from 'ol/proj/proj4.js';
import proj4 from 'proj4';
import type { Field } from './services/index.js';
import { openDatabase, type Database, type SqlValue } from './sqlite.js';
import type { ProjectionLookup, VectorFile } from './vector-files.js';
import type { TargetCrs } from './vector-write.js';

/** One feature table of an open GeoPackage. */
export interface GeoPackageTable {
  db: Database;
  table: string;
  geometryColumn: string;
  /** The integer primary key (the feature id). */
  idColumn: string;
  srsId: number;
  /** Declared SQL type of each column, upper case (`TEXT(20)`, `DATETIME`…). */
  types: Map<string, string>;
}

/** `name` as an SQL identifier. */
export function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Opens a GeoPackage and reads every feature table in it. */
export async function readGeoPackage(bytes: Uint8Array, title: string, projectionOf?: ProjectionLookup): Promise<VectorFile[]> {
  let db: Database;
  try {
    db = await openGeoPackageDb(bytes);
  } catch {
    throw new Error(`${title} は GeoPackage として読めませんでした`);
  }
  try {
    db.query('SELECT 1 FROM gpkg_contents LIMIT 1');
  } catch {
    db.close();
    throw new Error(`${title} は GeoPackage として読めませんでした`);
  }
  const tables = rows(db, `SELECT c.table_name, c.identifier, g.column_name, g.geometry_type_name, g.srs_id
    FROM gpkg_contents c JOIN gpkg_geometry_columns g ON g.table_name = c.table_name
    WHERE c.data_type = 'features' ORDER BY c.table_name`);
  if (!tables.length) {
    db.close();
    throw new Error(`${title} には地物のテーブルがありません（タイルや属性だけの GeoPackage は開けません）`);
  }
  const out: VectorFile[] = [];
  for (const t of tables) {
    const table = String(t.table_name);
    const name = tables.length === 1 ? title : `${String(t.identifier || table)}（${title}）`;
    const srsId = Number(t.srs_id);
    const projection = await srsProjection(db, srsId, projectionOf);
    if (!projection) throw new Error(`${name} の座標系（srs_id ${srsId}）を読めませんでした`);
    const layer = readTable(db, { table, geometryColumn: String(t.column_name), srsId }, name, String(t.geometry_type_name), projection);
    out.push({ ...layer, writeCrs: srsCrs(db, srsId, projection) });
  }
  return out;
}

function readTable(db: Database, t: { table: string; geometryColumn: string; srsId: number }, title: string, geometryType: string, projection: string): VectorFile {
  const info = rows(db, `PRAGMA table_info(${quote(t.table)})`);
  const types = new Map(info.map((c) => [String(c.name), String(c.type).toUpperCase()]));
  const idColumn = String(info.find((c) => Number(c.pk) > 0)?.name ?? 'fid');
  const fields: Field[] = [];
  for (const c of info) {
    const name = String(c.name);
    if (name === t.geometryColumn) continue;
    const type = fieldType(types.get(name)!);
    // BLOBs stay in the features (and in the file) but not in the table.
    if (type === 'other') continue;
    const length = /^TEXT\s*\((\d+)\)/.exec(types.get(name)!)?.[1];
    fields.push({
      name,
      alias: name,
      type: name === idColumn ? 'oid' : type,
      editable: name !== idColumn,
      nullable: name !== idColumn && Number(c.notnull) === 0,
      ...(length ? { length: Number(length) } : {}),
    });
  }
  const dates = new Set(fields.filter((f) => f.type === 'date').map((f) => f.name));
  const features: Feature[] = [];
  for (const row of db.query(`SELECT * FROM ${quote(t.table)}`)) {
    const feature = new Feature();
    for (const [key, value] of Object.entries(row)) {
      if (key === t.geometryColumn) continue;
      feature.set(key, dates.has(key) && typeof value === 'string' ? dateValue(value) : value, true);
    }
    const blob = row[t.geometryColumn];
    const geometry = blob instanceof Uint8Array ? decodeGeometry(blob) : null;
    if (geometry) feature.setGeometry(geometry.transform(projection, 'EPSG:3857'));
    feature.setId(row[idColumn] as number);
    features.push(feature);
  }
  return {
    title,
    format: 'GeoPackage',
    features,
    fields,
    crs: srsName(db, t.srsId),
    projection,
    geometryType: olGeometryType(geometryType),
    gpkg: { db, ...t, idColumn, types },
  };
}

/** The table's field type for a declared SQL type. */
export function fieldType(declared: string): Field['type'] {
  const type = declared.toUpperCase();
  if (/^(INTEGER|INT|MEDIUMINT|SMALLINT|TINYINT|BOOLEAN)\b/.test(type)) return 'integer';
  if (/^(REAL|DOUBLE|FLOAT|NUMERIC)\b/.test(type)) return 'double';
  if (/^(DATE|DATETIME)\b/.test(type)) return 'date';
  if (/^BLOB\b/.test(type)) return 'other';
  return 'string';
}

/** A GeoPackage DATE (`2024-05-01`) or DATETIME as epoch milliseconds, like Esri dates; null when it is not a date. */
function dateValue(text: string): number | null {
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

/** The geometry type of a table, as OpenLayers names it; null for GEOMETRY (any) and collections. */
export function olGeometryType(name: string): VectorFile['geometryType'] {
  const types = { POINT: 'Point', LINESTRING: 'LineString', POLYGON: 'Polygon', MULTIPOINT: 'MultiPoint', MULTILINESTRING: 'MultiLineString', MULTIPOLYGON: 'MultiPolygon' } as const;
  return types[name.toUpperCase() as keyof typeof types] ?? null;
}

/** A CRS of the GeoPackage, to write features in. */
function srsCrs(db: Database, srsId: number, projection: string): TargetCrs {
  const [srs] = rows(db, 'SELECT organization, organization_coordsys_id, definition FROM gpkg_spatial_ref_sys WHERE srs_id = ?', [srsId]);
  const epsg = srs && String(srs.organization).toUpperCase() === 'EPSG' ? Number(srs.organization_coordsys_id) : null;
  const wkt = srs && srs.definition && srs.definition !== 'undefined' ? String(srs.definition) : null;
  return { projection, name: srsName(db, srsId), wkt, epsg };
}

/** The name the GeoPackage gives a CRS, with its code. */
function srsName(db: Database, srsId: number): string {
  const [srs] = rows(db, 'SELECT srs_name, organization, organization_coordsys_id FROM gpkg_spatial_ref_sys WHERE srs_id = ?', [srsId]);
  if (!srs) return `srs_id ${srsId}`;
  return `${String(srs.srs_name)}（${String(srs.organization)}:${String(srs.organization_coordsys_id)}）`;
}

/**
 * The OpenLayers projection code of a CRS of the GeoPackage: EPSG codes the
 * viewer knows, else the WKT definition the file carries, else a lookup of
 * the EPSG code in the registry. Null when none works.
 */
async function srsProjection(db: Database, srsId: number, projectionOf?: ProjectionLookup): Promise<string | null> {
  // 0: undefined geographic CRS (taken as WGS 84); -1: undefined Cartesian.
  if (srsId === 0) return 'EPSG:4326';
  const [srs] = rows(db, 'SELECT organization, organization_coordsys_id, definition FROM gpkg_spatial_ref_sys WHERE srs_id = ?', [srsId]);
  if (!srs) return null;
  const epsg = String(srs.organization).toUpperCase() === 'EPSG' ? `EPSG:${Number(srs.organization_coordsys_id)}` : null;
  if (epsg && getProjection(epsg)) return epsg;
  const definition = String(srs.definition ?? '');
  if (definition && definition !== 'undefined') {
    const code = epsg ?? `GPKG:${srsId}`;
    try {
      proj4.defs(code, definition);
      register(proj4);
      if (getProjection(code)) return code;
    } catch {
      // a WKT proj4 cannot read
    }
  }
  if (epsg && projectionOf) return (await projectionOf(epsg))?.getCode() ?? null;
  return null;
}

/** Rows of a query as objects. */
export function rows(db: Database, sql: string, params: SqlValue[] = []): Array<Record<string, SqlValue>> {
  return db.query(sql, params);
}

const wkb = new WKB({ hex: false, ewkb: false });

/** Envelope sizes in bytes by the header's envelope indicator. */
const envelopeBytes = [0, 32, 48, 48, 64];

/** A geometry from a GeoPackage geometry blob (header + WKB); null when empty. */
export function decodeGeometry(blob: Uint8Array): Geometry | null {
  if (blob[0] !== 0x47 || blob[1] !== 0x50) throw new Error('GeoPackage のジオメトリではありません');
  const flags = blob[3];
  if (flags & 0x10) return null;
  const envelope = envelopeBytes[(flags >> 1) & 7];
  if (envelope === undefined) throw new Error('GeoPackage のジオメトリの範囲が読めません');
  return wkb.readGeometry(blob.slice(8 + envelope)) as Geometry;
}

/** A GeoPackage geometry blob: little-endian header with the XY envelope, then ISO WKB. */
export function encodeGeometry(geometry: Geometry, srsId: number): Uint8Array {
  const body = new Uint8Array(wkb.writeGeometry(geometry) as ArrayBuffer);
  const [minX, minY, maxX, maxY] = geometry.getExtent();
  const empty = !Number.isFinite(minX);
  const header = new Uint8Array(empty ? 8 : 40);
  const view = new DataView(header.buffer);
  header.set([0x47, 0x50, 0, empty ? 0x11 : 0x03]);
  view.setInt32(4, srsId, true);
  if (!empty) [minX, maxX, minY, maxY].forEach((v, i) => view.setFloat64(8 + i * 8, v, true));
  const out = new Uint8Array(header.length + body.length);
  out.set(header);
  out.set(body, header.length);
  return out;
}

/** The XY envelope of a geometry blob, from its header or else its geometry; null when empty. */
function envelopeOf(blob: unknown): [minX: number, maxX: number, minY: number, maxY: number] | null {
  if (!(blob instanceof Uint8Array) || blob.length < 8) return null;
  const flags = blob[3];
  if (flags & 0x10) return null;
  if ((flags >> 1) & 7) {
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const little = (flags & 1) === 1;
    return [0, 1, 2, 3].map((i) => view.getFloat64(8 + i * 8, little)) as [number, number, number, number];
  }
  const e = decodeGeometry(blob)?.getExtent();
  return e && Number.isFinite(e[0]) ? [e[0], e[2], e[1], e[3]] : null;
}

/** Opens a GeoPackage (or a new, empty database) with the SQL functions its R-tree triggers call. */
export async function openGeoPackageDb(bytes?: Uint8Array): Promise<Database> {
  const db = await openDatabase(bytes);
  addSpatialFunctions(db);
  return db;
}

/**
 * The SQL functions the R-tree triggers of a GeoPackage call (GDAL and QGIS
 * write such triggers), so inserting and updating features keeps the
 * spatial index right.
 */
function addSpatialFunctions(db: Database): void {
  const at = (i: number) => (blob: SqlValue) => envelopeOf(blob)?.[i] ?? null;
  db.addFunction('ST_MinX', at(0));
  db.addFunction('ST_MaxX', at(1));
  db.addFunction('ST_MinY', at(2));
  db.addFunction('ST_MaxY', at(3));
  db.addFunction('ST_IsEmpty', (blob) => (blob instanceof Uint8Array ? (envelopeOf(blob) ? 0 : 1) : null));
}
