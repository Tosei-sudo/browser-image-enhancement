/**
 * Place names and addresses for the jump field (地名・住所検索). Where to
 * ask is set in `config.json` (`geocoders`), in order, and every one is
 * asked at once:
 *
 * - `gsi`: 国土地理院's address search (地名・住所, Japan). The default.
 * - `nominatim`: OpenStreetMap's Nominatim, or a server of one's own.
 * - `arcgis`: an ArcGIS geocode service (`…/GeocodeServer`).
 * - `features`: an Esri feature layer of named places, searched by an
 *   attribute (`field`), for a closed network.
 * - `csv`: a CSV of names with latitude and longitude, read once and
 *   searched in the browser, for a closed network without any server.
 *
 * `"geocoders": []` turns place search off, so nothing typed leaves the page.
 */
import { decodeCsv, parseCsv } from './csv.js';
import type { LonLat } from './coordinates.js';
import { esriJson } from './services/esri.js';

export type GeocoderType = 'gsi' | 'nominatim' | 'arcgis' | 'features' | 'csv';

export interface GeocoderConfig {
  type: GeocoderType;
  /** Shown beside each place it finds. */
  label: string;
  url: string;
  /** Esri services that need one. */
  token?: string;
  /** `features`: the attribute holding the name. `csv`: the column of names (else the first that reads as one). */
  field?: string;
}

/** One place found. */
export interface Place {
  name: string;
  /** More about it (an address, a kind), when the service says. */
  detail?: string;
  lonLat: LonLat;
  /** Its extent as [west, south, east, north], when known (a town, a building). */
  extent?: [number, number, number, number];
  /** The geocoder's label. */
  source: string;
}

/** What `config.json` gets without a `geocoders` entry. */
export const DEFAULT_GEOCODERS: GeocoderConfig[] = [{ type: 'gsi', label: '地理院', url: 'https://msearch.gsi.go.jp/address-search/AddressSearch' }];

/** Most places shown from each geocoder. */
const LIMIT = 8;

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN);
const valid = ([lon, lat]: LonLat) => Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/** 国土地理院 AddressSearch: GeoJSON-like features with a `title`. */
export function parseGsi(json: unknown, source: string): Place[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((f): Place[] => {
    const c = f?.geometry?.coordinates;
    const name = f?.properties?.title;
    if (!Array.isArray(c) || typeof name !== 'string') return [];
    const lonLat: LonLat = [num(c[0]), num(c[1])];
    return valid(lonLat) ? [{ name, lonLat, source }] : [];
  });
}

/** Nominatim (`format=jsonv2`): `display_name`, `lat` / `lon` and a bounding box (south, north, west, east). */
export function parseNominatim(json: unknown, source: string): Place[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((p): Place[] => {
    const lonLat: LonLat = [num(p?.lon), num(p?.lat)];
    if (!valid(lonLat) || typeof p?.display_name !== 'string') return [];
    const [name, ...rest] = p.display_name.split(', ');
    const b = Array.isArray(p.boundingbox) ? p.boundingbox.map(num) : [];
    const extent: Place['extent'] = b.length === 4 && b.every(Number.isFinite) ? [b[2], b[0], b[3], b[1]] : undefined;
    return [{ name, detail: [p.type, ...rest].filter(Boolean).join('、'), lonLat, ...(extent ? { extent } : {}), source }];
  });
}

/** ArcGIS `findAddressCandidates` (asked with outSR 4326): candidates with a location and an extent. */
export function parseArcgis(json: unknown, source: string): Place[] {
  const candidates = (json as { candidates?: unknown })?.candidates;
  if (!Array.isArray(candidates)) return [];
  return candidates.flatMap((c): Place[] => {
    const lonLat: LonLat = [num(c?.location?.x), num(c?.location?.y)];
    if (!valid(lonLat) || typeof c?.address !== 'string') return [];
    const e = c.extent;
    const extent: Place['extent'] = e && [e.xmin, e.ymin, e.xmax, e.ymax].every((v) => Number.isFinite(num(v))) ? [num(e.xmin), num(e.ymin), num(e.xmax), num(e.ymax)] : undefined;
    return [{ name: c.address, ...(c.attributes?.Type ? { detail: String(c.attributes.Type) } : {}), lonLat, ...(extent ? { extent } : {}), source }];
  });
}

/** An Esri layer's query (outSR 4326, `returnCentroid` or point geometry): each feature's name and where it is. */
export function parseFeatures(json: unknown, field: string, source: string): Place[] {
  const features = (json as { features?: unknown })?.features;
  if (!Array.isArray(features)) return [];
  return features.flatMap((f): Place[] => {
    const name = f?.attributes?.[field];
    if (name === null || name === undefined) return [];
    const g = f.geometry ?? {};
    const at = f.centroid ?? (Number.isFinite(num(g.x)) ? g : null);
    let lonLat: LonLat = at ? [num(at.x), num(at.y)] : [NaN, NaN];
    let extent: Place['extent'];
    // Lines and polygons without a centroid: the middle of their extent.
    const coords: number[][] = (g.rings ?? g.paths ?? []).flat();
    if (coords.length) {
      const xs = coords.map((c) => c[0]);
      const ys = coords.map((c) => c[1]);
      extent = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      if (!valid(lonLat)) lonLat = [(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2];
    }
    return valid(lonLat) ? [{ name: String(name), lonLat, ...(extent ? { extent } : {}), source }] : [];
  });
}

/** Folds what people type differently: width (NFKC), case, katakana to hiragana, spaces. */
export function foldName(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/\s+/g, '');
}

/** A CSV gazetteer: its rows' names (folded, for searching) and places. */
export interface Gazetteer {
  rows: Array<{ key: string; place: Place }>;
}

/** Reads a CSV of places: a name column, latitude and longitude columns (found by their names), the rest as detail. */
export function readGazetteer(text: string, source: string, nameField?: string): Gazetteer {
  const [head = [], ...rows] = parseCsv(text);
  const index = (pattern: RegExp) => head.findIndex((h) => pattern.test(h.trim()));
  const lat = index(/^(lat|latitude|緯度|y)$/i);
  const lon = index(/^(lon|lng|long|longitude|経度|x)$/i);
  let name = nameField ? head.findIndex((h) => h.trim() === nameField) : index(/^(name|名称|名前|地名|title)$/i);
  if (name < 0) name = head.findIndex((_, i) => i !== lat && i !== lon);
  if (lat < 0 || lon < 0 || name < 0) throw new Error(`${source}: 名前・緯度（lat）・経度（lon）の列が見つかりません`);
  const others = head.map((_, i) => i).filter((i) => i !== lat && i !== lon && i !== name);
  return {
    rows: rows.flatMap((r) => {
      const lonLat: LonLat = [num(r[lon]), num(r[lat])];
      const label = r[name]?.trim();
      if (!label || !valid(lonLat)) return [];
      const detail = others
        .map((i) => r[i]?.trim())
        .filter(Boolean)
        .join('、');
      return [{ key: foldName(label), place: { name: label, ...(detail ? { detail } : {}), lonLat, source } }];
    }),
  };
}

/** The gazetteer's places whose names hold `query`: names starting with it first, then shorter names. */
export function searchGazetteer(gazetteer: Gazetteer, query: string, limit = LIMIT): Place[] {
  const q = foldName(query);
  if (!q) return [];
  return gazetteer.rows
    .flatMap((r) => {
      const at = r.key.indexOf(q);
      return at < 0 ? [] : [{ r, rank: (at === 0 ? 0 : 1000) + r.key.length }];
    })
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map(({ r }) => r.place);
}

/** Escapes a text for a SQL LIKE pattern in single quotes. */
function likeText(text: string): string {
  return text.replace(/'/g, "''").replace(/[%_]/g, (c) => `\\${c}`);
}

/** The place search of the viewer: every geocoder asked at once, their places in the order of the geocoders. */
export class PlaceSearch {
  private readonly gazetteers_ = new Map<string, Promise<Gazetteer>>();

  constructor(
    readonly geocoders: readonly GeocoderConfig[],
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  get enabled(): boolean {
    return this.geocoders.length > 0;
  }

  /** Places for `query`; a geocoder that fails gives none (its error is in `errors`). */
  async search(query: string, signal?: AbortSignal): Promise<{ places: Place[]; errors: string[] }> {
    const q = query.trim();
    if (!q) return { places: [], errors: [] };
    const results = await Promise.allSettled(this.geocoders.map((g) => this.ask_(g, q, signal)));
    const places: Place[] = [];
    const errors: string[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') places.push(...r.value.slice(0, LIMIT));
      else if (!signal?.aborted) errors.push(`${this.geocoders[i].label}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    });
    return { places, errors };
  }

  private async json_(url: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  private async ask_(g: GeocoderConfig, q: string, signal?: AbortSignal): Promise<Place[]> {
    const base = g.url.replace(/\/+$/, '');
    switch (g.type) {
      case 'gsi':
        return parseGsi(await this.json_(`${base}?q=${encodeURIComponent(q)}`, signal), g.label);
      case 'nominatim': {
        const url = /\/search$/.test(base) ? base : `${base}/search`;
        return parseNominatim(await this.json_(`${url}?q=${encodeURIComponent(q)}&format=jsonv2&limit=${LIMIT}&accept-language=ja`, signal), g.label);
      }
      case 'arcgis': {
        const params = { SingleLine: q, outSR: '4326', maxLocations: String(LIMIT), outFields: 'Type' };
        return parseArcgis(await esriJson(`${base}/findAddressCandidates`, params, g.token), g.label);
      }
      case 'features': {
        const field = g.field!;
        const params = {
          where: `${field} LIKE '%${likeText(q)}%' ESCAPE '\\'`,
          outFields: field,
          returnGeometry: 'true',
          returnCentroid: 'true',
          outSR: '4326',
          resultRecordCount: String(LIMIT),
        };
        return parseFeatures(await esriJson(`${base}/query`, params, g.token), field, g.label);
      }
      case 'csv': {
        let gazetteer = this.gazetteers_.get(g.url);
        if (!gazetteer) {
          gazetteer = this.fetchImpl(g.url)
            .then((r) => {
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              return r.arrayBuffer();
            })
            .then((b) => readGazetteer(decodeCsv(new Uint8Array(b)).text, g.label, g.field));
          // A failure is tried again next time.
          gazetteer.catch(() => this.gazetteers_.delete(g.url));
          this.gazetteers_.set(g.url, gazetteer);
        }
        return searchGazetteer(await gazetteer, q);
      }
    }
  }
}
