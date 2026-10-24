/**
 * What the OGC API readers (Features, Tiles, Coverages) share: where the
 * landing page and a collection are in a URL, links, conformance classes,
 * collections, and reading JSON from a server that may answer HTML to a
 * browser unless asked for JSON.
 */
import type { Extent } from 'ol/extent.js';
import { request, ServiceError } from './common.js';

/** A link of an OGC API document. */
export interface OgcLink {
  href: string;
  rel: string;
  type?: string;
  title?: string;
  templated?: boolean;
}

/** One collection of an OGC API service. */
export interface OgcCollection {
  id: string;
  title: string;
  description?: string;
  /** Longitude / latitude box, when the collection says. */
  bbox: Extent | null;
  /** CRSs the items can be asked for in (OGC API – Features Part 2). */
  crs: string[];
  itemType?: string;
  links: OgcLink[];
  /** Cell counts and sizes of a coverage (`extent.spatial.grid`), x first, when given. */
  grid?: Array<{ cellsCount?: number; resolution?: number }>;
}

/** Conformance classes the readers look for. */
export const conformance = {
  featuresCore: /\/ogcapi-features-1\/[\d.]+\/conf\/core$/,
  crs: /\/ogcapi-features-2\/[\d.]+\/conf\/crs$/,
  filter: /\/ogcapi-features-3\/[\d.]+\/conf\/(features-)?filter$/,
  cql2Text: /\/cql2\/[\d.]+\/conf\/cql2-text$/,
  /** Part 4: POST, PUT and DELETE of items. */
  edit: /\/ogcapi-features-4\/[\d.]+\/conf\/create-replace-delete$/,
  tiles: /\/ogcapi-tiles-1\/[\d.]+\/conf\/core$/,
  coverages: /\/ogcapi-coverages-1\/[\d.]+\/conf\/(core|geodata-coverage)$/,
};

/** Whether `classes` conform to `pattern`. */
export function conformsTo(classes: readonly string[], pattern: RegExp): boolean {
  return classes.some((c) => pattern.test(c.trim()));
}

/** The OGC API names of the CRS every server knows. */
export const CRS84 = 'http://www.opengis.net/def/crs/OGC/1.3/CRS84';

/**
 * Splits a URL into the landing page and the collection it names, if any:
 * `…/collections/{id}` (or its `/items`, `/coverage`, `/tiles…`) names one.
 * Query parameters other than `f` (an API key) are kept for every request.
 */
export function splitOgcUrl(url: string): { landing: string; collection: string | null; query: URLSearchParams } {
  const u = new URL(url, globalThis.location?.href);
  const query = new URLSearchParams(u.search);
  for (const key of [...query.keys()]) if (key.toLowerCase() === 'f') query.delete(key);
  const path = u.pathname.replace(/\/+$/, '');
  const m = /^(.*?)\/collections(?:\/([^/]+)(?:\/.*)?)?$/.exec(path);
  const landingPath = m ? m[1] : path.replace(/\/(conformance|api)$/, '');
  let collection: string | null = null;
  if (m?.[2]) {
    try {
      collection = decodeURIComponent(m[2]);
    } catch {
      collection = m[2];
    }
  }
  return { landing: `${u.origin}${landingPath}`, collection, query };
}

/** `base` + `path`, with the kept query parameters and `params`. */
export function ogcUrl(base: string, path: string, query: URLSearchParams, params: Record<string, string | number | undefined> = {}): string {
  const u = new URL(base.replace(/\/+$/, '') + path);
  for (const [k, v] of query) u.searchParams.set(k, v);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v));
  return u.href;
}

/** The link of `links` with one of `rels` (full URIs or their last part, as `[ogc-rel:…]` CURIEs write it) and, by preference, one of `types`. */
export function findLink(links: readonly OgcLink[], rels: readonly string[], types: readonly RegExp[] = []): OgcLink | undefined {
  const relOf = (rel: string) => rel.replace(/^\[ogc-rel:(.*)\]$/, '$1').replace(/^.*\/def\/rel\/(?:ogc|iana)\/[\d.]+\//, '');
  const matching = links.filter((l) => rels.includes(l.rel) || rels.includes(relOf(l.rel)));
  for (const type of types) {
    const found = matching.find((l) => l.type && type.test(l.type));
    if (found) return found;
  }
  return matching[0];
}

/** `links` of a JSON document, kept when they have an href and a rel; relative hrefs resolved against `base`. */
export function linksOf(value: unknown, base: string): OgcLink[] {
  if (!Array.isArray(value)) return [];
  const links: OgcLink[] = [];
  for (const l of value) {
    if (!isRecord(l) || typeof l.href !== 'string' || typeof l.rel !== 'string') continue;
    let href: string;
    try {
      // Templates keep their braces: `new URL` would escape them.
      href = /^https?:\/\//i.test(l.href) ? l.href : new URL(l.href, base).href.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(href)) continue;
    links.push({ href, rel: l.rel, type: typeof l.type === 'string' ? l.type : undefined, title: typeof l.title === 'string' ? l.title : undefined, templated: l.templated === true });
  }
  return links;
}

/** The collections of a `/collections` document (or one collection's document). */
export function parseCollections(json: unknown, base: string): OgcCollection[] {
  if (!isRecord(json)) return [];
  const list = Array.isArray(json.collections) ? json.collections : typeof json.id === 'string' ? [json] : [];
  const out: OgcCollection[] = [];
  for (const c of list) {
    if (!isRecord(c) || typeof c.id !== 'string' || !c.id) continue;
    const spatial = isRecord(c.extent) && isRecord(c.extent.spatial) ? c.extent.spatial : null;
    const box = spatial && Array.isArray(spatial.bbox) ? (Array.isArray(spatial.bbox[0]) ? spatial.bbox[0] : spatial.bbox) : null;
    const bbox = Array.isArray(box) && box.length >= 4 && box.every((n) => typeof n === 'number' && Number.isFinite(n)) ? (box.length >= 6 ? [box[0], box[1], box[3], box[4]] : box.slice(0, 4)) : null;
    const grid = spatial && Array.isArray(spatial.grid) ? spatial.grid.filter(isRecord).map((g) => ({ cellsCount: num(g.cellsCount), resolution: num(g.resolution) })) : undefined;
    out.push({
      id: c.id,
      title: typeof c.title === 'string' && c.title ? c.title : c.id,
      description: typeof c.description === 'string' ? c.description : undefined,
      bbox: bbox as Extent | null,
      crs: Array.isArray(c.crs) ? c.crs.filter((s): s is string => typeof s === 'string') : [],
      itemType: typeof c.itemType === 'string' ? c.itemType : undefined,
      links: linksOf(c.links, base),
      ...(grid?.length ? { grid } : {}),
    });
  }
  return out;
}

/** The conformance classes of a `/conformance` document (or a landing page that lists them). */
export function parseConformance(json: unknown): string[] {
  return isRecord(json) && Array.isArray(json.conformsTo) ? json.conformsTo.filter((s): s is string => typeof s === 'string') : [];
}

/** The largest JSON document read (a page of items, a collection list). */
const MAX_JSON_BYTES = 200 * 1024 * 1024;

/**
 * Reads JSON at `url`. Servers that answer browsers with HTML are asked
 * again with `f=json`.
 */
export async function fetchJson(url: string, accept = 'application/json'): Promise<unknown> {
  const read = async (u: string) => {
    const response = await request(u, { headers: { Accept: accept } });
    if (Number(response.headers.get('content-length') ?? 0) > MAX_JSON_BYTES) throw new ServiceError('応答が大きすぎ');
    return response.text();
  };
  let text = await read(url);
  if (/^\s*</.test(text)) {
    const u = new URL(url);
    u.searchParams.set('f', 'json');
    text = await read(u.href);
  }
  if (text.length > MAX_JSON_BYTES) throw new ServiceError('応答が大きすぎ');
  try {
    return JSON.parse(text);
  } catch {
    throw new ServiceError('応答が JSON 以外');
  }
}

/** A landing page read: its title, conformance classes, links and collections. */
export interface OgcService {
  landing: string;
  query: URLSearchParams;
  title: string;
  classes: string[];
  links: OgcLink[];
  collections: OgcCollection[];
  /** The collection the URL named, when it named one. */
  named: string | null;
}

/** Reads the landing page, conformance and collections of the service at `url`. */
export async function readOgcService(url: string): Promise<OgcService> {
  const { landing, collection, query } = splitOgcUrl(url);
  const root = await fetchJson(ogcUrl(landing, '/', query)).catch(() => null);
  const links = linksOf(isRecord(root) ? root.links : null, landing + '/');
  const conformanceLink = findLink(links, ['conformance', 'http://www.opengis.net/def/rel/ogc/1.0/conformance']);
  const classesJson = isRecord(root) && Array.isArray(root.conformsTo) ? root : await fetchJson(conformanceLink?.href ?? ogcUrl(landing, '/conformance', query)).catch(() => null);
  const classes = parseConformance(classesJson);
  const dataLink = findLink(links, ['data', 'http://www.opengis.net/def/rel/ogc/1.0/data'], [/json/]);
  const collectionsUrl = dataLink?.href ?? ogcUrl(landing, '/collections', query);
  let collections: OgcCollection[];
  if (collection) {
    const one = ogcUrl(landing, `/collections/${encodeURIComponent(collection)}`, query);
    collections = parseCollections(await fetchJson(one), one);
  } else {
    collections = parseCollections(await fetchJson(collectionsUrl), collectionsUrl);
  }
  if (!root && collections.length === 0) throw new ServiceError('OGC API のランディングページでもコレクションでもなし');
  return {
    landing,
    query,
    title: (isRecord(root) && typeof root.title === 'string' && root.title) || landing,
    classes,
    links,
    collections,
    named: collection,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
