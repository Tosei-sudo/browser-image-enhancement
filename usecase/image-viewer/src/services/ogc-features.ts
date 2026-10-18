/**
 * OGC API – Features: the collections of a landing page (or the one
 * collection a URL names), each read as GeoJSON a page at a time, following
 * `next` links up to {@link MAX_FEATURES}: all of it, or the area shown.
 * Items come in Web Mercator when the server offers it (Part 2), else in
 * CRS84. A filter is sent as CQL2 text when the server conforms to Part 3,
 * else as `property=value` pairs. Attribute types come from the queryables.
 * Collections of a server that conforms to Part 4 can be edited: added,
 * replaced and deleted items go to the server one request each.
 */
import type Feature from 'ol/Feature.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import { transformExtent } from 'ol/proj.js';
import type { Extent } from 'ol/extent.js';
import { MAX_FEATURES, nextColor, request, ServiceError, type Field, type LayerChoice, type OpenContext, type OpenPick, type ServiceCatalog, type ServiceLayer, type ServiceRef } from './common.js';
import { conformance, conformsTo, fetchJson, findLink, isRecord, linksOf, ogcUrl, readOgcService, type OgcCollection, type OgcService } from './ogc-api.js';
import { vectorLayer } from './vector.js';
import { fieldsOf } from './wms.js';
import { LayerStyle, singleSpec } from '../vector-style.js';
import type { DrawableType, EditTarget } from '../edit-session.js';

const WEB_MERCATOR = 'http://www.opengis.net/def/crs/EPSG/0/3857';
/** Items asked for in one page (servers may send fewer). */
const PAGE = 1000;
/** Pages followed at most (a server whose `next` never ends). */
const MAX_PAGES = 500;
const GEOJSON = 'application/geo+json, application/json;q=0.9';

/** Reads the collections of features at `url` (a landing page or a collection). */
export async function readOgcFeatures(url: string): Promise<ServiceCatalog> {
  const service = await readOgcService(url);
  const collections = service.collections.filter((c) => !c.itemType || c.itemType === 'feature');
  if (collections.length === 0) throw new ServiceError('地物のコレクションがありません');
  const cql2 = conformsTo(service.classes, conformance.filter) && conformsTo(service.classes, conformance.cql2Text);
  const choices: LayerChoice[] = collections.map((c) => ({ name: c.id, title: c.title, abstract: c.description, area: 'vector', filter: cql2 ? 'cql2' : 'simple' }));
  return {
    kind: 'ogc-features',
    url,
    title: service.title,
    choices,
    open: async (choice, context, pick = {}) => openCollection(service, collections.find((c) => c.id === choice.name)!, url, context, pick),
  };
}

/** Where the items of a collection are. */
export function itemsHref(service: Pick<OgcService, 'landing' | 'query'>, collection: OgcCollection): string {
  const link = findLink(collection.links, ['items'], [/geo\+json/, /json/]);
  return link?.href ?? ogcUrl(service.landing, `/collections/${encodeURIComponent(collection.id)}/items`, service.query);
}

/**
 * The first page of items: `limit`, the box (CRS84), the CRS and the filter.
 * A simple filter is `name=value` pairs joined by `&` or `AND`.
 */
export function itemsUrl(href: string, options: { limit: number; bbox?: Extent; crs?: string; filter?: string; cql2: boolean }): string {
  const u = new URL(href);
  for (const key of [...u.searchParams.keys()]) if (/^(limit|bbox|crs|f)$/i.test(key)) u.searchParams.delete(key);
  u.searchParams.set('limit', String(options.limit));
  if (options.bbox) u.searchParams.set('bbox', options.bbox.map((n) => +n.toFixed(7)).join(','));
  if (options.crs) u.searchParams.set('crs', options.crs);
  const filter = options.filter?.trim();
  if (filter) {
    if (options.cql2) {
      u.searchParams.set('filter', filter);
      u.searchParams.set('filter-lang', 'cql2-text');
    } else {
      for (const [k, v] of simpleFilter(filter)) u.searchParams.set(k, v);
    }
  }
  return u.href;
}

/** `name=value` pairs of a simple filter; names the API itself uses are refused. */
export function simpleFilter(text: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const part of text.split(/\s*&\s*|\s+AND\s+/i)) {
    if (!part.trim()) continue;
    const m = /^\s*([^=\s]+)\s*=\s*(.*?)\s*$/.exec(part);
    if (!m) throw new ServiceError(`条件「${part}」は 属性=値 の形で書いてください`);
    if (/^(limit|bbox|bbox-crs|crs|f|filter|filter-lang|filter-crs|datetime|offset|sortby|properties)$/i.test(m[1])) throw new ServiceError(`条件に ${m[1]} は使えません`);
    pairs.push([m[1], m[2].replace(/^'(.*)'$|^"(.*)"$/, '$1$2')]);
  }
  return pairs;
}

/** The fields of a `queryables` JSON schema (geometry left out). */
export function parseQueryables(json: unknown): Field[] {
  if (!isRecord(json) || !isRecord(json.properties)) return [];
  const fields: Field[] = [];
  for (const [name, schema] of Object.entries(json.properties)) {
    if (!isRecord(schema)) continue;
    const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
    const format = typeof schema.format === 'string' ? schema.format : '';
    const ref = typeof schema.$ref === 'string' ? schema.$ref : '';
    if (/^geometry/i.test(format) || /geojson|geometry/i.test(ref) || name === 'geometry') continue;
    fields.push({
      name,
      alias: typeof schema.title === 'string' && schema.title ? schema.title : name,
      type: type === 'integer' ? 'integer' : type === 'number' ? 'double' : 'string',
      editable: false,
      nullable: true,
      ...(typeof schema.maxLength === 'number' ? { length: schema.maxLength } : {}),
      ...(Array.isArray(schema.enum) && schema.enum.every((v) => typeof v === 'string' || typeof v === 'number') ? { codes: (schema.enum as Array<string | number>).map((v) => ({ code: v, name: String(v) })) } : {}),
    });
  }
  return fields;
}

/**
 * Reads pages from `first`, following `next` links on the same server,
 * until `max` features or the last page. Returns the GeoJSON features and
 * whether there were more.
 */
export async function readPages(first: string, max: number, fetchPage: (url: string) => Promise<unknown> = (u) => fetchJson(u, GEOJSON)): Promise<{ features: unknown[]; more: boolean }> {
  const origin = new URL(first).origin;
  const seen = new Set<string>();
  const features: unknown[] = [];
  let url: string | undefined = first;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    seen.add(url);
    const json = await fetchPage(url);
    if (!isRecord(json) || !Array.isArray(json.features)) throw new ServiceError('GeoJSON の FeatureCollection ではありません');
    features.push(...json.features);
    if (features.length > max) return { features: features.slice(0, max), more: true };
    const next = findLink(linksOf(json.links, url), ['next'], [/geo\+json/, /json/]);
    url = next && new URL(next.href).origin === origin && !seen.has(next.href) ? next.href : undefined;
    if (json.features.length === 0) url = undefined;
  }
  return { features, more: !!url };
}

async function openCollection(
  service: OgcService,
  collection: OgcCollection,
  url: string,
  context: OpenContext,
  pick: OpenPick,
): Promise<ServiceLayer> {
  const cql2 = conformsTo(service.classes, conformance.filter) && conformsTo(service.classes, conformance.cql2Text);
  const mercator = conformsTo(service.classes, conformance.crs) && collection.crs.some((c) => /EPSG\/0\/3857$/.test(c));
  // The box asked for (CRS84), from the view or the selection, or kept in the link.
  let bbox: Extent | undefined = pick.bbox;
  if (!bbox && pick.area && pick.area !== 'all') {
    const area = context.area?.(pick.area);
    if (!area) throw new ServiceError(pick.area === 'selection' ? '地物が選択されていません' : '表示範囲を取得できませんでした');
    bbox = transformExtent(area, 'EPSG:3857', 'EPSG:4326');
  }
  const href = itemsHref(service, collection);
  const first = itemsUrl(href, { limit: PAGE, bbox, crs: mercator ? WEB_MERCATOR : undefined, filter: pick.filter, cql2 });
  const queryablesLink = findLink(collection.links, ['queryables', 'http://www.opengis.net/def/rel/ogc/1.0/queryables'], [/schema\+json/, /json/]);
  const [{ features: items, more }, queryables] = await Promise.all([
    readPages(first, MAX_FEATURES),
    fetchJson(queryablesLink?.href ?? ogcUrl(service.landing, `/collections/${encodeURIComponent(collection.id)}/queryables`, service.query), 'application/schema+json, application/json;q=0.9')
      .then(parseQueryables)
      .catch(() => [] as Field[]),
  ]);
  let features: Feature[];
  try {
    features = new GeoJSON().readFeatures({ type: 'FeatureCollection', features: items }, { dataProjection: mercator ? 'EPSG:3857' : 'EPSG:4326', featureProjection: 'EPSG:3857' }) as Feature[];
  } catch {
    throw new ServiceError('地物を読めませんでした');
  }
  const found = fieldsOf(features);
  const fields: Field[] = [...queryables, ...found.filter((f) => !queryables.some((q) => q.name === f.name))];
  const editable = conformsTo(service.classes, conformance.edit);
  if (editable) for (const f of fields) f.editable = true;

  const layer = vectorLayer(features);
  const ref: ServiceRef = { kind: 'ogc-features', url, layer: collection.id, ...(bbox ? { bbox: bbox.map((n) => +n.toFixed(7)) as ServiceRef['bbox'] } : {}), ...(pick.filter?.trim() ? { filter: pick.filter.trim() } : {}) };
  const box = collection.bbox;
  return {
    ref,
    title: collection.title,
    badge: 'OGC',
    layer,
    correction: null,
    vector: { source: layer.getSource()!, fields, truncated: more, ...(bbox ? { note: '追加したときの表示範囲の地物' } : {}) },
    style: new LayerStyle(layer, singleSpec(nextColor())),
    ...(editable ? { editTarget: ogcFeaturesTarget(href, fields, geometryTypeOf(features)) } : {}),
    extent: box ? transformExtent([box[0], Math.max(box[1], -85), box[2], Math.min(box[3], 85)], 'EPSG:4326', 'EPSG:3857') : null,
    info: [
      ['種類', 'OGC API – Features'],
      ['URL', url],
      ['コレクション', collection.id],
      ['座標系', mercator ? 'EPSG:3857' : 'CRS84'],
      ...(pick.filter?.trim() ? [['条件', pick.filter.trim()] as [string, string]] : []),
      ...(bbox ? [['範囲', bbox.map((n) => n.toFixed(4)).join(', ')] as [string, string]] : []),
      ['地物数', `${features.length.toLocaleString()}${more ? `（先頭 ${MAX_FEATURES.toLocaleString()} 件）` : ''}`],
      ...(editable ? [['編集', '追加・更新・削除（OGC API – Features Part 4）'] as [string, string]] : []),
    ],
  };
}

/** The one geometry type of `features`, for drawing new ones; null when mixed or none. */
function geometryTypeOf(features: Feature[]): DrawableType | null {
  const types = new Set(features.map((f) => f.getGeometry()?.getType()).filter(Boolean));
  const [type] = types;
  return types.size === 1 && /^(Multi)?(Point|LineString|Polygon)$/.test(type!) ? (type as DrawableType) : null;
}

/**
 * Edits of an OGC API – Features collection (Part 4): new features are
 * POSTed to the items, changed ones PUT whole at their item, deleted ones
 * DELETEd, one request each, in CRS84.
 */
export function ogcFeaturesTarget(items: string, fields: Field[], geometryType: DrawableType | null): EditTarget {
  const format = new GeoJSON();
  const names = new Set(fields.map((f) => f.name));
  const body = (f: Feature) => {
    const json = format.writeFeatureObject(f, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' });
    json.properties = Object.fromEntries(Object.entries(json.properties ?? {}).filter(([k]) => names.has(k)));
    delete json.id;
    return JSON.stringify(json);
  };
  const itemUrl = (f: Feature) => {
    const u = new URL(items);
    u.pathname = `${u.pathname.replace(/\/+$/, '')}/${encodeURIComponent(String(f.getId()))}`;
    return u.href;
  };
  const send = (url: string, method: string, data?: string) => request(url, { method, ...(data ? { body: data, headers: { 'Content-Type': 'application/geo+json' } } : {}) });
  return {
    canCreate: true,
    canUpdate: true,
    canDelete: true,
    geometryType,
    template: {},
    savedTo: 'サーバー',
    async save({ adds, updates, deletes }) {
      const refused = new Map<Feature, string>();
      for (const f of adds) {
        try {
          const response = await send(items, 'POST', body(f));
          const location = response.headers.get('Location');
          const id = location ? decodeURIComponent(new URL(location, items).pathname.replace(/\/+$/, '').split('/').pop() ?? '') : '';
          if (id) f.setId(id);
        } catch (error) {
          refused.set(f, error instanceof Error ? error.message : String(error));
        }
      }
      for (const { feature: f } of updates) {
        if (f.getId() === undefined) refused.set(f, 'ID がない地物は更新できません');
        else await send(itemUrl(f), 'PUT', body(f)).catch((error: Error) => refused.set(f, error.message));
      }
      for (const f of deletes) {
        if (f.getId() === undefined) refused.set(f, 'ID がない地物は削除できません');
        else await send(itemUrl(f), 'DELETE').catch((error: Error) => refused.set(f, error.message));
      }
      return { refused };
    },
  };
}

