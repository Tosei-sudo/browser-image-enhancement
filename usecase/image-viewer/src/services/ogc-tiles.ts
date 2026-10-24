/**
 * OGC API – Tiles: the tilesets of a landing page (the whole dataset) and of
 * its collections, in the WebMercatorQuad tile matrix set. Vector tiles
 * (Mapbox vector tiles) are drawn in the layer's color; map tiles (PNG,
 * JPEG) are one picture layer, corrected on the GPU like WMTS.
 */
import VectorTileLayer from 'ol/layer/VectorTile.js';
import VectorTileSource from 'ol/source/VectorTile.js';
import MVT from 'ol/format/MVT.js';
import { createXYZ } from 'ol/tilegrid.js';
import { transformExtent } from 'ol/proj.js';
import type { Extent } from 'ol/extent.js';
import { nextColor, ServiceError, type LayerChoice, type OpenContext, type ServiceCatalog, type ServiceLayer } from './common.js';
import { fetchJson, findLink, isRecord, linksOf, readOgcService, type OgcLink, type OgcService } from './ogc-api.js';
import { pictureTiles } from './raster.js';
import { singleSpec, styleFunction } from '../vector-style.js';

/** The choice of the dataset's own tiles (not a collection's). */
export const DATASET = '*';
export const MVT_TYPE = 'application/vnd.mapbox-vector-tile';
const VECTOR_RELS = ['tilesets-vector', 'http://www.opengis.net/def/rel/ogc/1.0/tilesets-vector'];
const MAP_RELS = ['tilesets-map', 'http://www.opengis.net/def/rel/ogc/1.0/tilesets-map'];

/** One tileset of a tileset list. */
export interface Tileset {
  dataType: 'vector' | 'map' | 'coverage' | string;
  /** The tile matrix set's URI or id. */
  matrixSet: string;
  links: OgcLink[];
  /** The deepest tile matrix with tiles (from `tileMatrixSetLimits`). */
  maxZoom?: number;
  minZoom?: number;
}

/** Reads the tilesets offered at `url` (a landing page or a collection). */
export async function readOgcTiles(url: string): Promise<ServiceCatalog> {
  const service = await readOgcService(url);
  const formatsOf = (links: OgcLink[]) => [...(findLink(links, VECTOR_RELS) ? [MVT_TYPE] : []), ...(findLink(links, MAP_RELS) ? ['image/png', 'image/jpeg'] : [])];
  const choices: LayerChoice[] = [];
  const own = service.named ? [] : formatsOf(service.links);
  if (own.length) choices.push({ name: DATASET, title: `${service.title}（データセット全体）`, formats: own });
  for (const c of service.collections) {
    const formats = formatsOf(c.links);
    if (formats.length) choices.push({ name: c.id, title: c.title, abstract: c.description, formats });
  }
  if (choices.length === 0) throw new ServiceError('タイルを持つコレクションなし');
  return {
    kind: 'ogc-tiles',
    url,
    title: service.title,
    choices,
    open: async (choice, context, pick = {}) => openTiles(service, url, choice, pick.format ?? choice.formats?.[0] ?? MVT_TYPE, context),
  };
}

/** The tilesets of a tileset list document. */
export function parseTilesets(json: unknown, base: string): Tileset[] {
  if (!isRecord(json)) return [];
  const list = Array.isArray(json.tilesets) ? json.tilesets : json.tileMatrixSetURI || json.tileMatrixSetId ? [json] : [];
  return list.filter(isRecord).map((t) => {
    const limits = Array.isArray(t.tileMatrixSetLimits) ? t.tileMatrixSetLimits.filter(isRecord).map((l) => Number(l.tileMatrix)).filter(Number.isInteger) : [];
    return {
      dataType: typeof t.dataType === 'string' ? t.dataType : '',
      matrixSet: typeof t.tileMatrixSetURI === 'string' ? t.tileMatrixSetURI : typeof t.tileMatrixSetId === 'string' ? t.tileMatrixSetId : typeof t.tileMatrixSet === 'string' ? t.tileMatrixSet : '',
      links: linksOf(t.links, base),
      ...(limits.length ? { maxZoom: Math.max(...limits), minZoom: Math.min(...limits) } : {}),
    };
  });
}

/** Whether a tileset is in WebMercatorQuad (by its URI, id, or the `self` link's last part). */
export function isWebMercatorQuad(tileset: Tileset): boolean {
  const self = findLink(tileset.links, ['self'])?.href ?? '';
  return /WebMercatorQuad$/i.test(tileset.matrixSet) || /\/WebMercatorQuad(\?|$)/i.test(self);
}

/** The URL of a tile from an `item` template: `{tileMatrix}/{tileRow}/{tileCol}` (or `{z}/{y}/{x}`). */
export function tileUrl(template: string, z: number, x: number, y: number): string {
  return template
    .replace(/\{(tileMatrix|z)\}/g, String(z))
    .replace(/\{(tileRow|y)\}/g, String(y))
    .replace(/\{(tileCol|x)\}/g, String(x));
}

/** The `item` template of `tileset` for `type` (MVT, or a picture type: the asked one first). */
export function itemTemplate(tileset: Tileset, type: string): string | undefined {
  const items = tileset.links.filter((l) => l.rel === 'item' || /\/tile$/.test(l.rel));
  if (type === MVT_TYPE) return (items.find((l) => l.type && /mapbox-vector-tile|mvt|pbf/i.test(l.type)) ?? items.find((l) => !l.type))?.href;
  return (items.find((l) => l.type === type) ?? items.find((l) => l.type && /^image\//.test(l.type)) ?? items.find((l) => !l.type))?.href;
}

async function openTiles(service: OgcService, url: string, choice: LayerChoice, format: string, context: OpenContext): Promise<ServiceLayer> {
  const vector = format === MVT_TYPE;
  const collection = service.collections.find((c) => c.id === choice.name);
  const links = choice.name === DATASET ? service.links : collection?.links ?? [];
  const listLink = findLink(links, vector ? VECTOR_RELS : MAP_RELS, [/json/]);
  if (!listLink) throw new ServiceError(vector ? 'ベクタータイルなし' : '地図タイルなし');
  const tilesets = parseTilesets(await fetchJson(listLink.href), listLink.href).filter((t) => !t.dataType || t.dataType === (vector ? 'vector' : 'map'));
  let tileset = tilesets.find(isWebMercatorQuad);
  if (!tileset) throw new ServiceError('WebMercatorQuad のタイルなし');
  let template = itemTemplate(tileset, format);
  if (!template || tileset.maxZoom === undefined) {
    // The list may leave the templates and limits to each tileset's own document.
    const self = findLink(tileset.links, ['self'], [/json/]) ?? findLink(tileset.links, ['self']);
    if (self) {
      const full = parseTilesets(await fetchJson(self.href), self.href)[0];
      if (full) {
        tileset = { ...full, matrixSet: full.matrixSet || tileset.matrixSet };
        template = itemTemplate(tileset, format) ?? template;
      }
    }
  }
  if (!template) throw new ServiceError('タイルの URL が不明');
  const maxZoom = Math.min(tileset.maxZoom ?? 22, 24);
  const minZoom = Math.max(tileset.minZoom ?? 0, 0);
  const tileGrid = createXYZ({ maxZoom, minZoom });
  const box = collection?.bbox ?? null;
  const extent: Extent | null = box ? transformExtent([box[0], Math.max(box[1], -85), box[2], Math.min(box[3], 85)], 'EPSG:4326', 'EPSG:3857') : null;
  const at = template;
  const service_: ServiceLayer = {
    ref: { kind: 'ogc-tiles', url, layer: choice.name, format },
    badge: 'OGC',
    title: choice.title,
    layer: undefined!,
    correction: null,
    vector: null,
    extent,
    info: [
      ['種類', `OGC API – Tiles（${vector ? 'ベクタータイル' : '地図タイル'}）`],
      ['URL', url],
      ['コレクション', choice.name === DATASET ? '（データセット全体）' : choice.name],
      ['タイル行列セット', 'WebMercatorQuad'],
      ['形式', format],
      ['ズーム', `${minZoom}〜${maxZoom}`],
    ],
  };
  if (vector) {
    service_.layer = new VectorTileLayer({
      source: new VectorTileSource({ format: new MVT(), tileGrid, tileUrlFunction: ([z, x, y]) => tileUrl(at, z, x, y), wrapX: false }),
      style: styleFunction(singleSpec(nextColor())),
      declutter: false,
    });
    return service_;
  }
  const tiles = pictureTiles({
    url: (z, x, y) => tileUrl(at, z, x, y),
    tileGrid,
    projection: 'EPSG:3857',
    gpu: context.gpu,
    onNoCors: () => context.say(`${choice.title}: サーバーが CORS 非許可のため、補正なしで表示`),
  });
  service_.layer = tiles.layer;
  Object.defineProperty(service_, 'correction', { get: tiles.correction });
  return service_;
}
