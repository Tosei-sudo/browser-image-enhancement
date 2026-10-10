/**
 * Image catalogs: Esri feature layers whose features are images (a footprint
 * polygon and attributes such as the image id, when it was taken, the sensor
 * and the angle, and where the image is). The layout of the service is not
 * known in advance, so `config.json` maps its attribute names to the roles
 * the viewer knows ({@link CatalogFields}); this module reads that mapping,
 * builds the queries and turns features into {@link CatalogRecord}s. The
 * search panel is catalog-panel.ts.
 */
import type Feature from 'ol/Feature.js';
import EsriJSON from 'ol/format/EsriJSON.js';
import type { Extent } from 'ol/extent.js';
import { transformExtent, type ProjectionLike } from 'ol/proj.js';
import { esriJson } from './services/esri.js';

/** Attribute names of the catalog layer, by role. Only `source` is required. */
export interface CatalogFields {
  /** The image's id, shown in the list and the layer's information. */
  id?: string;
  /** When the image was taken (a date field, or text such as `2026-10-01T01:23:45Z`). */
  acquired?: string;
  /** When the image was added to the catalog. */
  registered?: string;
  /** The sensor (or satellite) name; the search offers its values to choose from. */
  sensor?: string;
  /** An angle in degrees (off-nadir, incidence…); the search can set an upper limit. */
  angle?: string;
  /**
   * Where the image is: a COG's URL or a local path, told apart by the value.
   * Several fields are tried in order and the first with a value is used,
   * for catalogs that keep URLs and paths in fields of their own.
   */
  source: string[];
}

/** Another attribute shown as a column of the result list. */
export interface CatalogColumn {
  field: string;
  label: string;
}

/** One catalog from `config.json`'s `imageCatalogs`. */
export interface CatalogConfig {
  /** Name in the catalog panel. */
  label: string;
  /** The feature layer (`…/FeatureServer/0` or `…/MapServer/0`). */
  url: string;
  /** An ArcGIS token sent with every request (as a POST, so it stays out of URLs). */
  token?: string;
  fields: CatalogFields;
  /** Headings of the roles in the list (`{ "angle": "オフナディア角" }`); the defaults are in {@link roleLabels}. */
  labels: Partial<Record<Exclude<keyof CatalogFields, 'source'>, string>>;
  columns: CatalogColumn[];
  /** A condition every search adds (SQL, such as `STATUS = 'PUBLISHED'`). */
  where?: string;
  /** The most features one search lists. */
  maxResults: number;
}

/** Default headings of the roles. */
export const roleLabels = { id: '画像ID', acquired: '撮像日時', registered: '登録日時', sensor: 'センサー', angle: '角度' } as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isName = (value: unknown): value is string => typeof value === 'string' && /^[\w.]+$/.test(value);
const isUrl = (url: unknown): url is string => typeof url === 'string' && /^(https?:)?\/\/|^\.{0,2}\//.test(url);

/** The catalog of one `imageCatalogs` entry; null (with the reason in `problems`) when it cannot be used. */
export function catalogOf(value: unknown, problems: string[], index: number): CatalogConfig | null {
  const at = `imageCatalogs[${index}]`;
  if (!isRecord(value)) return (problems.push(`${at} がオブジェクトではありません`), null);
  const { label, url, token, fields, labels, columns, where, maxResults } = value;
  if (!isUrl(url) || !/\/(FeatureServer|MapServer)\/\d+\/?$/i.test(url.split('?', 1)[0])) {
    return (problems.push(`${at} の url は …/FeatureServer/0 のようなレイヤーの URL にしてください`), null);
  }
  if (!isRecord(fields)) return (problems.push(`${at} に fields（属性名の対応）がありません`), null);

  const mapped: CatalogFields = { source: [] };
  for (const role of ['id', 'acquired', 'registered', 'sensor', 'angle'] as const) {
    const name = fields[role];
    if (name === undefined || name === '') continue;
    if (isName(name)) mapped[role] = name;
    else problems.push(`${at} の fields.${role} は属性名（英数字と _）にしてください`);
  }
  const sources = Array.isArray(fields.source) ? fields.source : [fields.source];
  mapped.source = sources.filter(isName);
  if (mapped.source.length === 0) return (problems.push(`${at} に fields.source（COG の URL かローカルパスの入った属性名）がありません`), null);

  const headings: CatalogConfig['labels'] = {};
  if (isRecord(labels)) {
    for (const role of Object.keys(roleLabels) as Array<keyof typeof roleLabels>) {
      if (typeof labels[role] === 'string' && labels[role]) headings[role] = labels[role] as string;
    }
  }

  const extra: CatalogColumn[] = [];
  if (Array.isArray(columns)) {
    columns.forEach((c, i) => {
      const field = typeof c === 'string' ? c : isRecord(c) ? c.field : undefined;
      if (!isName(field)) return void problems.push(`${at} の columns[${i}] は属性名か { "field", "label" } にしてください`);
      const heading = isRecord(c) && typeof c.label === 'string' && c.label ? c.label : field;
      extra.push({ field, label: heading });
    });
  } else if (columns !== undefined) problems.push(`${at} の columns が配列ではありません`);

  return {
    label: typeof label === 'string' && label ? label : `カタログ ${index + 1}`,
    url: url.split('?', 1)[0].replace(/\/+$/, ''),
    ...(typeof token === 'string' && token ? { token } : {}),
    fields: mapped,
    labels: headings,
    columns: extra,
    ...(typeof where === 'string' && where.trim() ? { where: where.trim() } : {}),
    maxResults: typeof maxResults === 'number' && Number.isInteger(maxResults) && maxResults > 0 ? Math.min(maxResults, 5000) : 500,
  };
}

/** Where an image is: a URL the viewer opens as a COG, or a path on the user's computer or network. */
export type CatalogSource = { kind: 'url'; url: string } | { kind: 'path'; path: string };

/** A COG URL (http, https or protocol-relative); anything else (`\\nas\…`, `C:\…`, `/mnt/…`, `file://…`) is a local path. */
export function sourceOf(value: unknown): CatalogSource | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (/^(https?:)?\/\/[^/]/i.test(text)) return { kind: 'url', url: text };
  return { kind: 'path', path: text };
}

/** One image of the catalog. */
export interface CatalogRecord {
  /** The footprint (in the map's projection) with every attribute. */
  feature: Feature;
  id: string;
  acquired: unknown;
  registered: unknown;
  sensor: string;
  angle: number | null;
  source: CatalogSource | null;
}

/** The roles of a feature's attributes. */
export function recordOf(feature: Feature, fields: CatalogFields): CatalogRecord {
  const get = (name?: string) => (name ? feature.get(name) : undefined);
  const angle = Number(get(fields.angle));
  return {
    feature,
    id: String(get(fields.id) ?? feature.getId() ?? ''),
    acquired: get(fields.acquired) ?? null,
    registered: get(fields.registered) ?? null,
    sensor: get(fields.sensor) == null ? '' : String(get(fields.sensor)),
    angle: get(fields.angle) == null || get(fields.angle) === '' || !Number.isFinite(angle) ? null : angle,
    source: fields.source.map((name) => sourceOf(get(name))).find((s) => s !== null) ?? null,
  };
}

/** The Esri field types the viewer cares about, by name. */
export type FieldTypes = Record<string, string>;

/** A day as `yyyy-mm-dd`, as a date input gives it. */
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n: number) => String(n).padStart(2, '0');
/** `yyyy-mm-dd hh:mm:ss` in UTC, for TIMESTAMP literals. */
const utcText = (time: number) => {
  const d = new Date(time);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};
/** The start of a local day, in milliseconds. */
const localDay = (day: string, plus = 0) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d + plus).getTime();
};
const nextDay = (day: string) => {
  const d = new Date(localDay(day, 1));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * A condition on a date-like field for local days `from` to `to` (both
 * included, either may be ''), written for the field's type: date fields
 * compare timestamps (UTC, as ArcGIS stores them), date-only fields dates,
 * numbers milliseconds, and text the leading `yyyy-mm-dd`.
 */
export function dayRange(field: string, type: string | undefined, from: string, to: string): string[] {
  const parts: string[] = [];
  const bound = (day: string, op: '>=' | '<') => {
    if (type === 'esriFieldTypeDate' || type === 'esriFieldTypeTimestampOffset') return `${field} ${op} TIMESTAMP '${utcText(localDay(day))}'`;
    if (type === 'esriFieldTypeDateOnly') return `${field} ${op} DATE '${day}'`;
    if (type && /Integer|Double|Single/.test(type)) return `${field} ${op} ${localDay(day)}`;
    return `${field} ${op} '${day}'`;
  };
  if (dayPattern.test(from)) parts.push(bound(from, '>='));
  if (dayPattern.test(to)) parts.push(bound(nextDay(to), '<'));
  return parts;
}

/** A SQL string literal. */
export const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** What the search panel asks for. */
export interface CatalogSearch {
  acquiredFrom: string;
  acquiredTo: string;
  registeredFrom: string;
  registeredTo: string;
  /** '' for any sensor. */
  sensor: string;
  /** Upper limit of the angle; null for none. */
  maxAngle: number | null;
  /** Extra SQL, ANDed with the rest. */
  where: string;
}

export const emptySearch: CatalogSearch = { acquiredFrom: '', acquiredTo: '', registeredFrom: '', registeredTo: '', sensor: '', maxAngle: null, where: '' };

/** The `where` of a search. */
export function whereOf(catalog: CatalogConfig, types: FieldTypes, search: CatalogSearch): string {
  const { fields } = catalog;
  const parts: string[] = [];
  if (catalog.where) parts.push(`(${catalog.where})`);
  if (fields.acquired) parts.push(...dayRange(fields.acquired, types[fields.acquired], search.acquiredFrom, search.acquiredTo));
  if (fields.registered) parts.push(...dayRange(fields.registered, types[fields.registered], search.registeredFrom, search.registeredTo));
  if (fields.sensor && search.sensor) parts.push(`${fields.sensor} = ${quote(search.sensor)}`);
  if (fields.angle && search.maxAngle !== null && Number.isFinite(search.maxAngle)) parts.push(`${fields.angle} <= ${search.maxAngle}`);
  if (search.where.trim()) parts.push(`(${search.where.trim()})`);
  return parts.length ? parts.join(' AND ') : '1=1';
}

/** The catalog layer's field types (and whether it can order and page results). */
export interface CatalogLayerInfo {
  types: FieldTypes;
  /** Whether `orderByFields` and `resultRecordCount` can be used. */
  paging: boolean;
}

export async function readCatalogLayer(catalog: CatalogConfig): Promise<CatalogLayerInfo> {
  const json = await esriJson<{ fields?: Array<{ name: string; type: string }>; advancedQueryCapabilities?: { supportsPagination?: boolean; supportsOrderBy?: boolean } }>(
    catalog.url,
    {},
    catalog.token,
  );
  const types: FieldTypes = {};
  for (const f of json.fields ?? []) types[f.name] = f.type;
  const caps = json.advancedQueryCapabilities;
  return { types, paging: caps ? caps.supportsPagination !== false && caps.supportsOrderBy !== false : true };
}

/** The values of the sensor field, for the search's choices; empty when the service cannot list them. */
export async function sensorsOf(catalog: CatalogConfig): Promise<string[]> {
  const field = catalog.fields.sensor;
  if (!field) return [];
  try {
    const json = await esriJson<{ features?: Array<{ attributes: Record<string, unknown> }> }>(
      `${catalog.url}/query`,
      { where: catalog.where ?? '1=1', outFields: field, returnDistinctValues: 'true', returnGeometry: 'false', orderByFields: field },
      catalog.token,
      true,
    );
    const values = new Set<string>();
    for (const f of json.features ?? []) {
      const v = f.attributes[field];
      if (v !== null && v !== undefined && v !== '') values.add(String(v));
    }
    return [...values].sort((a, b) => a.localeCompare(b, 'ja'));
  } catch {
    return [];
  }
}

/** The search's results: at most `maxResults` images, newest first, and how many match in all. */
export interface CatalogResult {
  records: CatalogRecord[];
  total: number | null;
}

const format = new EsriJSON();

/**
 * Finds the images matching `search` (and meeting `extent`, in `projection`,
 * when given), newest first. Services that cannot order or page results are
 * asked for everything and sorted here.
 */
export async function searchCatalog(
  catalog: CatalogConfig,
  layer: CatalogLayerInfo,
  search: CatalogSearch,
  view: { extent: Extent; projection: ProjectionLike } | null,
  projection: ProjectionLike,
): Promise<CatalogResult> {
  const where = whereOf(catalog, layer.types, search);
  const spatial: Record<string, string> = {};
  if (view) {
    const [xmin, ymin, xmax, ymax] = transformExtent(view.extent, view.projection, 'EPSG:4326');
    const clamp = (v: number, limit: number) => Math.max(-limit, Math.min(limit, v));
    spatial.geometry = JSON.stringify({ xmin: clamp(xmin, 180), ymin: clamp(ymin, 90), xmax: clamp(xmax, 180), ymax: clamp(ymax, 90), spatialReference: { wkid: 4326 } });
    spatial.geometryType = 'esriGeometryEnvelope';
    spatial.inSR = '4326';
    spatial.spatialRel = 'esriSpatialRelIntersects';
  }
  const order = catalog.fields.acquired ?? catalog.fields.registered;
  const base = { where, ...spatial, outFields: '*', returnGeometry: 'true', outSR: '4326' };
  type Answer = { features?: unknown[]; exceededTransferLimit?: boolean };
  const ask = (params: Record<string, string>) => esriJson<Answer>(`${catalog.url}/query`, { ...base, ...params }, catalog.token, true);

  const counting = esriJson<{ count?: number }>(`${catalog.url}/query`, { where, ...spatial, returnCountOnly: 'true' }, catalog.token, true)
    .then((c) => (typeof c.count === 'number' ? c.count : null))
    .catch(() => null);

  let json: Answer;
  if (layer.paging) {
    try {
      json = await ask({ ...(order ? { orderByFields: `${order} DESC` } : {}), resultRecordCount: String(catalog.maxResults) });
    } catch {
      // Older services refuse ordering or paging: ask plainly.
      layer.paging = false;
      json = await ask({});
    }
  } else json = await ask({});

  const features = format.readFeatures(json, { dataProjection: 'EPSG:4326', featureProjection: projection }) as Feature[];
  let records = features.map((f) => recordOf(f, catalog.fields));
  if (!layer.paging) records = sortRecords(records, 'acquired', true).slice(0, catalog.maxResults);
  const total = await counting;
  return { records, total: total ?? (json.exceededTransferLimit ? null : records.length) };
}

/** A date-like value as milliseconds, for sorting and showing; NaN when it is not one. */
export function timeOf(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !value.trim()) return Number.NaN;
  // `2026-10-01 01:23:45` without a zone: as ArcGIS shows them, in UTC.
  const text = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value.trim()) ? `${value.trim().replace(' ', 'T')}Z` : value.trim();
  return Date.parse(text);
}

/** A date-like value in local time (`2026/10/01 10:23`), or the text as it is. */
export function timeText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const time = timeOf(value);
  if (Number.isNaN(time)) return String(value);
  const d = new Date(time);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The roles the list can sort by. */
export type SortKey = 'id' | 'acquired' | 'registered' | 'sensor' | 'angle' | `column:${string}`;

/** The records ordered by `key`; empty values last whichever way. */
export function sortRecords(records: CatalogRecord[], key: SortKey, descending: boolean): CatalogRecord[] {
  const value = (r: CatalogRecord): number | string | null => {
    if (key === 'acquired' || key === 'registered') {
      const t = timeOf(r[key]);
      return Number.isNaN(t) ? null : t;
    }
    if (key === 'angle') return r.angle;
    if (key === 'id' || key === 'sensor') return r[key] || null;
    const v = r.feature.get(key.slice('column:'.length));
    return v === null || v === undefined || v === '' ? null : typeof v === 'number' ? v : String(v);
  };
  return [...records].sort((a, b) => {
    const [x, y] = [value(a), value(b)];
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ja', { numeric: true });
    return descending ? -order : order;
  });
}
