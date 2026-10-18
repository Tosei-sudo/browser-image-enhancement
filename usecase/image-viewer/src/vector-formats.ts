/**
 * More vector formats, read and written: KML (Google Earth) and KMZ (KML in
 * a .zip), GPX (GPS logs: waypoints, routes and tracks) and FlatGeobuf. KML
 * and GPX are WGS 84 by definition; FlatGeobuf keeps the CRS it names.
 *
 * KML attributes are its `name`, `description` and `ExtendedData`; its
 * styles are not taken (the viewer's own style applies). GPX waypoints keep
 * their elevation and time as attributes; elevations along lines are
 * dropped, so every layer is flat x / y like the other formats.
 */
import Feature from 'ol/Feature.js';
import GPX from 'ol/format/GPX.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import KML from 'ol/format/KML.js';
import type Geometry from 'ol/geom/Geometry.js';
import { GeometryCollection, LineString, MultiLineString, MultiPoint, MultiPolygon, Point, Polygon } from 'ol/geom.js';
import { getTransform } from 'ol/proj.js';
import type SimpleGeometry from 'ol/geom/SimpleGeometry.js';
import { ColumnType, GeometryType, readFlatGeobuf, writeFlatGeobuf, type FgbColumn, type FgbGeometry, type FlatGeometry } from './flatgeobuf.js';
import type { Field } from './services/index.js';
import { fieldsOf } from './services/wms.js';
import { epsgCode } from './services/common.js';
import { wgs84, zipFiles, type TargetCrs } from './vector-write.js';
import type { NamedBytes, ProjectionLookup, VectorFile } from './vector-files.js';

const geojson = new GeoJSON();
const read3857 = { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' };

/** Properties KML readers add that are not the data's attributes. */
const KML_NOISE = ['styleUrl', 'visibility', 'open', 'address', 'phoneNumber'];

/** Drops z and m: every layer is x / y. */
function flatten(features: Feature[]): Feature[] {
  const xy = (c: unknown): unknown => (Array.isArray(c) && typeof c[0] === 'number' ? [c[0], c[1]] : Array.isArray(c) ? c.map(xy) : c);
  for (const f of features) {
    const g = f.getGeometry() as SimpleGeometry | undefined;
    if (!g || !('getLayout' in g) || g.getLayout() === 'XY') continue;
    const coordinates = (g as unknown as { getCoordinates(): unknown }).getCoordinates();
    (g as unknown as { setCoordinates(c: unknown, layout: string): void }).setCoordinates(xy(coordinates), 'XY');
  }
  return features;
}

/** KML's `<Data>` with a display name comes as an object: its value. */
function plainValues(features: Feature[]): Feature[] {
  for (const f of features) {
    for (const key of KML_NOISE) f.unset(key, true);
    for (const [k, v] of Object.entries(f.getProperties())) {
      if (k !== f.getGeometryName() && v && typeof v === 'object' && 'value' in (v as object) && !(v instanceof Uint8Array)) f.set(k, (v as { value: unknown }).value, true);
    }
  }
  return features;
}

/** Reads KML text (every Placemark, in folders or not). */
export function readKml(text: string, title: string): VectorFile {
  let features: Feature[];
  try {
    features = new KML({ extractStyles: false, showPointNames: false }).readFeatures(text, read3857) as Feature[];
  } catch {
    throw new Error(`${title} は KML として読めませんでした`);
  }
  features = flatten(plainValues(features));
  return { title, format: 'KML', features, fields: fieldsOf(features), crs: 'WGS 84', projection: 'EPSG:4326', writeCrs: wgs84 };
}

/** Reads the KML in a KMZ (doc.kml, else the first .kml). */
export function readKmz(entries: NamedBytes[], title: string): VectorFile {
  const kmls = entries.filter((e) => /\.kml$/i.test(e.name));
  const main = kmls.find((e) => /(^|\/)doc\.kml$/i.test(e.name)) ?? kmls[0];
  if (!main) throw new Error(`${title}.kmz に KML がありません`);
  return { ...readKml(new TextDecoder().decode(main.bytes), title), format: 'KMZ' };
}

/** Reads GPX: waypoints as points (with `ele` and `time`), routes and tracks as lines. */
export function readGpx(text: string, title: string): VectorFile {
  let features: Feature[];
  try {
    features = new GPX().readFeatures(text, read3857) as Feature[];
  } catch {
    throw new Error(`${title} は GPX として読めませんでした`);
  }
  for (const f of features) {
    const g = f.getGeometry();
    if (g instanceof Point) {
      const layout = g.getLayout();
      const c = g.getCoordinates();
      if (layout === 'XYZ' || layout === 'XYZM') f.set('ele', c[2], true);
      const m = layout === 'XYM' ? c[2] : layout === 'XYZM' ? c[3] : undefined;
      if (m) f.set('time', m * 1000, true);
    }
    // Links come as objects of their own.
    if (typeof f.get('link') === 'object') f.unset('link', true);
  }
  features = flatten(features);
  const fields = fieldsOf(features).map((field) => (field.name === 'time' ? { ...field, type: 'date' as const } : field));
  return { title, format: 'GPX', features, fields, crs: 'WGS 84', projection: 'EPSG:4326', writeCrs: wgs84 };
}

/** Reads FlatGeobuf, in the CRS its header names (WGS 84 without one). */
export async function readFgb(bytes: Uint8Array, title: string, projectionOf?: ProjectionLookup): Promise<VectorFile> {
  const file = readFlatGeobuf(bytes, olGeometryOf);
  const crs = file.crs;
  const name = crs?.code ? `${crs.org || 'EPSG'}:${crs.code}` : crs?.codeString || null;
  let dataProjection = 'EPSG:4326';
  if (name && !/EPSG:4326$|CRS:?84$/i.test(name)) {
    const projection = projectionOf ? await projectionOf(name) : null;
    if (!projection) throw new Error(`${title} の座標系 ${name} を読めませんでした`);
    dataProjection = projection.getCode();
  }
  const toMap = getTransform(dataProjection, 'EPSG:3857');
  const features = file.features.map(({ geometry, properties }) => {
    const feature = new Feature();
    // Moved to the map before it is the feature's: no change events to send.
    if (geometry) {
      geometry.applyTransform(toMap);
      feature.setGeometry(geometry);
    }
    feature.setProperties(properties, true);
    return feature;
  });
  const typeOf = (c: FgbColumn): Field['type'] =>
    c.type === ColumnType.String || c.type === ColumnType.Json || c.type === ColumnType.Binary
      ? 'string'
      : c.type === ColumnType.DateTime
        ? 'date'
        : c.type === ColumnType.Float || c.type === ColumnType.Double
          ? 'double'
          : c.type === ColumnType.Bool
            ? 'string'
            : 'integer';
  const fields: Field[] = file.columns.map((c) => ({ name: c.name, alias: c.name, type: typeOf(c), editable: false, nullable: true }));
  const geometryType = ({ 1: 'Point', 2: 'LineString', 3: 'Polygon', 4: 'MultiPoint', 5: 'MultiLineString', 6: 'MultiPolygon' } as const)[file.geometryType as 1] ?? null;
  const writeCrs: TargetCrs = name ? { projection: dataProjection, name, wkt: crs?.wkt ?? null, epsg: epsgCode(name) } : wgs84;
  return { title, format: 'FlatGeobuf', features, fields, crs: name ?? 'WGS 84', projection: dataProjection, geometryType, writeCrs };
}

/** An OpenLayers geometry straight from FlatGeobuf's flat coordinates (no array per point). */
function olGeometryOf(f: FlatGeometry): Geometry | null {
  const xy = Array.from(f.xy);
  const ends = f.ends?.length ? Array.from(f.ends, (n) => n * 2) : [xy.length];
  switch (f.type) {
    case GeometryType.Point:
      return xy.length >= 2 ? new Point(xy.slice(0, 2)) : null;
    case GeometryType.LineString:
      return new LineString(xy, 'XY');
    case GeometryType.MultiPoint:
      return new MultiPoint(xy, 'XY');
    case GeometryType.Polygon:
      return new Polygon(xy, 'XY', ends);
    case GeometryType.MultiLineString:
      return new MultiLineString(xy, 'XY', ends);
    case GeometryType.MultiPolygon: {
      const flat: number[] = [];
      const endss: number[][] = [];
      for (const p of f.parts) {
        const base = flat.length;
        for (let i = 0; i < p.xy.length; i++) flat.push(p.xy[i]);
        endss.push(p.ends?.length ? Array.from(p.ends, (n) => base + n * 2) : [flat.length]);
      }
      return new MultiPolygon(flat, 'XY', endss);
    }
    case GeometryType.GeometryCollection:
      return new GeometryCollection(f.parts.map(olGeometryOf).filter((g): g is Geometry => !!g));
    default:
      return null;
  }
}

/* ---------------------------------------------------------------- writing */

/** Copies of `features` with only `fields` (dates as ISO text), for the XML formats. */
function forXml(features: Feature[], fields: Field[]): Feature[] {
  const dates = new Set(fields.filter((f) => f.type === 'date').map((f) => f.name));
  const names = fields.filter((f) => f.type !== 'other').map((f) => f.name);
  return features.map((f) => {
    const copy = f.clone();
    for (const key of Object.keys(copy.getProperties())) if (key !== copy.getGeometryName() && !names.includes(key)) copy.unset(key, true);
    for (const name of names) {
      const v = f.get(name);
      if (v === null || v === undefined) copy.unset(name, true);
      else if (dates.has(name)) copy.set(name, new Date(typeof v === 'number' ? v : String(v)).toISOString(), true);
      else if (typeof v === 'object') copy.set(name, JSON.stringify(v), true);
    }
    return copy;
  });
}

/** KML text in WGS 84: `name` and `description` as KML's own, the rest as ExtendedData. */
export function writeKml(features: Feature[], fields: Field[]): string {
  const kml = new KML({ writeStyles: false });
  return kml.writeFeatures(forXml(features, fields), { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857', decimals: 8 });
}

/** A KMZ: the KML as doc.kml in a .zip. */
export function writeKmz(features: Feature[], fields: Field[]): Uint8Array<ArrayBuffer> {
  return zipFiles([{ name: 'doc.kml', bytes: new TextEncoder().encode(writeKml(features, fields)) }]);
}

/**
 * GPX text: points as waypoints (`name`, `desc`, `ele`, `time` from the
 * attributes of those names), lines as tracks. Polygons have no place in
 * GPX and are left out; `skipped` counts them.
 */
export function writeGpx(features: Feature[], fields: Field[]): { text: string; skipped: number } {
  let skipped = 0;
  const out: Feature[] = [];
  for (const f of forXml(features, fields)) {
    const g = f.getGeometry() as Geometry | undefined;
    const type = g?.getType();
    if (g instanceof Point) {
      const ele = Number(f.get('ele'));
      const time = Date.parse(String(f.get('time') ?? ''));
      const [x, y] = g.getCoordinates();
      if (Number.isFinite(ele) && !Number.isNaN(time)) f.setGeometry(new Point([x, y, ele, time / 1000], 'XYZM'));
      else if (Number.isFinite(ele)) f.setGeometry(new Point([x, y, ele], 'XYZ'));
      else if (!Number.isNaN(time)) f.setGeometry(new Point([x, y, time / 1000], 'XYM'));
      out.push(f);
    } else if (g instanceof LineString) {
      f.setGeometry(new MultiLineString([g.getCoordinates()]));
      out.push(f);
    } else if (type === 'MultiLineString') out.push(f);
    else if (type === 'MultiPoint') {
      for (const c of (g as unknown as { getCoordinates(): number[][] }).getCoordinates()) {
        const p = f.clone();
        p.setGeometry(new Point(c));
        out.push(p);
      }
    } else skipped++;
  }
  // GPX knows name, desc and a few more; other attributes cannot be written.
  for (const f of out) if (f.get('description') !== undefined && f.get('desc') === undefined) f.set('desc', f.get('description'), true);
  const text = new GPX().writeFeatures(out, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857', decimals: 8 });
  return { text, skipped };
}

/** The FlatGeobuf column type of a field. */
function columnType(field: Field): ColumnType {
  return field.type === 'double' ? ColumnType.Double : field.type === 'integer' || field.type === 'oid' ? ColumnType.Long : field.type === 'date' ? ColumnType.DateTime : ColumnType.String;
}

/** A FlatGeobuf file of `features` in `crs`. */
export function writeFgb(name: string, features: Feature[], fields: Field[], crs: TargetCrs = wgs84): Uint8Array<ArrayBuffer> {
  const columns: FgbColumn[] = fields.filter((f) => f.type !== 'other').map((f) => ({ name: f.name, type: columnType(f) }));
  const decimals = crs.projection === 'EPSG:4326' ? 9 : 4;
  return writeFlatGeobuf({
    name,
    columns,
    crs: crs.epsg ? { org: 'EPSG', code: crs.epsg, wkt: crs.wkt } : crs.wkt ? { wkt: crs.wkt } : null,
    features: features.map((f) => {
      const g = f.getGeometry();
      const geometry = g ? (geojson.writeGeometryObject(g.clone().transform('EPSG:3857', crs.projection), { decimals }) as unknown as FgbGeometry) : null;
      const properties: Record<string, unknown> = {};
      for (const c of columns) {
        const v = f.get(c.name);
        if (v !== undefined && !(v instanceof Uint8Array)) properties[c.name] = v;
      }
      return { geometry, properties };
    }),
  });
}
