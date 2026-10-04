/**
 * Reading vector files: Shapefiles (a .zip, or the .shp with its .dbf, .prj
 * and .cpg chosen together), GeoJSON and GeoPackages, as OpenLayers features
 * in the map's projection with their attributes.
 */
import type Feature from 'ol/Feature.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import { iter } from 'but-unzip';
import { parseDbf, parseShp } from 'shpjs';
import type { Field } from './services/index.js';
import { fieldsOf } from './services/wms.js';
import { register } from 'ol/proj/proj4.js';
import proj4 from 'proj4';
import { readGeoPackage, type GeoPackageTable } from './geopackage.js';
import { epsgCode } from './services/common.js';
import { wgs84, type TargetCrs } from './vector-write.js';

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
  format: 'Shapefile' | 'GeoJSON' | 'GeoPackage';
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
}

/** The projection for a CRS name (it may load the definition), or null when unknown. */
export type ProjectionLookup = (crs: string) => Promise<{ getCode(): string } | null>;

/** What the viewer reads as vectors, by extension. */
export const vectorExtensions = ['.zip', '.shp', '.dbf', '.shx', '.prj', '.cpg', '.geojson', '.json', '.gpkg'];

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
 * Reads every Shapefile, GeoJSON and GeoPackage among `files` (a .zip is opened first).
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
    } else if (['.shp', '.shx', '.dbf', '.prj', '.cpg'].includes(ext)) {
      const key = f.name.slice(0, -ext.length);
      const entry = byStem.get(key) ?? { parts: {}, zip: f.zip };
      entry.parts[ext] = f;
      byStem.set(key, entry);
    }
  }
  for (const [key, { parts, zip }] of byStem) {
    if (!parts['.shp']) {
      if (parts['.dbf']) throw new Error(`${stem(key + '.x')}.shp がありません（.shp・.dbf・.prj を一緒に選んでください）`);
      continue;
    }
    const decode = (b?: NamedBytes) => (b ? new TextDecoder().decode(b.bytes) : undefined);
    const file = readShapefile(stem(key + '.x'), { shp: parts['.shp'].bytes, dbf: parts['.dbf']?.bytes, prj: decode(parts['.prj']), cpg: decode(parts['.cpg']) });
    out.push({ ...file, origin: { files: parts, zip } });
  }
  if (!out.length) throw new Error('Shapefile（.shp）・GeoJSON・GeoPackage のどれも見つかりませんでした');
  return out;
}

/**
 * The text encoding of a .dbf: its .cpg when there is one, else its language
 * driver byte (0x13 is Japanese), else UTF-8 when the records are valid
 * UTF-8 and Shift_JIS when they are not (Japanese data without a .cpg).
 */
export function dbfEncoding(dbf: Uint8Array, cpg?: string): string {
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
  if (dbf[29] === 0x13) return 'shift_jis';
  const headerLength = dbf[8] | (dbf[9] << 8);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(dbf.subarray(Math.min(headerLength, dbf.length)));
    return 'utf-8';
  } catch {
    return 'shift_jis';
  }
}

/** Reads one Shapefile; without a .prj, coordinates must be longitude / latitude. */
export function readShapefile(title: string, parts: { shp: Uint8Array; dbf?: Uint8Array; prj?: string; cpg?: string }): VectorFile {
  let geometries: Array<{ type: string } | null>;
  let crs = 'WGS 84（.prj なし）';
  if (parts.prj) {
    try {
      geometries = parseShp(parts.shp, parts.prj);
      crs = /^\s*\w+\["([^"]+)"/.exec(parts.prj)?.[1] ?? '.prj';
    } catch {
      throw new Error(`${title}.prj の座標系を読めませんでした`);
    }
  } else {
    geometries = parseShp(parts.shp);
  }
  const encoding = parts.dbf ? dbfEncoding(parts.dbf, parts.cpg) : undefined;
  const records = parts.dbf ? parseDbf(parts.dbf, encoding) : [];
  const dates = new Set<string>();
  const collection = {
    type: 'FeatureCollection',
    features: geometries.map((geometry, i) => {
      const properties: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(records[i] ?? {})) {
        // Dates as epoch milliseconds, like Esri's, for the table; empty dates are invalid Dates.
        if (v instanceof Date) {
          dates.add(k);
          properties[k] = Number.isNaN(v.getTime()) ? null : v.getTime();
        } else {
          properties[k] = typeof v === 'number' && Number.isNaN(v) ? null : v;
        }
      }
      return { type: 'Feature', geometry, properties };
    }),
  };
  const features = format.readFeatures(collection) as Feature[];
  if (!parts.prj && !inLonLat(features)) {
    throw new Error(`${title}.prj（座標系）がありません。.shp と一緒に .prj も選んでください`);
  }
  const fields = fieldsOf(features).map((f) => (dates.has(f.name) ? { ...f, type: 'date' as const } : f));
  const shapeType = new DataView(parts.shp.buffer, parts.shp.byteOffset, parts.shp.byteLength).getInt32(32, true) % 10;
  const geometryType = ({ 1: 'Point', 3: 'LineString', 5: 'Polygon', 8: 'MultiPoint' } as const)[shapeType as 1 | 3 | 5 | 8] ?? null;
  return { title, format: 'Shapefile', features: toWebMercator(features), fields, crs, encoding, geometryType, writeCrs: parts.prj ? prjCrs(parts.prj, crs) : wgs84 };
}

/** Reads GeoJSON: WGS 84 (RFC 7946), or the CRS named by an older `crs` member. */
export async function readGeoJson(text: string, title: string, projectionOf?: ProjectionLookup): Promise<VectorFile> {
  let json: { type?: string; crs?: { properties?: { name?: string } } };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${title} は JSON として読めませんでした`);
  }
  if (typeof json?.type !== 'string') throw new Error(`${title} は GeoJSON ではありません`);
  const named = json.crs?.properties?.name;
  let dataProjection = 'EPSG:4326';
  if (named && !/CRS:?84$|EPSG::?4326$/i.test(named)) {
    const projection = projectionOf ? await projectionOf(named) : null;
    if (!projection) throw new Error(`${title} の座標系 ${named} を読めませんでした`);
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

function toWebMercator(features: Feature[]): Feature[] {
  for (const f of features) f.getGeometry()?.transform('EPSG:4326', 'EPSG:3857');
  return features;
}

/** Whether every coordinate is a longitude / latitude. */
function inLonLat(features: Feature[]): boolean {
  return features.every((f) => {
    const e = f.getGeometry()?.getExtent();
    return !e || (e[0] >= -180 && e[2] <= 180 && e[1] >= -90 && e[3] <= 90);
  });
}
