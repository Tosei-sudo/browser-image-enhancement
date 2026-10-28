/**
 * STAC (SpatioTemporal Asset Catalog) search, for the 「STAC 検索」 panel
 * (stac-panel.ts): the queries of a STAC API's `/search` (STAC API 1.0,
 * POST, or GET where POST is refused), the items it answers with, the
 * `next` links of their pages, and static catalogs, collections and items
 * read by URL (their `item` and `child` links walked, within limits).
 *
 * Where to search is `config.json`'s `stacCatalogs`; without the key Earth
 * Search (Sentinel-2 L2A, Landsat C2 L2) is used, and `"stacCatalogs": []`
 * turns the panel off, so nothing leaves the page on a closed network.
 * Headers (a token) go only to the catalog's own origin; Planetary
 * Computer's assets are signed with its SAS tokens when a catalog says
 * `"sign": "planetary-computer"`: on each request, never in the URLs kept.
 *
 * Everything read from the network is checked: only http(s) links are
 * followed, geometries are validated and capped, responses are capped in size.
 */
import { clockOf, readTextInstant, timeZoneRuleFor, type TimeZone } from './time-zone.js';

/** One catalog of config.json's `stacCatalogs`. */
export interface StacCatalogConfig {
  label: string;
  /** The STAC API's root (`/search` is under it), or a static catalog's JSON. */
  url: string;
  /** Collections offered (checked) in the panel; none: the panel lists the API's own. */
  collections: string[];
  /** Headers for the catalog's own origin only (a `token` becomes `Authorization: Bearer …`). */
  headers?: Record<string, string>;
  /** How asset URLs are signed before they are opened. */
  sign?: 'planetary-computer';
  /** How the cloud cover is asked for: the `query` extension (default) or CQL2 `filter`. */
  cloudFilter?: 'query' | 'filter';
}

/** What config.json gets without a `stacCatalogs` entry. */
export const DEFAULT_STAC_CATALOGS: StacCatalogConfig[] = [
  { label: 'Earth Search（AWS）', url: 'https://earth-search.aws.element84.com/v1', collections: ['sentinel-2-l2a', 'landsat-c2-l2'] },
];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** An absolute http(s) URL or one relative to the page (`./`, `../`, `/`). */
const isUrl = (url: unknown): url is string => typeof url === 'string' && /^(https?:)?\/\/|^\.{0,2}\//.test(url);
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** One entry of `stacCatalogs`, checked; null (with the reason in `problems`) when it cannot be used. */
export function stacCatalogOf(value: unknown, problems: string[], index: number): StacCatalogConfig | null {
  const at = `stacCatalogs[${index}]`;
  // A URL alone will do.
  const entry = typeof value === 'string' ? { url: value } : value;
  if (!isRecord(entry)) return (problems.push(`${at} はオブジェクトで指定`), null);
  const { label, url, collections, token, headers, sign, cloudFilter } = entry;
  if (!isUrl(url)) return (problems.push(`${at} に url（http(s) か相対パス）なし`), null);
  const out: StacCatalogConfig = { label: typeof label === 'string' && label ? label : url, url, collections: [] };
  if (collections !== undefined) {
    if (Array.isArray(collections) && collections.every((c) => typeof c === 'string' && c)) out.collections = [...new Set(collections as string[])];
    else problems.push(`${at} の collections はコレクション ID（文字列）の配列で指定`);
  }
  const sent: Record<string, string> = {};
  if (headers !== undefined) {
    if (isRecord(headers)) {
      for (const [name, v] of Object.entries(headers)) {
        if (HEADER_NAME.test(name) && typeof v === 'string' && !/[\r\n]/.test(v)) sent[name] = v;
        else problems.push(`${at} の headers の「${name}」は無視`);
      }
    } else problems.push(`${at} の headers はオブジェクトで指定`);
  }
  if (typeof token === 'string' && token && !/[\r\n]/.test(token) && !Object.keys(sent).some((k) => k.toLowerCase() === 'authorization')) sent.Authorization = `Bearer ${token}`;
  if (Object.keys(sent).length) out.headers = sent;
  if (sign !== undefined) {
    if (sign === 'planetary-computer') out.sign = sign;
    else problems.push(`${at} の sign は "planetary-computer" のみ使用可能`);
  }
  if (cloudFilter !== undefined) {
    if (cloudFilter === 'query' || cloudFilter === 'filter') out.cloudFilter = cloudFilter;
    else problems.push(`${at} の cloudFilter は query か filter で指定`);
  }
  return out;
}

/** What the panel asks for. */
export interface StacSearch {
  /** West, south, east, north in degrees; null: anywhere. */
  bbox: [number, number, number, number] | null;
  /** `yyyy-mm-dd` (UTC), '' for no limit. */
  from: string;
  to: string;
  /** Most cloud cover in percent; null: any. */
  maxCloud: number | null;
  /** None: every collection. */
  collections: string[];
  /** Items per page. */
  limit: number;
}

/** A request of a page of results. */
export interface StacRequest {
  url: string;
  method: 'GET' | 'POST';
  body?: Record<string, unknown>;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The `datetime` of a search: a closed or open interval, or undefined for any time. */
export function datetimeOf(from: string, to: string, zone?: TimeZone | null): string | undefined {
  // Items written in another zone than they say: the days as the clock they are written in.
  const at = (text: string) => (zone ? `${new Date(clockOf(Date.parse(text), zone)).toISOString().replace(/\.\d{3}Z$/, 'Z')}` : text);
  const start = DAY.test(from) ? at(`${from}T00:00:00Z`) : '..';
  const end = DAY.test(to) ? at(`${to}T23:59:59Z`) : '..';
  return start === '..' && end === '..' ? undefined : `${start}/${end}`;
}

/** The JSON body of a POST `/search` (STAC API 1.0, with the sort and query or filter extensions). */
export function searchBody(search: StacSearch, catalog: Pick<StacCatalogConfig, 'cloudFilter'> & { url?: string }, sort = true): Record<string, unknown> {
  const body: Record<string, unknown> = { limit: search.limit };
  if (search.bbox) body.bbox = search.bbox.map((v) => Math.round(v * 1e6) / 1e6);
  const datetime = datetimeOf(search.from, search.to, timeZoneRuleFor(catalog.url)?.zone);
  if (datetime) body.datetime = datetime;
  if (search.collections.length) body.collections = search.collections;
  if (search.maxCloud !== null && Number.isFinite(search.maxCloud)) {
    if (catalog.cloudFilter === 'filter') {
      body.filter = { op: '<=', args: [{ property: 'eo:cloud_cover' }, search.maxCloud] };
      body['filter-lang'] = 'cql2-json';
    } else body.query = { 'eo:cloud_cover': { lte: search.maxCloud } };
  }
  if (sort) body.sortby = [{ field: 'properties.datetime', direction: 'desc' }];
  return body;
}

/** The same search as GET parameters. */
export function searchParams(body: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (key === 'bbox' || key === 'collections') params.set(key, (value as unknown[]).join(','));
    else if (key === 'sortby') params.set(key, (value as Array<{ field: string; direction: string }>).map((s) => `${s.direction === 'desc' ? '-' : '+'}${s.field}`).join(','));
    else if (key === 'filter-lang') params.set(key, 'cql2-json');
    else params.set(key, typeof value === 'string' || typeof value === 'number' ? String(value) : JSON.stringify(value));
  }
  return params;
}

/** The `/search` endpoint under a STAC API's root. */
export function searchUrl(root: string): string {
  return `${root.replace(/[?#].*$/, '').replace(/\/+$/, '')}/search`;
}

/** One asset of an item. */
export interface StacAsset {
  key: string;
  href: string;
  title: string;
  type: string;
  roles: string[];
  /** The band names it holds (eo:bands / bands: common name, else name). */
  bands: string[];
  /** The common name of a one-band asset (red, nir…). */
  commonName: string;
  /** A GeoTIFF (COG) the viewer can open. */
  cog: boolean;
}

/** One item found. */
export interface StacItem {
  id: string;
  collection: string;
  /** ms since 1970; null when it has none. */
  time: number | null;
  cloud: number | null;
  /** Its footprint (Polygon or MultiPolygon rings, lon/lat), or its bbox as one. */
  polygons: number[][][][];
  bbox: [number, number, number, number] | null;
  thumbnail: string | null;
  assets: StacAsset[];
  platform: string;
  /** Where it was read from (a static item's own URL), for the information panel. */
  self: string;
}

/** The link to the next page. */
export interface NextLink {
  href: string;
  method: 'GET' | 'POST';
  body?: Record<string, unknown>;
  merge: boolean;
}

export interface StacPage {
  items: StacItem[];
  next: NextLink | null;
  /** How many there are in all, when the API says. */
  matched: number | null;
}

/** Most vertices of a footprint. */
const MAX_VERTICES = 20_000;
/** Most items read from one answer. */
const MAX_ITEMS = 1000;
/** Most assets read from one item. */
const MAX_ASSETS = 200;

/** `href` made absolute against `base`, when it is http(s); else null. */
export function httpUrl(href: unknown, base?: string): string | null {
  if (typeof href !== 'string' || !href || href.length > 8192) return null;
  try {
    const url = new URL(href, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** Rings of lon/lat checked; null when any point is not. */
function ringsOf(value: unknown, budget: { left: number }): number[][][] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const rings: number[][][] = [];
  for (const ring of value) {
    if (!Array.isArray(ring) || ring.length < 4) return null;
    budget.left -= ring.length;
    if (budget.left < 0) return null;
    const points: number[][] = [];
    for (const p of ring) {
      if (!Array.isArray(p)) return null;
      const [x, y] = [num(p[0]), num(p[1])];
      if (x === null || y === null || Math.abs(x) > 360 || Math.abs(y) > 90) return null;
      points.push([x, y]);
    }
    rings.push(points);
  }
  return rings;
}

/** The polygons of a GeoJSON geometry (Polygon, MultiPolygon), or of a bbox. */
export function polygonsOf(geometry: unknown, bbox: [number, number, number, number] | null): number[][][][] {
  const budget = { left: MAX_VERTICES };
  if (isRecord(geometry)) {
    if (geometry.type === 'Polygon') {
      const rings = ringsOf(geometry.coordinates, budget);
      if (rings) return [rings];
    } else if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
      const polygons = geometry.coordinates.map((p) => ringsOf(p, budget));
      if (polygons.length && polygons.every((p) => p)) return polygons as number[][][][];
    }
  }
  if (!bbox) return [];
  const [w, s, e, n] = bbox;
  return [[[[w, s], [e, s], [e, n], [w, n], [w, s]]]];
}

function bboxOf(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || (value.length !== 4 && value.length !== 6)) return null;
  const v = value.map(num);
  if (v.some((n) => n === null)) return null;
  const [w, s, e, n] = value.length === 6 ? [v[0], v[1], v[3], v[4]] : v;
  return Math.abs(s!) <= 90 && Math.abs(n!) <= 90 && Math.abs(w!) <= 360 && Math.abs(e!) <= 360 ? [w!, s!, e!, n!] : null;
}

/** The band names of an asset (STAC 1.0 eo:bands, 1.1 bands). */
function bandsOf(asset: Record<string, unknown>): { names: string[]; common: string } {
  const list = Array.isArray(asset['eo:bands']) ? asset['eo:bands'] : Array.isArray(asset.bands) ? asset.bands : [];
  const names: string[] = [];
  const commons: string[] = [];
  for (const b of list.slice(0, 64)) {
    if (!isRecord(b)) continue;
    const common = str(b.common_name ?? b['eo:common_name']);
    commons.push(common);
    names.push(common || str(b.name));
  }
  return { names: names.filter(Boolean), common: list.length === 1 ? commons[0] : '' };
}

/** Asset keys that are a band by their name alone (Earth Search names its assets so). */
const COMMON_KEYS = new Set(['coastal', 'blue', 'green', 'red', 'rededge', 'rededge1', 'rededge2', 'rededge3', 'yellow', 'pan', 'nir', 'nir08', 'nir09', 'cirrus', 'swir16', 'swir22', 'lwir', 'lwir11', 'lwir12']);

/** Whether an asset is a GeoTIFF: its media type, or a .tif name when it has none. */
export function isCog(type: string, href: string): boolean {
  if (type) return /^image\/(tiff|x\.geotiff|vnd\.stac\.geotiff)\b/i.test(type);
  return /\.tiff?$/i.test(new URL(href).pathname);
}

/** An item (a GeoJSON Feature of STAC); null when it is not one. `base`: the URL it was read from. */
export function parseItem(json: unknown, base?: string): StacItem | null {
  if (!isRecord(json) || json.type !== 'Feature') return null;
  const properties = isRecord(json.properties) ? json.properties : {};
  const id = str(json.id);
  if (!id) return null;
  const bbox = bboxOf(json.bbox);
  const datetime = str(properties.datetime) || str(properties.start_datetime);
  // In another zone than it says, when config.json says so.
  const zone = timeZoneRuleFor(base)?.zone;
  const time = datetime ? ((zone && readTextInstant(datetime, zone)) ?? Date.parse(datetime)) : NaN;
  const assets: StacAsset[] = [];
  let thumbnail: string | null = null;
  const self = Array.isArray(json.links) ? json.links.find((l) => isRecord(l) && l.rel === 'self') : undefined;
  const itemBase = (isRecord(self) && httpUrl(self.href, base)) || base;
  if (isRecord(json.assets)) {
    for (const [key, a] of Object.entries(json.assets).slice(0, MAX_ASSETS)) {
      if (!isRecord(a)) continue;
      const href = httpUrl(a.href, itemBase);
      if (!href) continue;
      const type = str(a.type);
      const roles = Array.isArray(a.roles) ? a.roles.filter((r): r is string => typeof r === 'string') : [];
      if (!thumbnail && (key === 'thumbnail' || roles.includes('thumbnail')) && (/^image\/(png|jpeg|jpg|webp|gif)\b/i.test(type) || (!type && /\.(png|jpe?g|webp|gif)$/i.test(new URL(href).pathname)))) thumbnail = href;
      const { names, common } = bandsOf(a);
      assets.push({ key, href, title: str(a.title), type, roles, bands: names, commonName: common || (COMMON_KEYS.has(key.toLowerCase()) ? key.toLowerCase() : ''), cog: isCog(type, href) });
    }
  }
  const collection = str(json.collection);
  return {
    id,
    collection,
    time: Number.isNaN(time) ? null : time,
    cloud: num(properties['eo:cloud_cover']),
    polygons: polygonsOf(json.geometry, bbox),
    bbox,
    thumbnail,
    assets,
    platform: str(properties.platform),
    self: (isRecord(self) && httpUrl(self.href, base)) || '',
  };
}

/** The next-page link of a FeatureCollection (or a catalog's links). */
function nextOf(links: unknown, base?: string): NextLink | null {
  if (!Array.isArray(links)) return null;
  const link = links.find((l) => isRecord(l) && l.rel === 'next');
  if (!isRecord(link)) return null;
  const href = httpUrl(link.href, base);
  if (!href) return null;
  const method = str(link.method).toUpperCase() === 'POST' ? 'POST' : 'GET';
  return { href, method, ...(isRecord(link.body) ? { body: link.body } : {}), merge: link.merge === true };
}

/** A page of `/search` results (an ItemCollection). */
export function parseItemCollection(json: unknown, base?: string): StacPage {
  if (!isRecord(json)) throw new Error('STAC の検索結果以外');
  if (json.type === 'Feature') {
    const item = parseItem(json, base);
    return { items: item ? [item] : [], next: null, matched: item ? 1 : 0 };
  }
  if (!Array.isArray(json.features)) throw new Error(typeof json.description === 'string' ? json.description.slice(0, 300) : 'STAC の検索結果以外');
  const items = json.features.slice(0, MAX_ITEMS).flatMap((f) => parseItem(f, base) ?? []);
  const context = isRecord(json.context) ? json.context : {};
  return { items, next: nextOf(json.links, base), matched: num(json.numberMatched) ?? num(context.matched) };
}

/** The request of the page after `previous`, as its `next` link says. */
export function nextRequest(link: NextLink, previous: StacRequest): StacRequest {
  if (link.method === 'GET') return { url: link.href, method: 'GET' };
  const body = link.merge ? { ...(previous.body ?? {}), ...(link.body ?? {}) } : (link.body ?? previous.body ?? {});
  return { url: link.href, method: 'POST', body };
}

/** The GeoTIFF assets of an item, data first (thumbnails and overviews last). */
export function cogAssets(item: StacItem): StacAsset[] {
  const rank = (a: StacAsset) => (a.roles.includes('visual') || a.key === 'visual' ? 0 : a.roles.includes('overview') || a.roles.includes('thumbnail') ? 2 : 1);
  return item.assets.filter((a) => a.cog).sort((a, b) => rank(a) - rank(b));
}

/** The one-band asset of a common name (red, nir…). */
function bandAsset(item: StacItem, name: string): StacAsset | undefined {
  const assets = cogAssets(item);
  return assets.find((a) => a.commonName === name) ?? (name === 'nir' ? assets.find((a) => a.commonName === 'nir08') : undefined);
}

/** What opening an item opens: one asset, or three in red, green and blue. */
export type AssetChoice = { kind: 'single'; asset: StacAsset } | { kind: 'rgb'; assets: [StacAsset, StacAsset, StacAsset] };

/** A ready-made choice, with its name in the panel. */
export interface AssetPreset {
  id: string;
  label: string;
  choice: AssetChoice;
}

/** A short name of an asset: its key, with its title or bands. */
export function assetLabel(a: StacAsset): string {
  const more = a.title && a.title !== a.key ? a.title : a.bands.join('・');
  return more ? `${a.key}（${more}）` : a.key;
}

/** The choices of an item: true color (`visual`), RGB of the red / green / blue assets, false color, then each asset. */
export function assetPresets(item: StacItem): AssetPreset[] {
  const out: AssetPreset[] = [];
  const assets = cogAssets(item);
  const visual = assets.find((a) => a.key === 'visual') ?? assets.find((a) => a.roles.includes('visual'));
  if (visual) out.push({ id: 'visual', label: `トゥルーカラー（${visual.key}）`, choice: { kind: 'single', asset: visual } });
  const trio = (names: [string, string, string]) => {
    const found = names.map((n) => bandAsset(item, n));
    return found.every(Boolean) ? (found as [StacAsset, StacAsset, StacAsset]) : null;
  };
  const rgb = trio(['red', 'green', 'blue']);
  if (rgb) out.push({ id: 'rgb', label: `RGB 合成（${rgb.map((a) => a.key).join('・')}）`, choice: { kind: 'rgb', assets: rgb } });
  const nrg = trio(['nir', 'red', 'green']);
  if (nrg) out.push({ id: 'false-color', label: `フォールスカラー（${nrg.map((a) => a.key).join('・')}）`, choice: { kind: 'rgb', assets: nrg } });
  for (const a of assets) out.push({ id: `asset:${a.key}`, label: assetLabel(a), choice: { kind: 'single', asset: a } });
  return out;
}

/** What opens by default: `visual`, else red / green / blue as RGB, else the first GeoTIFF; null when nothing can be opened. */
export function defaultChoice(item: StacItem): AssetChoice | null {
  return assetPresets(item)[0]?.choice ?? null;
}

/** Whether an item has the date and cloud cover asked for (for static catalogs, which cannot be searched). */
export function matchesSearch(item: StacItem, search: Pick<StacSearch, 'from' | 'to' | 'maxCloud' | 'collections'>): boolean {
  if (search.maxCloud !== null && item.cloud !== null && item.cloud > search.maxCloud) return false;
  if (search.collections.length && item.collection && !search.collections.includes(item.collection)) return false;
  if (item.time !== null) {
    if (DAY.test(search.from) && item.time < Date.parse(`${search.from}T00:00:00Z`)) return false;
    if (DAY.test(search.to) && item.time > Date.parse(`${search.to}T23:59:59.999Z`)) return false;
  }
  return true;
}

/** Most bytes of a JSON answer. */
const MAX_BYTES = 32 * 1024 * 1024;

/** The headers for `url`: the catalog's own, only when `url` is on the catalog's origin. */
export function headersFor(url: string, catalog: Pick<StacCatalogConfig, 'url' | 'headers'>, base?: string): Record<string, string> {
  if (!catalog.headers) return {};
  try {
    return new URL(url, base).origin === new URL(catalog.url, base).origin ? { ...catalog.headers } : {};
  } catch {
    return {};
  }
}

/** Fetches JSON of a catalog (its headers only to its origin), capped in size. */
export async function fetchStac(request: StacRequest, catalog: Pick<StacCatalogConfig, 'url' | 'headers'>, base?: string, signal?: AbortSignal): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/geo+json, application/json', ...headersFor(request.url, catalog, base) };
  if (request.method === 'POST') headers['Content-Type'] = 'application/json';
  const response = await fetch(request.url, { method: request.method, headers, body: request.method === 'POST' ? JSON.stringify(request.body ?? {}) : undefined, signal, credentials: 'omit' });
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_BYTES) throw new Error('応答が大きすぎ');
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error('応答が大きすぎ');
  if (!response.ok) {
    let detail = '';
    try {
      const json: unknown = JSON.parse(text);
      if (isRecord(json)) detail = str(json.description) || str(json.detail) || str(json.message);
    } catch {
      // not JSON
    }
    throw new HttpError(response.status, detail.slice(0, 300));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('JSON 以外');
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`HTTP ${status}${detail ? `: ${detail}` : ''}`);
  }
}

/**
 * Searches a STAC API: POST `/search`, then GET where POST is not allowed,
 * and without the sort where the API refuses it. Returns the page and the
 * request that got it (for the next page).
 */
export async function searchStac(catalog: StacCatalogConfig, search: StacSearch, base?: string, signal?: AbortSignal): Promise<{ page: StacPage; request: StacRequest }> {
  const url = new URL(searchUrl(catalog.url), base).href;
  let lastError: unknown = null;
  for (const sort of [true, false]) {
    const body = searchBody(search, catalog, sort);
    for (const method of ['POST', 'GET'] as const) {
      const request: StacRequest = method === 'POST' ? { url, method, body } : { url: `${url}?${searchParams(body)}`, method };
      try {
        const page = parseItemCollection(await fetchStac(request, catalog, base, signal), url);
        return { page, request };
      } catch (error) {
        lastError = error;
        // POST not allowed: GET. A bad request (the sort, say): without the sort. Anything else: say so.
        if (!(error instanceof HttpError)) throw error;
        if (method === 'POST' && [404, 405, 501].includes(error.status)) continue;
        if (sort && error.status === 400) break;
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** The next page of a search. */
export async function nextPage(catalog: StacCatalogConfig, link: NextLink, previous: StacRequest, base?: string, signal?: AbortSignal): Promise<{ page: StacPage; request: StacRequest }> {
  const request = nextRequest(link, previous);
  return { page: parseItemCollection(await fetchStac(request, catalog, base, signal), request.url), request };
}

/** One collection of an API, for the panel's choices. */
export interface StacCollection {
  id: string;
  title: string;
}

/** The collections of a STAC API (`/collections`), at most `max`. */
export function parseCollections(json: unknown, max = 200): StacCollection[] {
  if (!isRecord(json) || !Array.isArray(json.collections)) return [];
  return json.collections.slice(0, max).flatMap((c): StacCollection[] => (isRecord(c) && str(c.id) ? [{ id: str(c.id), title: str(c.title) || str(c.id) }] : []));
}

/** Limits of walking a static catalog. */
export interface WalkLimits {
  items: number;
  /** Documents fetched in all. */
  fetches: number;
  /** Levels of `child` links followed. */
  depth: number;
}

export const WALK_LIMITS: WalkLimits = { items: 500, fetches: 100, depth: 4 };

/**
 * The items of a static STAC catalog, collection, item or ItemCollection at
 * `url`: `item` links (and an `items` link's first page) gathered, `child`
 * links followed breadth first, within `limits`. `truncated` says whether a
 * limit was reached.
 */
export async function walkStatic(url: string, fetchJson: (url: string) => Promise<unknown>, limits: WalkLimits = WALK_LIMITS): Promise<{ items: StacItem[]; truncated: boolean }> {
  const items: StacItem[] = [];
  const seen = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [{ url, depth: 0 }];
  let fetches = 0;
  let truncated = false;
  const add = (item: StacItem | null) => {
    if (!item) return;
    if (items.length >= limits.items) truncated = true;
    else items.push(item);
  };
  while (queue.length && items.length < limits.items) {
    const { url: at, depth } = queue.shift()!;
    if (seen.has(at)) continue;
    seen.add(at);
    if (fetches++ >= limits.fetches) {
      truncated = true;
      break;
    }
    const json = await fetchJson(at);
    if (!isRecord(json)) {
      if (at === url) throw new Error('STAC の JSON 以外');
      continue;
    }
    if (json.type === 'Feature') {
      add(parseItem(json, at));
      continue;
    }
    if (json.type === 'FeatureCollection') {
      for (const item of parseItemCollection(json, at).items) add(item);
      continue;
    }
    if (!Array.isArray(json.links)) {
      if (at === url) throw new Error('STAC のカタログ・コレクション・アイテム以外');
      continue;
    }
    // Its items first (in their order), its children after what is already waiting.
    const itemLinks: Array<{ url: string; depth: number }> = [];
    for (const link of json.links) {
      if (!isRecord(link)) continue;
      const href = httpUrl(link.href, at);
      if (!href || seen.has(href)) continue;
      if (link.rel === 'item' || link.rel === 'items') itemLinks.push({ url: href, depth });
      else if (link.rel === 'child') {
        if (depth < limits.depth) queue.push({ url: href, depth: depth + 1 });
        else truncated = true;
      }
    }
    queue.unshift(...itemLinks);
  }
  if (queue.length) truncated = true;
  return { items, truncated };
}

/** Planetary Computer's SAS token endpoint (by storage account and container). */
export const PC_TOKEN_URL = 'https://planetarycomputer.microsoft.com/api/sas/v1/token/';

/**
 * Signs Azure Blob Storage URLs of Planetary Computer with the SAS token of
 * their storage account and container (asked for once, until it expires).
 * The URLs kept by the viewer (layer names, projects) stay unsigned: the
 * token is added only to the requests themselves (see {@link signingFetch}),
 * so it never ends up in a saved project and a project opened later is
 * signed again with a fresh token.
 */
export class PcSigner {
  private readonly tokens_ = new Map<string, Promise<{ token: string | null; expiry: number }>>();

  constructor(private readonly fetchJson: (url: string) => Promise<unknown> = async (url) => (await fetch(url, { credentials: 'omit' })).json()) {}

  /** The account and container of a blob URL that should be signed; null for anything else (or one signed already). */
  static containerOf(href: string): string | null {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    const account = /^([a-z0-9]{3,24})\.blob\.core\.windows\.net$/.exec(url.hostname)?.[1];
    const container = /^\/([a-z0-9-]{3,63})\//.exec(url.pathname)?.[1];
    return url.protocol === 'https:' && account && container && !url.searchParams.has('sig') ? `${account}/${container}` : null;
  }

  /** `href` with its container's token added; as it is for other URLs, or when no token is given (retried after 5 minutes). */
  async sign(href: string): Promise<string> {
    const key = PcSigner.containerOf(href);
    if (!key) return href;
    let entry = this.tokens_.get(key);
    if (entry && (await entry).expiry - 60_000 < Date.now()) entry = undefined;
    if (!entry) {
      entry = this.fetchJson(`${PC_TOKEN_URL}${key}`).then(
        (json) => {
          const token = isRecord(json) ? str(json.token) : '';
          if (!/^[A-Za-z0-9%=&._~:+-]+$/.test(token)) return { token: null, expiry: Date.now() + 5 * 60_000 };
          const expiry = isRecord(json) ? Date.parse(str(json['msft:expiry'])) : NaN;
          return { token, expiry: Number.isNaN(expiry) ? Date.now() + 30 * 60_000 : expiry };
        },
        () => ({ token: null, expiry: Date.now() + 5 * 60_000 }),
      );
      this.tokens_.set(key, entry);
    }
    const { token } = await entry;
    return token ? `${href}${href.includes('?') ? '&' : '?'}${token}` : href;
  }
}

/**
 * `fetch` that signs requests to Planetary Computer's blobs on the way out
 * (the COG reader's range requests among them), leaving every other request
 * as it is.
 */
export function signingFetch(base: typeof fetch, signer: PcSigner): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!PcSigner.containerOf(url)) return base(input, init);
    const signed = await signer.sign(url);
    if (signed === url) return base(input, init);
    return typeof input === 'string' || input instanceof URL ? base(signed, init) : base(new Request(signed, input), init);
  };
}

/** Rows of the information panel for an asset opened from STAC. */
export function stacInfo(item: StacItem, catalog: { label: string }, assets: readonly StacAsset[], timeText: (t: number) => string): Array<[string, string]> {
  const rows: Array<[string, string]> = [['STAC', catalog.label]];
  if (item.collection) rows.push(['コレクション', item.collection]);
  rows.push(['アイテム', item.id]);
  if (item.platform) rows.push(['プラットフォーム', item.platform]);
  if (item.time !== null) rows.push(['撮像日時', timeText(item.time)]);
  if (item.cloud !== null) rows.push(['雲量', `${Math.round(item.cloud * 10) / 10} %`]);
  rows.push(['アセット', assets.map(assetLabel).join('、')]);
  return rows;
}
