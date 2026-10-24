/**
 * What was pasted (Ctrl+V on the map, 「クリップボードから貼り付け」, or text
 * shared to the installed app), recognised as shapes, and what the selected
 * features are copied as (GeoJSON and WKT in WGS 84). Only reading and
 * writing text here; clipboard.ts does the clipboard and the layer.
 *
 * Pasted text is read, in this order, as:
 * - a link to the viewer with shapes (`?geom=`…) or a `web+imageviewer:` link;
 * - any other http(s) URL: offered to open as a COG (never opened unasked);
 * - GeoJSON (a geometry, Feature or FeatureCollection);
 * - KML (a whole file or only Placemarks);
 * - WKT / EWKT, one geometry per line (or one over several lines);
 * - coordinates, one point per line (or `;`), in any notation the coordinate
 *   box reads (latitude/longitude, degrees-minutes-seconds, MGRS, UTM);
 * - a table (tab-separated from Excel, or CSV) with a header: latitude and
 *   longitude columns, X and Y columns (their CRS is asked), or a WKT column.
 *
 * The same limits as shapes in a link apply (characters, shapes, vertices);
 * every value is data only.
 */
import Feature from 'ol/Feature.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import WKT from 'ol/format/WKT.js';
import type Geometry from 'ol/geom/Geometry.js';
import GeometryCollection from 'ol/geom/GeometryCollection.js';
import SimpleGeometry from 'ol/geom/SimpleGeometry.js';
import { parseCoordinate } from './coordinates.js';
import { delimiterOf, parseCsv, readCsv, type CsvTable } from './csv.js';
import { LINK_SCHEME, MAX_SHAPES, MAX_VALUE, MAX_VERTICES, hasShapes, paramsOfLink, readLinkShapes, shapeParamsOf } from './link-shapes.js';
import { attributesOf, copyFields } from './processing/common.js';
import { xyToPoints } from './processing/xy-to-points.js';
import type { Field } from './services/index.js';
import { readKml } from './vector-formats.js';
import { wgs84, type TargetCrs } from './vector-write.js';

/** The name of the temporary layer pasted shapes go to. */
export const PASTE_TITLE = '貼り付け';

/** Shapes recognised in what was pasted. */
export interface PastedShapes {
  kind: 'shapes';
  /** What they were read as (`GeoJSON`, `WKT`, `座標`…), for the message. */
  what: string;
  /** Features in `EPSG:3857`. */
  features: Feature[];
  fields: Field[];
  /** Whether any feature has a `label` (the layer then shows them). */
  labeled: boolean;
  /** A color (`#rrggbb`) and point zoom a viewer link gave, else null. */
  color: string | null;
  zoom: number | null;
  /** What could not be read, with why (in Japanese). */
  errors: string[];
}

/** A table with coordinate columns: made into points once its CRS is known. */
export interface PastedTable {
  kind: 'table';
  table: CsvTable;
  /** The columns of X (longitude, easting) and Y (latitude, northing). */
  x: string;
  y: string;
  /** Whether the columns are named latitude / longitude (WGS 84, nothing to ask). */
  geographic: boolean;
  /** The CRS to suggest when asking: WGS 84 when every value is a longitude / latitude, else none. */
  suggested: string | null;
}

/** A URL that is not a link with shapes: it may be opened (as a COG) only when the person says so. */
export interface PastedUrl {
  kind: 'url';
  url: string;
}

export interface PastedNothing {
  kind: 'none';
  /** Why, in Japanese. */
  message: string;
}

export type Pasted = PastedShapes | PastedTable | PastedUrl | PastedNothing;

const WKT_START = /^\s*(?:SRID\s*=\s*\d+\s*;\s*)?(?:POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\b/i;
const GEOJSON_TYPES = ['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon', 'GeometryCollection', 'Feature', 'FeatureCollection'];

/** Column names, lower case without spaces, `_` or `-`. */
const LAT_NAMES = ['lat', 'latitude', '緯度', 'latdd', 'latdeg', 'ido', 'y緯度', '緯度10進'];
const LON_NAMES = ['lon', 'lng', 'long', 'longitude', '経度', 'londd', 'londeg', 'keido', 'x経度', '経度10進'];
const X_NAMES = ['x', 'east', 'easting', 'x座標', 'xcoord', 'pointx', '東西'];
const Y_NAMES = ['y', 'north', 'northing', 'y座標', 'ycoord', 'pointy', '南北'];
const WKT_NAMES = ['wkt', 'geometry', 'geometry_', 'geom', 'thegeom', 'shape', 'ジオメトリ', '形状'];

const nameKey = (name: string) => name.trim().toLowerCase().replace(/[\s_-]+/g, '');

/** Reads pasted (or shared) text. */
export function readPastedText(raw: string): Pasted {
  const text = raw.replace(/^\uFEFF/, '').trim();
  if (!text) return { kind: 'none', message: 'クリップボードが空' };
  if (text.length > MAX_VALUE) return { kind: 'none', message: `貼り付けた文字が長すぎ（${MAX_VALUE.toLocaleString()} 文字まで。大きなデータはファイルとして開く）` };

  // A link: the viewer's own with shapes, the installed app's, or any other URL (asked first).
  if (/^\S+$/.test(text)) {
    if (text.toLowerCase().startsWith(`${LINK_SCHEME}:`)) {
      const params = paramsOfLink(text);
      return hasShapes(params) ? shapesOf(params, 'リンクの図形') : { kind: 'none', message: 'リンクに図形なし' };
    }
    if (/^https?:\/\//i.test(text)) {
      let url: URL;
      try {
        url = new URL(text);
      } catch {
        return { kind: 'none', message: 'URL として読み込み不可' };
      }
      const params = shapeParamsOf(url.search);
      if (hasShapes(params)) return shapesOf(params, 'リンクの図形');
      return { kind: 'url', url: url.href };
    }
  }

  if (text.startsWith('{')) {
    let type: unknown;
    try {
      type = (JSON.parse(text) as { type?: unknown })?.type;
    } catch {
      return { kind: 'none', message: 'JSON として読み込み不可' };
    }
    if (typeof type !== 'string' || !GEOJSON_TYPES.includes(type)) return { kind: 'none', message: 'GeoJSON 以外の JSON' };
    return shapesOf(new URLSearchParams([['geojson', text]]), 'GeoJSON');
  }

  if (/<(?:kml|Placemark|Document|Folder)\b/i.test(text)) return kmlOf(text);

  if (WKT_START.test(text)) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // One per line; otherwise one geometry written over several lines.
    const each = lines.every((l) => WKT_START.test(l)) ? lines : [lines.join(' ')];
    return shapesOf(new URLSearchParams(each.map((w) => ['geom', w])), 'WKT');
  }

  const lines = text.split(/\r?\n|;/).map((l) => l.trim()).filter(Boolean);
  if (lines.length <= MAX_VERTICES && lines.every((l) => l.length <= 100 && parseCoordinate(l))) {
    return shapesOf(new URLSearchParams(lines.map((l) => ['geom', l])), '座標');
  }

  return tableOf(text);
}

/** Shapes from link parameters, read with the link's limits and checks. */
function shapesOf(params: URLSearchParams, what: string): Pasted {
  const read = readLinkShapes(params);
  if (!read.features.length) return { kind: 'none', message: `${what}として読み込み失敗${read.errors.length ? `（${read.errors.slice(0, 3).join(' / ')}）` : ''}` };
  return { kind: 'shapes', what, features: read.features, fields: read.fields, labeled: read.labeled, color: read.color, zoom: read.zoom, errors: read.errors };
}

/** KML: a whole document, or Placemarks copied out of one (wrapped into a document). */
function kmlOf(text: string): Pasted {
  const whole = /<kml\b/i.test(text) ? text.replace(/^\s*<\?xml[^>]*>/i, '') : `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>${text}</Document></kml>`;
  let features: Feature[];
  let fields: Field[];
  try {
    ({ features, fields } = readKml(whole, PASTE_TITLE));
  } catch {
    return { kind: 'none', message: 'KML として読み込み失敗' };
  }
  features = features.filter((f) => f.getGeometry());
  if (!features.length) return { kind: 'none', message: 'KML に図形なし' };
  const errors: string[] = [];
  if (features.length > MAX_SHAPES) {
    features = features.slice(0, MAX_SHAPES);
    errors.push(`図形が多すぎ（${MAX_SHAPES.toLocaleString()} 個まで表示）`);
  }
  if (features.reduce((n, f) => n + countVertices(f.getGeometry()!), 0) > MAX_VERTICES) return { kind: 'none', message: `頂点が多すぎ（全体で ${MAX_VERTICES.toLocaleString()} 点まで）` };
  const labeled = features.some((f) => typeof f.get('name') === 'string');
  for (const f of features) if (typeof f.get('name') === 'string') f.set('label', f.get('name'));
  return { kind: 'shapes', what: 'KML', features, fields: labeled ? [{ name: 'label', alias: 'ラベル', type: 'string', editable: true, nullable: true }, ...fields] : fields, labeled, color: null, zoom: null, errors };
}

/** A table with a header line and coordinate (or WKT) columns. */
function tableOf(text: string): Pasted {
  const nothing: PastedNothing = { kind: 'none', message: '図形として読める内容なし（GeoJSON・WKT・KML・座標・緯度経度の列がある表に対応）' };
  if (!/[\t,;]/.test(text.split(/\r?\n/, 1)[0])) return nothing;
  const rows = parseCsv(text, delimiterOf(text));
  if (rows.length < 2 || rows[0].length < 2) return nothing;
  const table = readCsv(new TextEncoder().encode(text), PASTE_TITLE);
  const names = table.fields.map((f) => f.name);
  const find = (list: string[]) => names.find((n) => list.includes(nameKey(n)));

  const wktColumn = find(WKT_NAMES) ?? names.find((n) => table.features.slice(0, 5).every((f) => typeof f.get(n) === 'string' && WKT_START.test(f.get(n) as string)));
  if (wktColumn && table.features.some((f) => typeof f.get(wktColumn) === 'string' && WKT_START.test(f.get(wktColumn) as string))) return wktTable(table, wktColumn);

  const lat = find(LAT_NAMES);
  const lon = find(LON_NAMES);
  if (lat && lon) return { kind: 'table', table, x: lon, y: lat, geographic: true, suggested: wgs84.projection };
  const x = find(X_NAMES);
  const y = find(Y_NAMES);
  if (x && y) {
    const values = table.features.flatMap((f) => [Number(f.get(x)), Number(f.get(y))]);
    const degrees = table.features.every((f) => Math.abs(Number(f.get(x))) <= 180 && Math.abs(Number(f.get(y))) <= 90) && values.every(Number.isFinite);
    return { kind: 'table', table, x, y, geographic: false, suggested: degrees ? wgs84.projection : null };
  }
  return nothing;
}

/** The rows of a table with a WKT column as features with the other columns as attributes. */
function wktTable(table: CsvTable, column: string): Pasted {
  const features: Feature[] = [];
  const errors: string[] = [];
  let vertices = 0;
  let bad = 0;
  for (const row of table.features) {
    if (features.length >= MAX_SHAPES) {
      errors.push(`行が多すぎ（先頭 ${MAX_SHAPES.toLocaleString()} 行を表示）`);
      break;
    }
    const value = row.get(column);
    const read = typeof value === 'string' ? readLinkShapes(new URLSearchParams([['geom', value]])) : null;
    const geometry = read?.features[0]?.getGeometry();
    if (!geometry) {
      bad++;
      continue;
    }
    vertices += countVertices(geometry);
    if (vertices > MAX_VERTICES) return { kind: 'none', message: `頂点が多すぎ（全体で ${MAX_VERTICES.toLocaleString()} 点まで）` };
    const attributes = attributesOf(row);
    delete attributes[column];
    features.push(new Feature({ ...attributes, geometry }));
  }
  if (bad) errors.push(`WKT として読めない行 ${bad.toLocaleString()} 件をスキップ`);
  if (!features.length) return { kind: 'none', message: `表の「${column}」列を WKT として読み込み失敗` };
  const fields = copyFields(table.fields.filter((f) => f.name !== column));
  return { kind: 'shapes', what: `表（WKT 列「${column}」）`, features, fields, labeled: false, color: null, zoom: null, errors };
}

/** Points from a pasted table's coordinate columns, in `crs` (WGS 84 for latitude / longitude columns). */
export function tableShapes(pasted: PastedTable, crs: TargetCrs = wgs84, x = pasted.x, y = pasted.y): PastedShapes | PastedNothing {
  const rows = pasted.table.features;
  const errors: string[] = [];
  const kept = rows.slice(0, MAX_SHAPES);
  if (rows.length > MAX_SHAPES) errors.push(`行が多すぎ（先頭 ${MAX_SHAPES.toLocaleString()} 行を表示）`);
  const result = xyToPoints({ title: PASTE_TITLE, features: kept, fields: pasted.table.fields }, { xField: x, yField: y, crs });
  errors.push(...(result.notes ?? []).slice(1));
  if (!result.features.length) return { kind: 'none', message: `表の「${x}」「${y}」列から点の作成に失敗${errors.length ? `（${errors.join(' / ')}）` : ''}` };
  const what = pasted.geographic ? `表（緯度「${y}」・経度「${x}」）` : `表（X「${x}」・Y「${y}」、${crs.name}）`;
  return { kind: 'shapes', what, features: result.features, fields: result.fields, labeled: false, color: null, zoom: null, errors };
}

function countVertices(geometry: Geometry): number {
  if (geometry instanceof GeometryCollection) return geometry.getGeometriesArray().reduce((n, g) => n + countVertices(g), 0);
  return geometry instanceof SimpleGeometry ? geometry.getFlatCoordinates().length / geometry.getStride() : 0;
}

// ---------------------------------------------------------------- copy

/** Most features copied at once. */
export const MAX_COPY_FEATURES = 100_000;
/** Longest text copied (characters). */
export const MAX_COPY_CHARS = 20_000_000;

const geojson = new GeoJSON();
const wkt = new WKT();
const toWgs84 = { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857', decimals: 7 } as const;

/** A plain JSON value of an attribute (dates as ISO 8601 text), or undefined for what has none. */
function plain(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return undefined;
}

/**
 * The features (in `EPSG:3857`) as a GeoJSON FeatureCollection in WGS 84
 * (7 decimals, about 1 cm), with their attributes (`fields`' in order when
 * given); an error message when there are too many.
 */
export function featuresToGeoJson(features: Feature[], fields?: readonly Field[]): { text: string } | { error: string } {
  if (features.length > MAX_COPY_FEATURES) return { error: `地物が多すぎ（${MAX_COPY_FEATURES.toLocaleString()} 件まで。ファイルへの書き出しが必要）` };
  const out = {
    type: 'FeatureCollection',
    features: features.map((f) => {
      const properties: Record<string, unknown> = {};
      const names = fields ? fields.map((d) => d.name) : Object.keys(attributesOf(f));
      for (const name of names) {
        if (name === f.getGeometryName()) continue;
        const value = plain(f.get(name));
        if (value !== undefined) properties[name] = value;
      }
      const g = f.getGeometry();
      return { type: 'Feature', properties, geometry: g ? geojson.writeGeometryObject(g, toWgs84) : null };
    }),
  };
  const text = JSON.stringify(out);
  return text.length > MAX_COPY_CHARS ? { error: '図形が大きすぎてコピー不可（ファイルへの書き出しが必要）' } : { text };
}

/** The features' geometries as WKT in WGS 84 (7 decimals), one per line; an error message when too many or none. */
export function featuresToWkt(features: Feature[]): { text: string; count: number } | { error: string } {
  if (features.length > MAX_COPY_FEATURES) return { error: `地物が多すぎ（${MAX_COPY_FEATURES.toLocaleString()} 件まで。ファイルへの書き出しが必要）` };
  const lines: string[] = [];
  let length = 0;
  for (const f of features) {
    const g = f.getGeometry();
    if (!g) continue;
    const line = wkt.writeGeometry(g, toWgs84);
    length += line.length + 1;
    if (length > MAX_COPY_CHARS) return { error: '図形が大きすぎてコピー不可（ファイルへの書き出しが必要）' };
    lines.push(line);
  }
  if (!lines.length) return { error: '図形のある地物なし' };
  return { text: lines.join('\n'), count: lines.length };
}
