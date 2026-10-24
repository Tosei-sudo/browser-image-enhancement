/**
 * Reading vector files: Shapefiles (a .zip, or the .shp with its .dbf, .prj
 * and .cpg chosen together), GeoJSON, GeoPackages, KML / KMZ, GPX and
 * FlatGeobuf (vector-formats.ts), as OpenLayers features in the map's
 * projection with their attributes.
 */
import Feature from 'ol/Feature.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import type Geometry from 'ol/geom/Geometry.js';
import { LineString, MultiLineString, MultiPoint, MultiPolygon, Point, Polygon } from 'ol/geom.js';
import { getTransform } from 'ol/proj.js';
import { iter } from 'but-unzip';
import type { Field } from './services/index.js';
import { fieldsOf } from './services/wms.js';
import { register } from 'ol/proj/proj4.js';
import proj4 from 'proj4';
import { readGeoPackage, type GeoPackageTable } from './geopackage.js';
import { epsgCode } from './services/common.js';
import { wgs84, type TargetCrs } from './vector-write.js';
import { dbfTextEncoding, groupRings, kindOfShapeType, parseShape, readDbfHeader, readDbfRecord, type DbfField, type Shape } from './shp-stream.js';
import { readFgb, readGpx, readKml, readKmz } from './vector-formats.js';
import { footprintOf, MULTIPATCH_SHAPE_TYPE, readMultiPatches, setMultiPatch, transformMultiPatch, type MultiPatch } from './multipatch.js';

/** A file by name, as bytes: chosen, dropped, or found in a .zip. */
export interface NamedBytes {
  name: string;
  bytes: Uint8Array;
  /** The handle it was read from (File System Access), so it can be written again. */
  handle?: FileSystemFileHandle;
}

/** Where a layer was read from, to save it again. */
export interface FileOrigin {
  /** The file (GeoJSON, GeoPackage), or for a Shapefile its parts by extension (`.shp`…) as chosen. */
  files: Record<string, NamedBytes>;
  /** A Shapefile in a .zip: the .zip and everything in it. */
  zip?: { file: NamedBytes; entries: NamedBytes[] };
}

/** One vector layer read from files. */
export interface VectorFile {
  /** File name without its extension. */
  title: string;
  format: 'Shapefile' | 'GeoJSON' | 'GeoPackage' | 'KML' | 'KMZ' | 'GPX' | 'FlatGeobuf';
  /** Features in `EPSG:3857`. */
  features: Feature[];
  fields: Field[];
  /** CRS the file is in, as read (`.prj` name, GeoJSON `crs`, or WGS 84). */
  crs: string;
  /** Shapefile: how the attributes' text was decoded. */
  encoding?: string;
  /** OpenLayers projection code of the file's coordinates, when it has one. */
  projection?: string;
  /** The one geometry type the file holds (Shapefile, GeoPackage table); null or absent when any. */
  geometryType?: 'Point' | 'LineString' | 'Polygon' | 'MultiPoint' | 'MultiLineString' | 'MultiPolygon' | null;
  /** GeoPackage: the open database and the table. */
  gpkg?: GeoPackageTable;
  /** The CRS to write the file again in: the one it was read in. */
  writeCrs?: TargetCrs;
  /** The files it was read from (set by {@link readVectorFiles}). */
  origin?: FileOrigin;
  /** The style that came with it, as QGIS keeps it (QML): a Shapefile's `.qml`, a GeoPackage's `layer_styles`. */
  styleQml?: string;
}

/** The projection for a CRS name (it may load the definition), or null when unknown. */
export type ProjectionLookup = (crs: string) => Promise<{ getCode(): string } | null>;

/** What the viewer reads as vectors, by extension. */
export const vectorExtensions = ['.zip', '.shp', '.dbf', '.shx', '.prj', '.cpg', '.qml', '.geojson', '.json', '.gpkg', '.kml', '.kmz', '.gpx', '.fgb'];

export function isVectorName(name: string): boolean {
  const lower = name.toLowerCase();
  return vectorExtensions.some((ext) => lower.endsWith(ext));
}

/** The file name without folders and its last extension. */
export function stem(name: string): string {
  const file = name.split(/[\\/]/).pop() ?? name;
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

/** The files in a .zip, skipping folders and macOS resource forks. */
export async function unzipFiles(zip: Uint8Array): Promise<NamedBytes[]> {
  const out: NamedBytes[] = [];
  for (const item of iter(zip)) {
    if (item.filename.endsWith('/') || item.filename.includes('__MACOSX')) continue;
    out.push({ name: item.filename, bytes: await item.read() });
  }
  return out;
}

/**
 * Reads every Shapefile, GeoJSON, GeoPackage, KML / KMZ, GPX and FlatGeobuf among `files` (a .zip is opened first).
 * Files of one Shapefile are matched by name: `roads.shp` with `roads.dbf`,
 * `roads.prj` and `roads.cpg`.
 */
export async function readVectorFiles(files: NamedBytes[], projectionOf?: ProjectionLookup): Promise<VectorFile[]> {
  const all: Array<NamedBytes & { zip?: FileOrigin['zip'] }> = [];
  for (const f of files) {
    if (extension(f.name) === '.zip') {
      const entries = await unzipFiles(f.bytes);
      all.push(...entries.map((e) => ({ ...e, zip: { file: f, entries } })));
    } else {
      all.push(f);
    }
  }
  const byStem = new Map<string, { parts: Record<string, NamedBytes>; zip?: FileOrigin['zip'] }>();
  const out: VectorFile[] = [];
  for (const f of all) {
    const ext = extension(f.name);
    const origin: FileOrigin = { files: { [ext]: f }, zip: f.zip };
    if (ext === '.geojson' || ext === '.json') {
      out.push({ ...(await readGeoJson(new TextDecoder().decode(f.bytes), stem(f.name), projectionOf)), origin });
    } else if (ext === '.gpkg') {
      out.push(...(await readGeoPackage(f.bytes, stem(f.name), projectionOf)).map((layer) => ({ ...layer, origin })));
    } else if (ext === '.kml') {
      out.push({ ...readKml(new TextDecoder().decode(f.bytes), stem(f.name)), origin });
    } else if (ext === '.kmz') {
      out.push({ ...readKmz(await unzipFiles(f.bytes), stem(f.name)), origin });
    } else if (ext === '.gpx') {
      out.push({ ...readGpx(new TextDecoder().decode(f.bytes), stem(f.name)), origin });
    } else if (ext === '.fgb') {
      out.push({ ...(await readFgb(f.bytes, stem(f.name), projectionOf)), origin });
    } else if (['.shp', '.shx', '.dbf', '.prj', '.cpg', '.qml'].includes(ext)) {
      const key = f.name.slice(0, -ext.length);
      const entry = byStem.get(key) ?? { parts: {}, zip: f.zip };
      entry.parts[ext] = f;
      byStem.set(key, entry);
    }
  }
  for (const [key, { parts, zip }] of byStem) {
    if (!parts['.shp']) {
      if (parts['.dbf']) throw new Error(`${stem(key + '.x')}.shp なし（.shp・.dbf・.prj を一緒に選択）`);
      continue;
    }
    const decode = (b?: NamedBytes) => (b ? new TextDecoder().decode(b.bytes) : undefined);
    const file = readShapefile(stem(key + '.x'), { shp: parts['.shp'].bytes, dbf: parts['.dbf']?.bytes, prj: decode(parts['.prj']), cpg: decode(parts['.cpg']) });
    const styleQml = decode(parts['.qml']);
    out.push({ ...file, origin: { files: parts, zip }, ...(styleQml ? { styleQml } : {}) });
  }
  if (!out.length) throw new Error('Shapefile（.shp）・GeoJSON・GeoPackage・KML・GPX・FlatGeobuf のどれも該当なし');
  return out;
}

/**
 * The text encoding of a .dbf: its .cpg when there is one, else its language
 * driver byte (0x13 is Japanese), else UTF-8 when the records are valid
 * UTF-8 and Shift_JIS when they are not (Japanese data without a .cpg).
 */
export function dbfEncoding(dbf: Uint8Array, cpg?: string): string {
  const headerLength = dbf[8] | (dbf[9] << 8);
  return dbfTextEncoding(dbf[29], dbf.subarray(Math.min(headerLength, dbf.length)), cpg);
}

/**
 * The geometries of a .shp's records, in its own coordinates (x / y: z and m
 * are left out, as in every other format). Read straight into flat
 * coordinates: no array per point, which made reading large files slow.
 */
export function readShpGeometries(shp: Uint8Array, title = ''): Array<Geometry | null> {
  const view = new DataView(shp.buffer, shp.byteOffset, shp.byteLength);
  if (shp.length < 100) throw new Error(`${title}.shp が短すぎ`);
  const fileType = view.getInt32(32, true);
  if (fileType !== 0 && kindOfShapeType(fileType) === 0) throw new Error(`${title}.shp の図形の種類（${fileType}）は読み込み不可`);
  const out: Array<Geometry | null> = [];
  for (let at = 100; at + 8 <= shp.length; ) {
    const length = view.getInt32(at + 4) * 2;
    // A record cut off by the end of the file: the file ends before it.
    if (length < 0 || at + 8 + length > shp.length) break;
    const shape = length >= 4 ? parseShape(new DataView(shp.buffer, shp.byteOffset + at + 8, length)) : null;
    at += 8 + length;
    out.push(shape ? geometryOfShape(shape) : null);
  }
  return out;
}

/** An OpenLayers geometry of a shape: one part as Point, LineString or Polygon, more as their Multi kinds. */
function geometryOfShape(shape: Shape): Geometry | null {
  const { kind, coords, ends } = shape;
  if (kind === 1) return coords.length === 2 ? new Point(Array.from(coords)) : new MultiPoint(Array.from(coords), 'XY');
  if (kind === 2) return ends.length === 1 ? new LineString(Array.from(coords), 'XY') : new MultiLineString(Array.from(coords), 'XY', ends);
  if (kind === 3) {
    const grouped = groupRings(coords, ends);
    const flat = Array.from(grouped.coords);
    if (grouped.polygons.length === 1) return new Polygon(flat, 'XY', grouped.ends);
    const endss: number[][] = [];
    let ring = 0;
    for (const count of grouped.polygons) {
      endss.push(grouped.ends.slice(ring, ring + count));
      ring += count;
    }
    return new MultiPolygon(flat, 'XY', endss);
  }
  return null;
}

/**
 * The fields of a .dbf and a reader of its records (by number from 0; null
 * past the end): numbers, booleans, dates as midnight UTC, text without its
 * padding, null for empty values.
 */
function readDbf(dbf: Uint8Array, encoding: string): { fields: DbfField[]; record(index: number): ReturnType<typeof readDbfRecord> | null } {
  const decoder = new TextDecoder(encoding);
  const header = readDbfHeader(dbf, (b) => decoder.decode(b));
  return {
    fields: header.fields,
    record: (index) => {
      const start = header.headerLength + index * header.recordLength;
      if (index >= header.count || start + header.recordLength > dbf.length) return null;
      return readDbfRecord(dbf.subarray(start, start + header.recordLength), header.fields, decoder);
    },
  };
}

/**
 * Whether a .prj's conversion to WGS 84 leaves the file's coordinates as
 * they are (WGS 84 itself, or JGD2011 and other datums that proj4 shifts by
 * nothing), tried at points over the box the .shp header gives. Skipping it
 * saves proj4's work at every point, most of the time of reading such files.
 */
function isIdentity(forward: (xy: number[]) => number[], shp: Uint8Array): boolean {
  const view = new DataView(shp.buffer, shp.byteOffset, shp.byteLength);
  const [x0, y0, x1, y1] = [36, 44, 52, 60].map((at) => view.getFloat64(at, true));
  if (![x0, y0, x1, y1].every(Number.isFinite) || x0 < -180 || x1 > 180 || y0 < -90 || y1 > 90) return false;
  for (const fx of [0, 0.5, 1]) {
    for (const fy of [0, 0.5, 1]) {
      const p = [x0 + (x1 - x0) * fx, y0 + (y1 - y0) * fy];
      const [x, y] = forward([p[0], p[1]]);
      if (Math.abs(x - p[0]) > 1e-12 || Math.abs(y - p[1]) > 1e-12) return false;
    }
  }
  return true;
}

/** Reads one Shapefile; without a .prj, coordinates must be longitude / latitude. */
export function readShapefile(title: string, parts: { shp: Uint8Array; dbf?: Uint8Array; prj?: string; cpg?: string }): VectorFile {
  let crs = 'WGS 84（.prj なし）';
  let toLonLat: ((xy: number[]) => number[]) | null = null;
  if (parts.prj) {
    try {
      toLonLat = proj4(parts.prj, 'EPSG:4326').forward;
      crs = /^\s*\w+\["([^"]+)"/.exec(parts.prj)?.[1] ?? '.prj';
    } catch {
      throw new Error(`${title}.prj の座標系の読み込みに失敗`);
    }
  }
  const rawType = new DataView(parts.shp.buffer, parts.shp.byteOffset, parts.shp.byteLength).getInt32(32, true);
  let geometries: Array<Geometry | null>;
  let patches: Array<MultiPatch | null> = [];
  if (rawType === MULTIPATCH_SHAPE_TYPE) {
    // 3D shapes: their footprints on the map, their triangles for the 3D view.
    patches = readMultiPatches(parts.shp).map((p) => p && transformMultiPatch(p, toLonLat ?? ((xy) => xy)));
    geometries = patches.map((p) => p && (format.readGeometry({ type: 'MultiPolygon', coordinates: footprintOf(p) }) as Geometry));
  } else {
    geometries = readShpGeometries(parts.shp, title);
    if (toLonLat && !isIdentity(toLonLat, parts.shp)) {
      const forward = toLonLat;
      for (const g of geometries) {
        g?.applyTransform((input, output = input, stride = 2) => {
          for (let i = 0; i + 1 < input.length; i += stride) {
            const [x, y] = forward([input[i], input[i + 1]]);
            output[i] = x;
            output[i + 1] = y;
          }
          return output;
        });
      }
    }
  }
  if (!parts.prj && !inLonLat(geometries)) {
    throw new Error(`${title}.prj（座標系）なし。.shp と一緒に .prj も選択`);
  }
  const encoding = parts.dbf ? dbfEncoding(parts.dbf, parts.cpg) : undefined;
  const table = parts.dbf ? readDbf(parts.dbf, encoding!) : null;
  const dates = new Set(table?.fields.filter((f) => f.type === 'D').map((f) => f.name));
  const toMap = getTransform('EPSG:4326', 'EPSG:3857');
  const features = geometries.map((geometry, i) => {
    const properties: Record<string, unknown> = {};
    const record = table?.record(i);
    // Dates as epoch milliseconds (midnight UTC, whatever the time zone), like Esri's and GeoPackage's;
    // empty values are null, but text, which a .dbf cannot leave null, is empty text.
    if (record) table!.fields.forEach((f, k) => (properties[f.name] = record[k] ?? (f.type === 'C' ? '' : null)));
    const feature = new Feature();
    // Moved to the map before it is the feature's: no change events to send.
    if (geometry) {
      geometry.applyTransform(toMap);
      feature.setGeometry(geometry);
    }
    feature.setProperties(properties, true);
    return feature;
  });
  patches.forEach((p, i) => p && features[i] && setMultiPatch(features[i], p));
  const fields = fieldsOf(features).map((f) => (dates.has(f.name) ? { ...f, type: 'date' as const } : f));
  const shapeType = rawType % 10;
  // A multipatch is written back as its footprint.
  const geometryType = rawType === MULTIPATCH_SHAPE_TYPE ? 'Polygon' : (({ 1: 'Point', 3: 'LineString', 5: 'Polygon', 8: 'MultiPoint' } as const)[shapeType as 1 | 3 | 5 | 8] ?? null);
  return { title, format: 'Shapefile', features, fields, crs, encoding, geometryType, writeCrs: parts.prj ? prjCrs(parts.prj, crs) : wgs84 };
}

/** Reads GeoJSON: WGS 84 (RFC 7946), or the CRS named by an older `crs` member. */
export async function readGeoJson(text: string, title: string, projectionOf?: ProjectionLookup): Promise<VectorFile> {
  let json: { type?: string; crs?: { properties?: { name?: string } } };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${title} は JSON として読み込み失敗`);
  }
  if (typeof json?.type !== 'string') throw new Error(`${title} は GeoJSON 以外`);
  const named = json.crs?.properties?.name;
  let dataProjection = 'EPSG:4326';
  if (named && !/CRS:?84$|EPSG::?4326$/i.test(named)) {
    const projection = projectionOf ? await projectionOf(named) : null;
    if (!projection) throw new Error(`${title} の座標系 ${named} の読み込みに失敗`);
    dataProjection = projection.getCode();
  }
  const features = format.readFeatures(json, { dataProjection, featureProjection: 'EPSG:3857' }) as Feature[];
  const writeCrs = named ? { projection: dataProjection, name: named, wkt: null, epsg: epsgCode(named) } : wgs84;
  return { title, format: 'GeoJSON', features, fields: fieldsOf(features), crs: named ?? 'WGS 84', projection: dataProjection, writeCrs };
}

let prjCount = 0;

/** The CRS of a .prj, registered with OpenLayers so features can be written back in it. */
function prjCrs(prj: string, name: string): TargetCrs {
  const projection = `PRJ:${++prjCount}`;
  try {
    proj4.defs(projection, prj);
    register(proj4);
  } catch {
    return wgs84;
  }
  return { projection, name, wkt: prj, epsg: null };
}

const format = new GeoJSON();

/** Whether every coordinate is a longitude / latitude. */
function inLonLat(geometries: Array<Geometry | null>): boolean {
  return geometries.every((g) => {
    const e = g?.getExtent();
    return !e || (e[0] >= -180 && e[2] <= 180 && e[1] >= -90 && e[3] <= 90);
  });
}
