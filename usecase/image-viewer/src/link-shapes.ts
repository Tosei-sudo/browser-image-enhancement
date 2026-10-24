/**
 * Shapes given in a link: points, lines and polygons written in the viewer's
 * address (or handed to the installed app through `web+imageviewer:` links),
 * shown as a temporary layer. A shape is a coordinate in any notation the
 * coordinate box reads (latitude/longitude, degrees-minutes-seconds, MGRS,
 * UTM), WKT (EWKT `SRID=3857;` too) or GeoJSON:
 *
 * - `?geom=35.6812,139.7671` a point; `geom=A;B;C` several points;
 *   `geom=POLYGON((139.7 35.6, …))` any WKT geometry (longitude first);
 * - `?line=A;B;C` a line, `?polygon=A;B;C` a polygon (closed for you), its
 *   vertices in any coordinate notation, `;` between them;
 * - `?geojson={…}` a GeoJSON geometry, Feature or FeatureCollection;
 * - `label=` (repeatable) labels the shapes: the n-th label goes to the n-th
 *   shape parameter; `name=` names the layer, `color=#rrggbb` colors it and
 *   `zoom=` is the zoom level a single point is shown at.
 *
 * Every value is read as data only and checked strictly (characters, size,
 * number of shapes and vertices, coordinate ranges); nothing in a link runs.
 */
import Feature from 'ol/Feature.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import WKT from 'ol/format/WKT.js';
import type Geometry from 'ol/geom/Geometry.js';
import LineString from 'ol/geom/LineString.js';
import MultiPoint from 'ol/geom/MultiPoint.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import SimpleGeometry from 'ol/geom/SimpleGeometry.js';
import GeometryCollection from 'ol/geom/GeometryCollection.js';
import { fromLonLat, toLonLat } from 'ol/proj.js';
import { parseCoordinate, type LonLat } from './coordinates.js';
import { field } from './processing/common.js';
import type { Field } from './services/index.js';

/** The link's parameters about shapes (the rest of the address is left to the viewer). */
export const SHAPE_KEYS = ['geom', 'line', 'polygon', 'geojson', 'label', 'name', 'color', 'zoom'] as const;
/** Parameters that make a shape. */
const SHAPE_PARAMS = new Set(['geom', 'line', 'polygon', 'geojson']);

/** The custom scheme of the installed app (the manifest's `protocol_handlers`). */
export const LINK_SCHEME = 'web+imageviewer';

/** Longest value of one parameter (characters). */
export const MAX_VALUE = 200_000;
/** Most shapes (features) one link makes. */
export const MAX_SHAPES = 1000;
/** Most vertices of all the shapes together. */
export const MAX_VERTICES = 100_000;
const MAX_LABEL = 200;
/** The zoom level points are shown at when the link gives none (about a town's streets). */
export const POINT_ZOOM = 14;
const MAX_NAME = 100;

/** What a link's shapes became. */
export interface LinkShapes {
  /** The layer's name. */
  title: string;
  /** Features in `EPSG:3857`. */
  features: Feature[];
  fields: Field[];
  /** Whether any shape has a label (the layer then shows them). */
  labeled: boolean;
  /** The layer's color (`#rrggbb`), or null for the next color of the viewer. */
  color: string | null;
  /** The zoom level a single point is shown at, or null for the default. */
  zoom: number | null;
  /** Values that could not be read, with why (in Japanese, for the status line). */
  errors: string[];
}

/** Whether `params` has any shape. */
export function hasShapes(params: URLSearchParams): boolean {
  for (const key of params.keys()) if (SHAPE_PARAMS.has(key)) return true;
  return false;
}

/**
 * The shape parameters of a `web+imageviewer:` link (as the browser hands it
 * to `?link=`): `web+imageviewer:geom=…&label=…`, `web+imageviewer:?geom=…`
 * or `web+imageviewer://show?geom=…`. Only the shape parameters are taken.
 */
export function paramsOfLink(link: string): URLSearchParams {
  const out = new URLSearchParams();
  const t = link.trim();
  if (t.length > MAX_VALUE * 2 || !t.toLowerCase().startsWith(`${LINK_SCHEME}:`)) return out;
  let rest = t.slice(LINK_SCHEME.length + 1);
  const q = rest.indexOf('?');
  if (q >= 0) rest = rest.slice(q + 1);
  else if (rest.startsWith('//')) return out;
  const hash = rest.indexOf('#');
  if (hash >= 0) rest = rest.slice(0, hash);
  for (const [key, value] of new URLSearchParams(rest)) if ((SHAPE_KEYS as readonly string[]).includes(key)) out.append(key, value);
  return out;
}

/** The shape parameters of the address: its own, and those of a `?link=web+imageviewer:…` from the installed app. */
export function shapeParamsOf(search: string): URLSearchParams {
  const params = new URLSearchParams(search);
  const out = new URLSearchParams();
  for (const [key, value] of params) {
    if ((SHAPE_KEYS as readonly string[]).includes(key)) out.append(key, value);
    else if (key === 'link') for (const [k, v] of paramsOfLink(value)) out.append(k, v);
  }
  return out;
}

/** The address without its shape parameters (they are made into a layer once; a reload restores the layer). */
export function withoutShapes(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of [...SHAPE_KEYS, 'link']) params.delete(key);
  const query = params.toString();
  return query ? `?${query}` : '';
}

class LinkError extends Error {}

const wkt = new WKT();
const geojson = new GeoJSON();
const WKT_START = /^\s*(?:SRID\s*=\s*\d+\s*;\s*)?(?:POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\b/i;
// Only what WKT is made of: keywords, numbers, parentheses, commas, `SRID=n;`.
const WKT_CHARS = /^[A-Za-z0-9\s().,;=+-]*$/;

/** Reads the shapes of a link. */
export function readLinkShapes(params: URLSearchParams): LinkShapes {
  const errors: string[] = [];
  const features: Feature[] = [];
  /** The features of each shape parameter, in order, for the labels. */
  const groups: Feature[][] = [];
  const labels: string[] = [];
  const extra = new Map<string, Field['type']>();
  let vertices = 0;
  let full = false;
  const take = (geometries: Geometry[], properties: Array<Record<string, unknown>> = []) => {
    const group: Feature[] = [];
    geometries.forEach((g, i) => {
      if (features.length >= MAX_SHAPES) {
        full = true;
        return;
      }
      vertices += countVertices(g);
      if (vertices > MAX_VERTICES) throw new LinkError(`頂点が多すぎ（全体で ${MAX_VERTICES.toLocaleString()} 点まで）`);
      const feature = new Feature({ geometry: g, ...properties[i] });
      group.push(feature);
      features.push(feature);
    });
    groups.push(group);
  };
  for (const [key, raw] of params) {
    if (key === 'label') {
      labels.push(clean(raw, MAX_LABEL));
      continue;
    }
    if (!SHAPE_PARAMS.has(key)) continue;
    const shown = raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
    try {
      if (raw.length > MAX_VALUE) throw new LinkError(`長すぎ（${MAX_VALUE.toLocaleString()} 文字まで）`);
      if (vertices > MAX_VERTICES) break;
      if (key === 'geojson') {
        const read = readGeoJson(raw, extra);
        take(read.geometries, read.properties);
      } else if (key === 'geom' && WKT_START.test(raw)) take(readWkt(raw));
      else {
        const points = coordinates(raw);
        if (key === 'geom') take([points.length === 1 ? new Point(points[0]) : new MultiPoint(points)]);
        else if (key === 'line') {
          if (points.length < 2) throw new LinkError('ラインには 2 点以上が必要');
          take([new LineString(points)]);
        } else {
          const ring = closed(points);
          if (ring.length < 4) throw new LinkError('ポリゴンには 3 点以上が必要');
          take([new Polygon([ring])]);
        }
      }
    } catch (error) {
      if (!(error instanceof LinkError)) throw error;
      errors.push(`${key}=${shown}: ${error.message}`);
      // A label still goes with the parameter it was written for.
      groups.push([]);
    }
    if (full) break;
  }
  if (full) errors.push(`図形が多すぎ（${MAX_SHAPES.toLocaleString()} 個まで表示）`);
  let labeled = false;
  groups.forEach((group, i) => {
    const label = labels[i];
    if (!label) return;
    labeled = true;
    for (const f of group) f.set('label', label);
  });
  // GeoJSON's own `label` or `name` labels its features too.
  for (const f of features) {
    if (f.get('label') === undefined && typeof f.get('name') === 'string') f.set('label', clean(f.get('name') as string, MAX_LABEL));
    if (f.get('label') !== undefined) labeled = true;
  }
  const fields = [field('label', 'string', 'ラベル'), ...[...extra].filter(([name]) => name !== 'label').map(([name, type]) => field(name, type))];
  const zoom = Number(params.get('zoom'));
  return {
    title: clean(params.get('name') ?? '', MAX_NAME) || 'リンクの図形',
    features,
    fields,
    labeled,
    color: colorOf(params.get('color')),
    zoom: params.get('zoom') !== null && Number.isFinite(zoom) && zoom >= 0 && zoom <= 22 ? zoom : null,
    errors,
  };
}

/** Text for a label or name: no control characters, at most `max` characters. */
function clean(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** `#rgb` or `#rrggbb` (with or without `#`) as `#rrggbb`, or null. */
function colorOf(text: string | null): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text?.trim() ?? '');
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return `#${hex.toLowerCase()}`;
}

/** Coordinates separated by `;` (or new lines), each in any notation, in `EPSG:3857`. */
function coordinates(text: string): number[][] {
  const parts = text.split(/[;\n]/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new LinkError('座標なし');
  if (parts.length > MAX_VERTICES) throw new LinkError(`頂点が多すぎ（${MAX_VERTICES.toLocaleString()} 点まで）`);
  return parts.map((p) => {
    if (p.length > 100) throw new LinkError(`座標として読み込み不可: ${p.slice(0, 40)}…`);
    const lonLat = parseCoordinate(p);
    if (!lonLat) throw new LinkError(`座標として読み込み不可: ${p}`);
    return fromLonLat(lonLat);
  });
}

/** The ring closed: the first point again at the end. */
function closed(points: number[][]): number[][] {
  const [first] = points;
  const last = points[points.length - 1];
  return first[0] === last[0] && first[1] === last[1] && points.length > 1 ? points : [...points, first];
}

/** WKT or EWKT in WGS 84 (`SRID=4326;`, or none) or Web Mercator (`SRID=3857;`). */
function readWkt(text: string): Geometry[] {
  if (!WKT_CHARS.test(text)) throw new LinkError('WKT に使用不可の文字あり');
  const m = /^\s*SRID\s*=\s*(\d+)\s*;\s*/i.exec(text);
  const srid = m ? Number(m[1]) : 4326;
  if (srid !== 4326 && srid !== 3857 && srid !== 900913) throw new LinkError(`SRID=${srid} には非対応（4326・3857）`);
  const body = m ? text.slice(m[0].length) : text;
  let geometry: Geometry;
  try {
    geometry = wkt.readGeometry(body, { dataProjection: srid === 4326 ? 'EPSG:4326' : 'EPSG:3857', featureProjection: 'EPSG:3857' });
  } catch {
    throw new LinkError('WKT として読み込み不可');
  }
  if (!geometry) throw new LinkError('WKT として読み込み不可');
  checkGeometry(geometry);
  return [geometry];
}

/** A GeoJSON geometry, Feature or FeatureCollection (WGS 84), with the features' plain properties. */
function readGeoJson(text: string, fields: Map<string, Field['type']>): { geometries: Geometry[]; properties: Array<Record<string, unknown>> } {
  let object: unknown;
  try {
    object = JSON.parse(text);
  } catch {
    throw new LinkError('GeoJSON（JSON）として読み込み不可');
  }
  const kinds = ['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon', 'GeometryCollection', 'Feature', 'FeatureCollection'];
  if (!object || typeof object !== 'object' || !kinds.includes((object as { type?: unknown }).type as string)) throw new LinkError('GeoJSON の type なし');
  let read: Feature[];
  try {
    read = geojson.readFeatures(object, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' });
  } catch {
    throw new LinkError('GeoJSON として読み込み不可');
  }
  const geometries: Geometry[] = [];
  const properties: Array<Record<string, unknown>> = [];
  for (const f of read) {
    const g = f.getGeometry();
    if (!g) continue;
    checkGeometry(g);
    const props: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(f.getProperties())) {
      if (name === 'geometry' || name.length > 64 || !/^[\p{L}\p{N}_ .-]+$/u.test(name)) continue;
      const type = typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'double') : typeof value === 'string' || typeof value === 'boolean' ? 'string' : null;
      if (!type || (typeof value === 'number' && !Number.isFinite(value))) continue;
      props[name] = typeof value === 'string' ? value.slice(0, 1000) : typeof value === 'boolean' ? String(value) : value;
      const before = fields.get(name);
      fields.set(name, before === undefined || before === type ? type : before === 'string' || type === 'string' ? 'string' : 'double');
    }
    geometries.push(g);
    properties.push(props);
  }
  if (!geometries.length) throw new LinkError('図形なし');
  return { geometries, properties };
}

/** Every coordinate a finite longitude and latitude on the earth. */
function checkGeometry(geometry: Geometry): void {
  const parts = geometry instanceof GeometryCollection ? geometry.getGeometriesArray() : [geometry];
  for (const part of parts) {
    if (part instanceof GeometryCollection) {
      checkGeometry(part);
      continue;
    }
    if (!(part instanceof SimpleGeometry)) throw new LinkError('非対応の図形');
    const flat = part.getFlatCoordinates();
    const stride = part.getStride();
    if (!flat.length) throw new LinkError('空の図形');
    for (let i = 0; i < flat.length; i += stride) {
      const [lon, lat] = toLonLat([flat[i], flat[i + 1]]) as LonLat;
      if (!Number.isFinite(flat[i]) || !Number.isFinite(flat[i + 1]) || Math.abs(lat) > 90 || Math.abs(flat[i]) > 20037508.35 * 1.0000001 || Math.abs(lon) > 180.0000001) {
        throw new LinkError('緯度経度の範囲外の座標あり（WKT・GeoJSON は経度・緯度の順）');
      }
    }
  }
}

function countVertices(geometry: Geometry): number {
  if (geometry instanceof GeometryCollection) return geometry.getGeometriesArray().reduce((n, g) => n + countVertices(g), 0);
  return geometry instanceof SimpleGeometry ? geometry.getFlatCoordinates().length / geometry.getStride() : 0;
}

/**
 * A link to the viewer at `base` showing `features` (in `EPSG:3857`) as WKT
 * in WGS 84 (7 decimals, about 1 cm), with their `label`s; null when the link
 * would be longer than browsers keep well (or there is nothing to show).
 */
export function linkOfShapes(base: string, features: Feature[], options: { name?: string; labelField?: string | null } = {}, maxLength = 32_000): string | null {
  const url = new URL(base);
  for (const key of [...SHAPE_KEYS, 'link']) url.searchParams.delete(key);
  url.hash = '';
  const params = new URLSearchParams();
  let shapes = 0;
  for (const f of features) {
    const g = f.getGeometry();
    if (!g) continue;
    params.append('geom', wkt.writeGeometry(g, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857', decimals: 7 }));
    const label = options.labelField ? f.get(options.labelField) : undefined;
    params.append('label', label === undefined || label === null ? '' : String(label));
    shapes++;
  }
  if (!shapes) return null;
  // Empty labels at the end say nothing.
  const entries = [...params];
  while (entries.length && entries[entries.length - 1][0] === 'label' && !entries[entries.length - 1][1]) entries.pop();
  const kept = new URLSearchParams(entries.filter(([k, v], i) => k !== 'label' || v || entries.slice(i + 1).some(([k2, v2]) => k2 === 'label' && v2)));
  if (options.name) kept.set('name', options.name);
  const query = [url.searchParams.toString(), kept.toString()].filter(Boolean).join('&');
  const link = `${url.origin}${url.pathname}?${query}`;
  return link.length <= maxLength ? link : null;
}
