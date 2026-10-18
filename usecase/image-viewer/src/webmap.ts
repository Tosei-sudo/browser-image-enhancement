/**
 * ArcGIS Web Maps (the JSON of a portal's 「Web Map」 item, version 2.x),
 * read into what the viewer opens and written from what it has open. Only
 * data in and data out here; webmap-dialog.ts fetches, opens and saves.
 *
 * Reading: the operational layers (feature, map, image, tiled map, vector
 * tile, WMS, WMTS, WFS and web tiled layers; group layers flattened; feature
 * collections stored in the map) with their visibility, opacity, scale range,
 * definition expression and renderer; the base map; the initial extent; the
 * bookmarks. What the viewer cannot show is listed, with the reason.
 *
 * Writing: the layers that have a service URL as service layers, vector
 * layers without one (files, temporary layers) as feature collections
 * (capped in size), the view, the base map and the styles as renderers.
 */
import type Feature from 'ol/Feature.js';
import EsriJSON from 'ol/format/EsriJSON.js';
import { asArray } from 'ol/color.js';
import type { BaseMapConfig } from './config.js';
import type { Bookmark } from './bookmarks.js';
import type { EsriRenderer, EsriSymbol } from './services/esri.js';
import type { Field, ServiceRef } from './services/common.js';
import type { EsriRasterSettings } from './services/esri-rules.js';
import { MAX_CATEGORIES, MAX_CLASSES, ownSpec, settleColorTarget, singleSpec, strokeBeside, symbolOfClass, type LineDash, type PointShape, type SymbolSpec, type VectorStyleSpec } from './vector-style.js';

/** The web map version written. */
export const WEBMAP_VERSION = '2.31';
/** The most features one feature collection of a saved web map holds. */
export const MAX_COLLECTION_FEATURES = 5_000;
/** The largest web map written (JSON characters): portals refuse much larger item data. */
export const MAX_WEBMAP_CHARS = 10_000_000;
/** The largest web map read (characters). */
export const MAX_WEBMAP_READ = 50_000_000;

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const ITEM_ID = /^[0-9a-f]{32}$/i;

// ---- Where a web map is ----

/** A web map item of a portal. */
export interface WebMapItemRef {
  /** The portal's root (`https://www.arcgis.com`, `https://gis.example.com/portal`), without a trailing slash. */
  portal: string;
  id: string;
}

/** ArcGIS Online, for an item id typed without a portal. */
export const DEFAULT_PORTAL = 'https://www.arcgis.com';

/**
 * The item a typed text names: an item page (`…/home/item.html?id=…`), a
 * Map Viewer link (`…/apps/mapviewer/index.html?webmap=…`,
 * `…/home/webmap/viewer.html?webmap=…`), a REST URL of the item
 * (`…/sharing/rest/content/items/…`), or a bare item id on `portal`.
 */
export function parseItemInput(input: string, portal = DEFAULT_PORTAL): WebMapItemRef | null {
  const text = input.trim();
  if (ITEM_ID.test(text)) {
    const root = portalRoot(portal);
    return root ? { portal: root, id: text.toLowerCase() } : null;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const params = url.searchParams;
  const rest = /^(.*?)\/sharing\/rest\/content\/items\/([0-9a-f]{32})(?:\/|$)/i.exec(url.pathname);
  const id = rest?.[2] ?? [params.get('webmap'), params.get('id'), params.get('itemId')].find((v): v is string => !!v && ITEM_ID.test(v));
  if (!id) return null;
  const path = rest ? rest[1] : /^(.*?)\/(?:home|apps)\//i.exec(url.pathname)?.[1];
  if (path === undefined) return null;
  return { portal: `${url.origin}${path.replace(/\/+$/, '')}`, id: id.toLowerCase() };
}

/** A portal URL typed: its root without a trailing slash (and without `/home…` or `/sharing…`), or null. */
export function portalRoot(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const path = url.pathname.replace(/\/(?:home|apps|sharing)(?:\/.*)?$/i, '').replace(/\/+$/, '');
    return `${url.origin}${path}`;
  } catch {
    return null;
  }
}

/** The REST URL of an item, its data, and a user's content. */
export const itemUrl = (ref: WebMapItemRef) => `${ref.portal}/sharing/rest/content/items/${ref.id}`;
export const itemDataUrl = (ref: WebMapItemRef) => `${itemUrl(ref)}/data`;
export const userContentUrl = (portal: string, user: string, folder?: string) =>
  `${portal}/sharing/rest/content/users/${encodeURIComponent(user)}${folder ? `/${encodeURIComponent(folder)}` : ''}`;

/**
 * Whether a token typed for `portal` may go with requests to `url`: to the
 * portal's own host, and from ArcGIS Online to its hosted services
 * (`*.arcgis.com`). Never to other hosts.
 */
export function tokenAllowed(url: string, portal: string): boolean {
  try {
    const target = new URL(url);
    const home = new URL(portal);
    // Plain http only to a portal that is itself on http (a test or closed network), never downgrading from https.
    if (target.protocol !== 'https:' && !(target.protocol === 'http:' && home.protocol === 'http:' && target.host === home.host)) return false;
    if (target.host === home.host) return true;
    const online = (host: string) => host === 'arcgis.com' || host.endsWith('.arcgis.com');
    return online(home.hostname) && online(target.hostname);
  } catch {
    return false;
  }
}

// ---- Reading ----

/** What every layer of a web map read has. */
interface LayerBase {
  /** The web map's id of the layer, when it has one. */
  id?: string;
  title: string;
  visible: boolean;
  /** 0–1. */
  opacity: number;
  /** Hidden when zoomed out beyond 1:minScale (Esri scale); null: no limit. */
  minScale: number | null;
  /** Hidden when zoomed in beyond 1:maxScale (Esri scale); null: no limit. */
  maxScale: number | null;
  /** The layer as the web map has it, to write it back unchanged when the viewer cannot make it again. */
  source: Json;
}

/** A layer of a web map, as the viewer will open it. */
export type WebMapLayer = LayerBase &
  (
    | {
        /** A service layer: Esri feature (`ref.url` the layer), map or image service, WMS, WMTS or WFS. */
        type: 'service';
        ref: ServiceRef;
        /** Esri: the token goes with it (the web map names an Esri service). */
        esri: boolean;
        /** A feature layer's renderer and label field in the web map (overriding the service's). */
        renderer?: EsriRenderer;
        labelField?: string | null;
      }
    | { type: 'tiles'; urls: string[]; attributions?: string }
    | { type: 'vector-tiles'; url: string; style?: string }
    | { type: 'collection'; parts: CollectionPart[] }
  );

/** One layer of a feature collection stored in a web map. */
export interface CollectionPart {
  name: string;
  geometryType: string;
  fields: Array<{ name: string; type: string; alias?: string; length?: number }>;
  renderer?: EsriRenderer;
  labelField?: string | null;
  /** Esri JSON features and their spatial reference. */
  features: Json[];
  wkid: number;
}

/** A rectangle as the web map writes it. */
export interface WebMapExtent {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  wkid: number;
}

/** A web map, read. */
export interface WebMapPlan {
  /** Operational layers, bottom first. */
  layers: WebMapLayer[];
  basemap: { title: string; layers: Array<WebMapLayer & { reference: boolean }>; source: Json | null };
  /** What cannot be shown, with why. */
  unsupported: Array<{ title: string; reason: string }>;
  extent: WebMapExtent | null;
  bookmarks: Array<{ name: string; extent: WebMapExtent }>;
}

const unsupportedReasons: Record<string, string> = {
  CSV: 'CSV レイヤーには対応していません',
  GeoJSON: 'GeoJSON レイヤーには対応していません（ファイルとして開いてください）',
  KML: 'KML レイヤーには対応していません',
  GeoRSS: 'GeoRSS レイヤーには対応していません',
  OGCFeatureLayer: 'OGC API - Features には対応していません',
  ArcGISSceneServiceLayer: 'シーンレイヤーは 3D 表示の「3D タイル」から開いてください',
  IntegratedMeshLayer: '統合メッシュには対応していません',
  PointCloudLayer: '点群には対応していません',
  BuildingSceneLayer: 'ビルディングシーンレイヤーには対応していません',
  ArcGISStreamLayer: 'ストリームレイヤーには対応していません',
  SubtypeGroupLayer: 'サブタイプグループレイヤーには対応していません',
  BingMapsAerial: 'Bing Maps には対応していません',
  BingMapsRoad: 'Bing Maps には対応していません',
  BingMapsHybrid: 'Bing Maps には対応していません',
  MediaLayer: 'メディアレイヤーには対応していません',
  ArcGISImageServiceVectorLayer: 'ベクターフィールドの表示には対応していません',
  KnowledgeGraphLayer: 'ナレッジグラフには対応していません',
};

/** Reads a web map's JSON; anything malformed is skipped and listed, never thrown, except a document that is not a web map. */
export function planWebMap(json: unknown): WebMapPlan {
  if (!isRecord(json) || (!Array.isArray(json.operationalLayers) && !isRecord(json.baseMap))) throw new Error('Web マップの JSON ではありません（operationalLayers・baseMap がありません）');
  const unsupported: WebMapPlan['unsupported'] = [];
  const layers: WebMapLayer[] = [];
  const walk = (list: unknown, parent: { visible: boolean; opacity: number; minScale: number | null; maxScale: number | null }) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!isRecord(item)) continue;
      const base = layerBase(item, parent);
      if (item.layerType === 'GroupLayer') {
        walk(item.layers, base);
        continue;
      }
      const read = readLayer(item, base);
      if ('reason' in read) unsupported.push({ title: base.title, reason: read.reason });
      else layers.push(...read);
    }
  };
  walk(json.operationalLayers, { visible: true, opacity: 1, minScale: null, maxScale: null });

  const baseMap = isRecord(json.baseMap) ? json.baseMap : null;
  const basemapLayers: WebMapPlan['basemap']['layers'] = [];
  for (const item of Array.isArray(baseMap?.baseMapLayers) ? baseMap.baseMapLayers : []) {
    if (!isRecord(item)) continue;
    const base = layerBase(item, { visible: true, opacity: 1, minScale: null, maxScale: null });
    const read = readLayer(item, base);
    if ('reason' in read) unsupported.push({ title: `背景地図: ${base.title}`, reason: read.reason });
    else basemapLayers.push(...read.map((l) => ({ ...l, reference: item.isReference === true })));
  }

  const spatialReference = wkidOf(json.spatialReference) ?? 102100;
  const initial = isRecord(json.initialState) && isRecord(json.initialState.viewpoint) ? json.initialState.viewpoint.targetGeometry : undefined;
  const extent = extentOf(initial, spatialReference) ?? extentOf(isRecord(json.mapOptions) ? json.mapOptions.extent : undefined, spatialReference);
  const bookmarks: WebMapPlan['bookmarks'] = [];
  for (const b of Array.isArray(json.bookmarks) ? json.bookmarks : []) {
    if (!isRecord(b)) continue;
    const target = isRecord(b.viewpoint) ? b.viewpoint.targetGeometry : undefined;
    const e = extentOf(b.extent, spatialReference) ?? extentOf(target, spatialReference);
    if (e) bookmarks.push({ name: str(b.name) ?? 'ブックマーク', extent: e });
  }
  return { layers, basemap: { title: str(baseMap?.title) ?? '背景地図', layers: basemapLayers, source: baseMap }, unsupported, extent, bookmarks };
}

/** The extent of an item (`[[xmin, ymin], [xmax, ymax]]` in degrees), for maps that have none of their own. */
export function itemExtent(item: unknown): WebMapExtent | null {
  const e = isRecord(item) ? item.extent : undefined;
  if (!Array.isArray(e) || e.length !== 2 || !Array.isArray(e[0]) || !Array.isArray(e[1])) return null;
  const [[xmin, ymin], [xmax, ymax]] = e as number[][];
  return [xmin, ymin, xmax, ymax].every((v) => num(v) !== undefined) && xmax > xmin && ymax > ymin ? { xmin, ymin, xmax, ymax, wkid: 4326 } : null;
}

function wkidOf(sr: unknown): number | undefined {
  if (!isRecord(sr)) return undefined;
  return num(sr.latestWkid) ?? num(sr.wkid);
}

function extentOf(e: unknown, fallbackWkid: number): WebMapExtent | null {
  if (!isRecord(e)) return null;
  const [xmin, ymin, xmax, ymax] = [e.xmin, e.ymin, e.xmax, e.ymax].map(num);
  if (xmin === undefined || ymin === undefined || xmax === undefined || ymax === undefined || !(xmax > xmin) || !(ymax > ymin)) return null;
  return { xmin, ymin, xmax, ymax, wkid: wkidOf(e.spatialReference) ?? fallbackWkid };
}

function layerBase(item: Json, parent: { visible: boolean; opacity: number; minScale: number | null; maxScale: number | null }): LayerBase {
  const scale = (v: unknown) => (num(v) !== undefined && (v as number) > 0 ? (v as number) : null);
  const definition = isRecord(item.layerDefinition) ? item.layerDefinition : {};
  const minScale = scale(item.minScale) ?? scale(definition.minScale);
  const maxScale = scale(item.maxScale) ?? scale(definition.maxScale);
  // A group's range narrows its layers': the smaller "zoomed out" limit and the larger "zoomed in" one.
  const narrow = (a: number | null, b: number | null, pick: (x: number, y: number) => number) => (a === null ? b : b === null ? a : pick(a, b));
  const transparency = num(isRecord(definition.drawingInfo) ? definition.drawingInfo.transparency : undefined);
  const opacity = Math.max(0, Math.min(1, num(item.opacity) ?? 1)) * (transparency !== undefined ? 1 - Math.max(0, Math.min(100, transparency)) / 100 : 1);
  return {
    ...(str(item.id) ? { id: str(item.id) } : {}),
    title: str(item.title) ?? str(item.name) ?? str(item.url)?.split('/').slice(-2).join('/') ?? 'レイヤー',
    visible: parent.visible && item.visibility !== false,
    opacity: parent.opacity * opacity,
    minScale: narrow(parent.minScale, minScale, Math.min),
    maxScale: narrow(parent.maxScale, maxScale, Math.max),
    source: item,
  };
}

/** One layer of a web map (not a group) as the viewer's layers (one, or a WMS layer's several), or why it cannot be shown. */
function readLayer(item: Json, base: LayerBase): WebMapLayer[] | { reason: string } {
  const read = readOne(item, base);
  return Array.isArray(read) || 'reason' in read ? read : [read];
}

function readOne(item: Json, base: LayerBase): WebMapLayer | WebMapLayer[] | { reason: string } {
  const type = str(item.layerType) ?? (isRecord(item.featureCollection) ? 'ArcGISFeatureLayer' : '');
  const url = str(item.url);
  const definition = isRecord(item.layerDefinition) ? item.layerDefinition : {};
  const drawing = isRecord(definition.drawingInfo) ? definition.drawingInfo : {};
  if (url && !/^https?:\/\//i.test(url)) return { reason: 'URL が http(s) ではありません' };
  switch (type) {
    case 'ArcGISFeatureLayer': {
      if (isRecord(item.featureCollection)) {
        const parts = collectionParts(item.featureCollection);
        return parts.length ? { ...base, type: 'collection', parts } : { reason: 'フィーチャーコレクションに地物がありません' };
      }
      if (!url) return { reason: 'URL がありません（アイテムの地物は読めません）' };
      const m = /^(.*\/(?:FeatureServer|MapServer))(?:\/(\d+))?\/?$/i.exec(url.replace(/\?.*$/, ''));
      if (!m) return { reason: 'FeatureServer・MapServer のレイヤーの URL ではありません' };
      const id = m[2] ?? String(num(item.layerId) ?? 0);
      const where = str(definition.definitionExpression);
      const renderer = isRecord(drawing.renderer) ? (drawing.renderer as unknown as EsriRenderer) : undefined;
      return {
        ...base,
        type: 'service',
        esri: true,
        ref: { kind: 'esri', url: `${m[1]}/${id}`, layer: id, ...(where ? { settings: { where } } : {}) },
        ...(renderer ? { renderer } : {}),
        ...(drawing.labelingInfo !== undefined || definition.showLabels !== undefined ? { labelField: item.showLabels === false || definition.showLabels === false ? null : labelFieldOf(drawing.labelingInfo) } : {}),
      };
    }
    case 'ArcGISMapServiceLayer':
    case 'ArcGISTiledMapServiceLayer': {
      const service = url && /^(.*\/MapServer)\/?$/i.exec(url.replace(/\?.*$/, ''))?.[1];
      if (!service) return { reason: 'MapServer の URL ではありません' };
      const settings: EsriRasterSettings = {};
      const visible = Array.isArray(item.visibleLayers) ? item.visibleLayers.filter((v): v is number => Number.isInteger(v)) : null;
      if (visible) settings.layers = visible;
      const defs: Record<string, string> = {};
      for (const l of Array.isArray(item.layers) ? item.layers : []) {
        const where = isRecord(l) && isRecord(l.layerDefinition) ? str(l.layerDefinition.definitionExpression) : undefined;
        if (where && isRecord(l) && Number.isInteger(l.id)) defs[String(l.id)] = where;
      }
      if (Object.keys(defs).length) settings.layerDefs = defs;
      return { ...base, type: 'service', esri: true, ref: { kind: 'esri', url: service, layer: 'map', ...(Object.keys(settings).length ? { settings } : {}) } };
    }
    case 'ArcGISImageServiceLayer':
    case 'ArcGISTiledImageServiceLayer': {
      const service = url && /^(.*\/ImageServer)\/?$/i.exec(url.replace(/\?.*$/, ''))?.[1];
      if (!service) return { reason: 'ImageServer の URL ではありません' };
      const settings: EsriRasterSettings = {};
      if (isRecord(item.renderingRule)) settings.renderingRule = JSON.stringify(item.renderingRule);
      const mosaic = isRecord(item.mosaicRule) ? item.mosaicRule : {};
      const where = str(mosaic.where);
      if (where) settings.where = where;
      const method = str(mosaic.mosaicMethod);
      if (method) settings.method = method;
      if (str(mosaic.sortField)) settings.sortField = str(mosaic.sortField);
      if (Array.isArray(item.bandIds) && item.bandIds.every((b) => Number.isInteger(b))) settings.bandIds = item.bandIds as number[];
      return { ...base, type: 'service', esri: true, ref: { kind: 'esri', url: service, layer: 'image', ...(Object.keys(settings).length ? { settings } : {}) } };
    }
    case 'WMS': {
      if (!url) return { reason: 'URL がありません' };
      const names = Array.isArray(item.visibleLayers) ? item.visibleLayers.filter((v): v is string => typeof v === 'string' && !!v) : [];
      const listed = Array.isArray(item.layers) ? item.layers.map((l) => (isRecord(l) ? str(l.name) : undefined)).filter((v): v is string => !!v) : [];
      const name = names[0] ?? listed[0];
      if (!name) return { reason: '表示する WMS レイヤーがありません' };
      // More than one WMS layer: one viewer layer each, in the web map's order.
      const shown = names.length ? names : [name];
      return shown.map((layer) => ({ ...base, title: shown.length > 1 ? `${base.title}: ${layer}` : base.title, type: 'service' as const, esri: false, ref: { kind: 'wms' as const, url: str(item.mapUrl) ?? url, layer } }));
    }
    case 'WMTS': {
      const info = isRecord(item.wmtsInfo) ? item.wmtsInfo : {};
      const service = str(info.url) ?? url;
      const id = str(info.layerIdentifier);
      if (!service || !id) return { reason: 'WMTS のレイヤー（wmtsInfo）がありません' };
      return { ...base, type: 'service', esri: false, ref: { kind: 'wmts', url: service, layer: id, ...(str(info.tileMatrixSet) ? { matrixSet: str(info.tileMatrixSet) } : {}), ...(str(item.format) ? { format: str(item.format) } : {}) } };
    }
    case 'WFS': {
      const info = isRecord(item.wfsInfo) ? item.wfsInfo : {};
      const name = str(info.name);
      if (!url || !name) return { reason: 'WFS の地物型（wfsInfo.name）がありません' };
      return { ...base, type: 'service', esri: false, ref: { kind: 'wfs', url, layer: name } };
    }
    case 'WebTiledLayer': {
      const template = str(item.templateUrl);
      if (!template || !/^https?:\/\//i.test(template)) return { reason: 'タイルの URL（templateUrl）がありません' };
      return { ...base, type: 'tiles', urls: tileUrls(template, item.subDomains), ...(str(item.copyright) ? { attributions: str(item.copyright) } : {}) };
    }
    case 'OpenStreetMap':
      return { ...base, type: 'tiles', urls: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], attributions: '© OpenStreetMap contributors' };
    case 'VectorTileLayer': {
      const style = str(item.styleUrl);
      const service = url ?? (style ? /^(.*\/VectorTileServer)(?:\/|$)/i.exec(style)?.[1] : undefined);
      if (style && !/^https?:\/\//i.test(style)) return { reason: 'スタイルの URL が http(s) ではありません' };
      if (!service && !style) return { reason: 'URL がありません' };
      return { ...base, type: 'vector-tiles', url: service ?? style!, ...(style ? { style } : {}) };
    }
    case '':
      return { reason: '種類（layerType）がありません' };
    default:
      return { reason: unsupportedReasons[type] ?? `${type} には対応していません` };
  }
}

/** A web tiled layer's template (`{level}`, `{col}`, `{row}`, `{subDomain}`) as XYZ URLs. */
export function tileUrls(template: string, subDomains: unknown): string[] {
  const xyz = template.replace(/\{level\}/g, '{z}').replace(/\{col\}/g, '{x}').replace(/\{row\}/g, '{y}');
  const subs = Array.isArray(subDomains) ? subDomains.filter((s): s is string => typeof s === 'string' && /^[\w-]+$/.test(s)) : [];
  if (!xyz.includes('{subDomain}')) return [xyz];
  return (subs.length ? subs : ['a']).map((s) => xyz.replace(/\{subDomain\}/g, s));
}

function collectionParts(collection: Json): CollectionPart[] {
  const parts: CollectionPart[] = [];
  for (const l of Array.isArray(collection.layers) ? collection.layers : []) {
    if (!isRecord(l)) continue;
    const definition = isRecord(l.layerDefinition) ? l.layerDefinition : {};
    const set = isRecord(l.featureSet) ? l.featureSet : {};
    const features = Array.isArray(set.features) ? set.features.filter(isRecord) : [];
    if (!features.length) continue;
    const drawing = isRecord(definition.drawingInfo) ? definition.drawingInfo : {};
    parts.push({
      name: str(definition.name) ?? '',
      geometryType: str(set.geometryType) ?? str(definition.geometryType) ?? '',
      fields: Array.isArray(definition.fields) ? definition.fields.filter((f): f is CollectionPart['fields'][number] => isRecord(f) && typeof f.name === 'string' && typeof f.type === 'string') : [],
      ...(isRecord(drawing.renderer) ? { renderer: drawing.renderer as unknown as EsriRenderer } : {}),
      ...(drawing.labelingInfo !== undefined ? { labelField: labelFieldOf(drawing.labelingInfo) } : {}),
      features,
      wkid: wkidOf(set.spatialReference) ?? wkidOf(definition.spatialReference) ?? wkidOf((features[0].geometry as Json | undefined)?.spatialReference) ?? 102100,
    });
  }
  return parts;
}

const esriJson = new EsriJSON();

/** The features of a feature collection's layer, in `EPSG:3857`, read from `dataProjection` (its spatial reference). */
export function collectionFeatures(part: CollectionPart, dataProjection: string, max = 50_000): Feature[] {
  return esriJson.readFeatures({ features: part.features.slice(0, max) }, { dataProjection, featureProjection: 'EPSG:3857' }) as Feature[];
}

/** The attribute named by a layer's first label class (`$feature.NAME`, `$feature["NAME"]`, `[NAME]`), or null. */
export function labelFieldOf(labeling: unknown): string | null {
  const first = Array.isArray(labeling) ? labeling.find(isRecord) : undefined;
  if (!first) return null;
  const arcade = isRecord(first.labelExpressionInfo) ? str(first.labelExpressionInfo.expression) : undefined;
  const m = arcade ? /^\$feature(?:\.(\w+)|\[\s*["'](.+?)["']\s*\])$/.exec(arcade) : null;
  if (m) return m[1] ?? m[2];
  const old = str(first.labelExpression);
  return old ? (/^\[(\w+)\]$/.exec(old)?.[1] ?? null) : null;
}

// ---- Renderers into the viewer's style ----

/** Points (Esri symbols) to pixels, and back. */
const px = (pt: number) => (pt * 4) / 3;
const pt = (px: number) => Math.round(px * 0.75 * 100) / 100;

function hexOf(color: unknown): { hex: string; alpha: number } | null {
  if (!Array.isArray(color) || color.length < 3 || !color.slice(0, 3).every((c) => typeof c === 'number')) return null;
  const [r, g, b, a = 255] = color as number[];
  const h = (c: number) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0');
  return { hex: `#${h(r)}${h(g)}${h(b)}`, alpha: Math.max(0, Math.min(1, a / 255)) };
}

const shapesOfEsri: Record<string, PointShape> = {
  esriSMSCircle: 'circle',
  esriSMSSquare: 'square',
  esriSMSDiamond: 'diamond',
  esriSMSTriangle: 'triangle',
  esriSMSCross: 'cross',
  esriSMSX: 'x',
};
const dashesOfEsri: Record<string, LineDash> = {
  esriSLSSolid: 'solid',
  esriSLSDash: 'dash',
  esriSLSShortDash: 'dash',
  esriSLSLongDash: 'dash',
  esriSLSShortDot: 'dot',
  esriSLSDot: 'dot',
  esriSLSDashDot: 'dashdot',
  esriSLSDashDotDot: 'dashdot',
  esriSLSShortDashDot: 'dashdot',
  esriSLSLongDashDot: 'dashdot',
};
const simpleSymbols = new Set(['esriSMS', 'esriSLS', 'esriSFS']);

/** An Esri simple symbol as the viewer's symbol; the color it is drawn in (fill, or the line of a line symbol). */
export function symbolOfEsri(sym: EsriSymbol | null | undefined, base: SymbolSpec): { symbol: SymbolSpec; color: string } {
  const s = { ...base };
  if (!sym) return { symbol: s, color: s.fill };
  if (sym.type === 'esriSLS') {
    const c = hexOf(sym.color);
    s.stroke = c?.hex ?? s.stroke;
    s.strokeOpacity = c ? c.alpha : s.strokeOpacity;
    s.strokeWidth = sym.style === 'esriSLSNull' || !c ? 0 : Math.max(0.5, px(sym.width ?? 1));
    s.dash = dashesOfEsri[sym.style ?? ''] ?? 'solid';
    s.fill = s.stroke;
    return { symbol: s, color: s.stroke };
  }
  const fill = hexOf(sym.color);
  if (fill) {
    s.fill = fill.hex;
    s.fillOpacity = sym.type === 'esriSFS' && sym.style === 'esriSFSNull' ? 0 : fill.alpha;
  } else s.fillOpacity = 0;
  const outline = sym.outline;
  const line = outline ? hexOf(outline.color) : null;
  if (line && outline?.style !== 'esriSLSNull') {
    s.stroke = line.hex;
    s.strokeOpacity = line.alpha;
    s.strokeWidth = Math.max(0.5, px(outline?.width ?? 1));
    s.dash = dashesOfEsri[outline?.style ?? ''] ?? 'solid';
  } else s.strokeWidth = 0;
  if (sym.type === 'esriSMS') {
    s.shape = shapesOfEsri[sym.style ?? ''] ?? 'circle';
    s.size = Math.max(2, px(sym.size ?? 8));
  }
  return { symbol: s, color: s.fill };
}

/**
 * A renderer (simple, unique value by one field, class breaks) of simple
 * symbols (esriSMS, esriSLS, esriSFS) as the viewer's style, or null when it
 * has others (pictures, several fields, visual variables only): the layer is
 * then drawn by the renderer itself (the 「own」 style).
 */
export function specOfRenderer(renderer: EsriRenderer | undefined, labelField: string | null = null): VectorStyleSpec | null {
  if (!renderer) return null;
  const symbols = [renderer.symbol, renderer.defaultSymbol, ...(renderer.uniqueValueInfos ?? []).map((u) => u.symbol), ...(renderer.classBreakInfos ?? []).map((c) => c.symbol)].filter(
    (s): s is EsriSymbol => !!s,
  );
  if (!symbols.length || !symbols.every((s) => simpleSymbols.has(s.type))) return null;
  const spec = singleSpec('#4363d8');
  spec.label.field = labelField;
  if (renderer.type === 'simple' && renderer.symbol) {
    spec.symbol = symbolOfEsri(renderer.symbol, spec.symbol).symbol;
    return spec;
  }
  const first = renderer.uniqueValueInfos?.[0]?.symbol ?? renderer.classBreakInfos?.[0]?.symbol;
  spec.symbol = symbolOfEsri(first, spec.symbol).symbol;
  // Features of no class: drawn in the default symbol's colors, or not at all.
  if (renderer.defaultSymbol) {
    const { symbol } = symbolOfEsri(renderer.defaultSymbol, spec.symbol);
    spec.symbol = { ...spec.symbol, fill: symbol.fill, stroke: renderer.defaultSymbol.type === 'esriSLS' ? symbol.stroke : spec.symbol.stroke };
  }
  spec.othersVisible = !!renderer.defaultSymbol;
  if (renderer.type === 'uniqueValue' && renderer.field1 && !renderer.field2) {
    const infos = (renderer.uniqueValueInfos ?? []).slice(0, MAX_CATEGORIES);
    spec.mode = 'categorized';
    spec.field = renderer.field1;
    spec.categories = infos.map((u) => {
      const read = symbolOfEsri(u.symbol, spec.symbol);
      return { value: String(u.value), color: read.color, visible: true, ...strokeBeside(spec.symbol, read.symbol, u.symbol?.type === 'esriSLS') };
    });
    settleColorTarget(spec, spec.categories);
    return spec;
  }
  if (renderer.type === 'classBreaks' && renderer.field) {
    const infos = [...(renderer.classBreakInfos ?? [])].sort((a, b) => a.classMaxValue - b.classMaxValue).slice(0, MAX_CLASSES);
    if (!infos.length) return null;
    spec.mode = 'graduated';
    spec.field = renderer.field;
    let min = num(renderer.minValue) ?? num(infos[0].classMinValue) ?? infos[0].classMaxValue;
    spec.classes = infos.map((c) => {
      const read = symbolOfEsri(c.symbol, spec.symbol);
      const cls = { min: num(c.classMinValue) ?? min, max: c.classMaxValue, color: read.color, visible: true, ...strokeBeside(spec.symbol, read.symbol, c.symbol?.type === 'esriSLS') };
      min = c.classMaxValue;
      return cls;
    });
    settleColorTarget(spec, spec.classes);
    spec.classCount = spec.classes.length;
    return spec;
  }
  return null;
}

/** A style for a web map layer: the renderer as the viewer's style when it can be, else the renderer itself (`own`). */
export function styleOfRenderer(renderer: EsriRenderer | undefined, labelField: string | null = null): VectorStyleSpec {
  const spec = specOfRenderer(renderer, labelField);
  if (spec) return spec;
  const own = ownSpec();
  own.label.field = labelField;
  return own;
}

// ---- The viewer's style into renderers ----

const esriShapes: Record<PointShape, string> = { circle: 'esriSMSCircle', square: 'esriSMSSquare', diamond: 'esriSMSDiamond', triangle: 'esriSMSTriangle', star: 'esriSMSCircle', cross: 'esriSMSCross', x: 'esriSMSX' };
const esriDashes: Record<LineDash, string> = { solid: 'esriSLSSolid', dash: 'esriSLSDash', dot: 'esriSLSDot', dashdot: 'esriSLSDashDot' };

function esriColor(hex: string, opacity: number): number[] {
  const [r, g, b] = asArray(hex);
  return [r, g, b, Math.round(Math.max(0, Math.min(1, opacity)) * 255)];
}

/** Which symbol a geometry type takes. */
export type GeometryKind = 'point' | 'line' | 'polygon';

/** The kind of an Esri or OpenLayers geometry type. */
export function geometryKind(type: string | undefined): GeometryKind {
  if (!type) return 'point';
  if (/polyline|linestring/i.test(type)) return 'line';
  if (/polygon|envelope/i.test(type)) return 'polygon';
  return 'point';
}

/** The viewer's symbol (in `color`, else its own colors) as an Esri simple symbol for `kind`. */
export function esriSymbolOf(s: SymbolSpec, kind: GeometryKind, color: string | null = null): EsriSymbol {
  const line = (c: string, width: number) => ({ type: 'esriSLS', style: width > 0 && s.strokeOpacity > 0 ? esriDashes[s.dash] : 'esriSLSNull', color: esriColor(c, s.strokeOpacity), width: pt(width) });
  if (kind === 'line') return line(color ?? s.stroke, Math.max(s.strokeWidth, color ? 1 : 0));
  const fill = color ?? s.fill;
  if (kind === 'polygon') return { type: 'esriSFS', style: s.fillOpacity > 0 ? 'esriSFSSolid' : 'esriSFSNull', color: esriColor(fill, s.fillOpacity), outline: line(s.stroke, s.strokeWidth) };
  return {
    type: 'esriSMS',
    style: esriShapes[s.shape],
    color: esriColor(fill, 1),
    size: pt(s.size),
    angle: 0,
    xoffset: 0,
    yoffset: 0,
    outline: s.strokeWidth > 0 && s.strokeOpacity > 0 ? { color: esriColor(s.stroke, s.strokeOpacity), width: pt(Math.min(s.strokeWidth, Math.max(1, s.size / 5))) } : null,
  };
}

/** The viewer's style as a renderer (single symbol, unique values, class breaks); null for `own` (the layer's own renderer stays). */
export function rendererOfSpec(spec: VectorStyleSpec, kind: GeometryKind): EsriRenderer | null {
  const s = spec.symbol;
  if (spec.mode === 'own') return null;
  const others = spec.othersVisible ? esriSymbolOf(s, kind) : null;
  if (spec.mode === 'categorized' && spec.field) {
    return {
      type: 'uniqueValue',
      field1: spec.field,
      defaultSymbol: others,
      uniqueValueInfos: spec.categories.filter((c) => c.visible).map((c) => ({ value: c.value, label: c.value || '（空）', symbol: esriSymbolOf(symbolOfClass(spec, c, kind === 'line'), kind) })),
    } as EsriRenderer;
  }
  if (spec.mode === 'graduated' && spec.field && spec.classes.length) {
    return {
      type: 'classBreaks',
      field: spec.field,
      minValue: spec.classes[0].min,
      defaultSymbol: others,
      classBreakInfos: spec.classes.filter((c) => c.visible).map((c) => ({ classMinValue: c.min, classMaxValue: c.max, label: `${c.min} – ${c.max}`, symbol: esriSymbolOf(symbolOfClass(spec, c, kind === 'line'), kind) })),
    } as EsriRenderer;
  }
  return { type: 'simple', symbol: esriSymbolOf(s, kind) };
}

/** The label class of a style's labels, or null without labels. */
export function labelingOfSpec(spec: VectorStyleSpec): Json[] | null {
  const l = spec.label;
  if (!l.field) return null;
  return [
    {
      labelExpressionInfo: { expression: `$feature["${l.field.replace(/["\\]/g, '\\$&')}"]` },
      labelPlacement: 'esriServerPointLabelPlacementAboveCenter',
      ...(l.maxScale ? { minScale: l.maxScale } : {}),
      symbol: {
        type: 'esriTS',
        color: esriColor(l.color, 1),
        font: { family: 'sans-serif', size: pt(l.size), weight: l.bold ? 'bold' : 'normal' },
        ...(l.haloWidth > 0 ? { haloColor: esriColor(l.halo, 1), haloSize: pt(l.haloWidth / 2) } : {}),
      },
    },
  ];
}

// ---- Scales ----

/** Meters per pixel of Web Mercator per Esri scale unit (96 dpi, at the equator), as ArcGIS reckons scales of Web Mercator. */
export const ESRI_RESOLUTION_PER_SCALE = 0.0254 / 96;

/** An Esri scale as the viewer's scale for vector styles (OGC 0.28 mm pixel, measured at `latitude`). */
export function specScaleOfEsri(scale: number, latitude: number): number {
  return ((scale * ESRI_RESOLUTION_PER_SCALE) / 0.00028) * Math.max(0.01, Math.cos((latitude * Math.PI) / 180));
}

/** A viewer's vector style scale as an Esri scale. */
export function esriScaleOfSpec(scale: number, latitude: number): number {
  return Math.round((scale * 0.00028) / ESRI_RESOLUTION_PER_SCALE / Math.max(0.01, Math.cos((latitude * Math.PI) / 180)));
}

// ---- Writing ----

/** One layer of the viewer to write, bottom first. */
export type SaveLayer = {
  title: string;
  visible: boolean;
  opacity: number;
  /** Esri scales, or null. */
  minScale?: number | null;
  maxScale?: number | null;
} & (
  | {
      type: 'ref';
      ref: ServiceRef;
      /** The style of a feature layer; its own renderer stays when `own`. */
      spec?: VectorStyleSpec;
      geometryType?: string;
      /** The renderer the web map gave the layer, written while its style is `own`. */
      renderer?: EsriRenderer;
    }
  | { type: 'json'; json: Json }
  | { type: 'features'; features: Feature[]; fields: Field[]; spec?: VectorStyleSpec; renderer?: EsriRenderer }
  | { type: 'none'; reason: string }
);

/** What a web map is made from. */
export interface SaveInput {
  title: string;
  /** Bottom first. */
  layers: SaveLayer[];
  /** The view, in Web Mercator. */
  extent: [number, number, number, number] | null;
  /** The base map: one from config.json, else the one a web map came with (written back as it was). */
  basemap: { config?: BaseMapConfig; json?: Json | null };
  bookmarks?: readonly Bookmark[];
  /** The extent of a bookmark (Web Mercator), from its view. */
  bookmarkExtent?: (bookmark: Bookmark) => [number, number, number, number] | null;
}

/** A web map written, and what it left out. */
export interface SaveResult {
  json: Json;
  included: string[];
  skipped: Array<{ title: string; reason: string }>;
}

const WEB_MERCATOR = { wkid: 102100, latestWkid: 3857 };

const fieldTypes: Record<Field['type'], string> = {
  oid: 'esriFieldTypeOID',
  string: 'esriFieldTypeString',
  integer: 'esriFieldTypeInteger',
  double: 'esriFieldTypeDouble',
  date: 'esriFieldTypeDate',
  other: 'esriFieldTypeString',
};

/** Builds the JSON of a web map (version 2.x). */
export function buildWebMap(input: SaveInput): SaveResult {
  const included: string[] = [];
  const skipped: SaveResult['skipped'] = [];
  const operationalLayers: Json[] = [];
  let size = 0;
  input.layers.forEach((layer, i) => {
    const common: Json = {
      id: `layer-${i + 1}`,
      title: layer.title,
      visibility: layer.visible,
      opacity: Math.round(layer.opacity * 1000) / 1000,
      ...(layer.minScale ? { minScale: layer.minScale } : {}),
      ...(layer.maxScale ? { maxScale: layer.maxScale } : {}),
    };
    let out: Json | { reason: string };
    if (layer.type === 'none') out = { reason: layer.reason };
    else if (layer.type === 'json') out = { ...layer.json, ...common, id: str(layer.json.id) ?? common.id };
    else if (layer.type === 'ref') out = refLayer(layer, common);
    else out = collectionLayer(layer, common);
    if ('reason' in out) {
      skipped.push({ title: layer.title, reason: out.reason as string });
      return;
    }
    const chars = JSON.stringify(out).length;
    if (size + chars > MAX_WEBMAP_CHARS) {
      skipped.push({ title: layer.title, reason: `大きすぎます（Web マップ全体で ${(MAX_WEBMAP_CHARS / 1e6).toFixed(0)} MB まで）` });
      return;
    }
    size += chars;
    operationalLayers.push(out);
    included.push(layer.title);
  });

  const baseMap = basemapJson(input.basemap);
  const json: Json = {
    operationalLayers,
    baseMap: baseMap.json,
    spatialReference: WEB_MERCATOR,
    authoringApp: 'image-viewer',
    authoringAppVersion: '1',
    version: WEBMAP_VERSION,
  };
  if (baseMap.skipped) skipped.push(baseMap.skipped);
  if (input.extent) json.initialState = { viewpoint: { targetGeometry: extentJson(input.extent) } };
  const bookmarks = (input.bookmarks ?? []).flatMap((b) => {
    const e = input.bookmarkExtent?.(b);
    return e ? [{ name: b.name, extent: extentJson(e), viewpoint: { targetGeometry: extentJson(e) } }] : [];
  });
  if (bookmarks.length) json.bookmarks = bookmarks;
  return { json, included, skipped };
}

function extentJson(e: [number, number, number, number]): Json {
  const r = (v: number) => Math.round(v * 100) / 100;
  return { xmin: r(e[0]), ymin: r(e[1]), xmax: r(e[2]), ymax: r(e[3]), spatialReference: WEB_MERCATOR };
}

function refLayer(layer: Extract<SaveLayer, { type: 'ref' }>, common: Json): Json | { reason: string } {
  const { ref } = layer;
  const settings = ref.settings ?? {};
  switch (ref.kind) {
    case 'esri': {
      if (ref.layer === 'map') {
        const layers = Object.entries(settings.layerDefs ?? {}).map(([id, where]) => ({ id: Number(id), layerDefinition: { definitionExpression: where } }));
        return { ...common, layerType: 'ArcGISMapServiceLayer', url: ref.url, ...(settings.layers ? { visibleLayers: settings.layers } : {}), ...(layers.length ? { layers } : {}) };
      }
      if (ref.layer === 'image') {
        let renderingRule: unknown;
        try {
          renderingRule = settings.renderingRule ? JSON.parse(settings.renderingRule) : settings.rasterFunction ? { rasterFunction: settings.rasterFunction } : undefined;
        } catch {
          renderingRule = undefined;
        }
        const mosaicRule = settings.where || settings.method ? { mosaicMethod: settings.method ?? 'esriMosaicNone', ...(settings.where ? { where: settings.where } : {}), ...(settings.sortField ? { sortField: settings.sortField } : {}) } : undefined;
        return { ...common, layerType: 'ArcGISImageServiceLayer', url: ref.url, ...(renderingRule ? { renderingRule } : {}), ...(mosaicRule ? { mosaicRule } : {}), ...(settings.bandIds ? { bandIds: settings.bandIds } : {}) };
      }
      const definition: Json = {};
      if (settings.where) definition.definitionExpression = settings.where;
      const kind = geometryKind(layer.geometryType);
      const renderer = layer.spec && layer.spec.mode !== 'own' ? rendererOfSpec(layer.spec, kind) : layer.renderer;
      const labelingInfo = layer.spec ? labelingOfSpec(layer.spec) : null;
      if (renderer || labelingInfo) definition.drawingInfo = { ...(renderer ? { renderer } : {}), ...(labelingInfo ? { labelingInfo } : {}) };
      return {
        ...common,
        layerType: 'ArcGISFeatureLayer',
        url: ref.url,
        ...(labelingInfo ? { showLabels: true } : {}),
        ...(Object.keys(definition).length ? { layerDefinition: definition } : {}),
      };
    }
    case 'wms':
      return { ...common, layerType: 'WMS', url: serviceRoot(ref.url), visibleLayers: [ref.layer], layers: [{ name: ref.layer, title: layer.title }] };
    case 'wmts':
      return {
        ...common,
        layerType: 'WMTS',
        url: serviceRoot(ref.url),
        ...(ref.format ? { format: ref.format } : {}),
        wmtsInfo: { url: serviceRoot(ref.url), layerIdentifier: ref.layer, ...(ref.matrixSet ? { tileMatrixSet: ref.matrixSet } : {}) },
      };
    case 'wfs':
      return { ...common, layerType: 'WFS', url: serviceRoot(ref.url), wfsInfo: { name: ref.layer } };
  }
  return { reason: '書き出せない種類です' };
}

/** A service URL without the request parameters the viewer adds (SERVICE, REQUEST, VERSION). */
function serviceRoot(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) if (/^(service|request|version)$/i.test(key)) u.searchParams.delete(key);
    return u.href.replace(/\?$/, '');
  } catch {
    return url;
  }
}

/** A vector layer without a service as a feature collection, or why not. */
function collectionLayer(layer: Extract<SaveLayer, { type: 'features' }>, common: Json): Json | { reason: string } {
  const all = layer.features.filter((f) => f.getGeometry());
  if (!all.length) return { reason: '地物がありません' };
  if (all.length > MAX_COLLECTION_FEATURES) return { reason: `地物が多すぎます（${all.length.toLocaleString()} 件。フィーチャーコレクションは ${MAX_COLLECTION_FEATURES.toLocaleString()} 件まで）` };
  // One part per kind of geometry: a collection layer holds one.
  const byKind = new Map<GeometryKind, Feature[]>();
  for (const f of all) {
    const kind = geometryKind(f.getGeometry()!.getType());
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind)!.push(f);
  }
  const fields = layer.fields.filter((f) => f.type !== 'oid');
  const esriFields = [{ name: '__OBJECTID', type: 'esriFieldTypeOID', alias: 'OBJECTID' }, ...fields.map((f) => ({ name: f.name, alias: f.alias, type: fieldTypes[f.type], ...(f.type === 'string' && f.length ? { length: f.length } : {}) }))];
  const geometryTypes: Record<GeometryKind, string> = { point: 'esriGeometryPoint', line: 'esriGeometryPolyline', polygon: 'esriGeometryPolygon' };
  const layers = [...byKind].map(([kind, features], part) => {
    const renderer = layer.spec && layer.spec.mode !== 'own' ? rendererOfSpec(layer.spec, kind) : (layer.renderer ?? rendererOfSpec(singleSpec('#4363d8'), kind));
    const labelingInfo = layer.spec ? labelingOfSpec(layer.spec) : null;
    let id = 0;
    return {
      layerDefinition: {
        name: byKind.size > 1 ? `${layer.title} (${kind})` : layer.title,
        type: 'Feature Layer',
        geometryType: geometryTypes[kind],
        objectIdField: '__OBJECTID',
        fields: esriFields,
        drawingInfo: { renderer, ...(labelingInfo ? { labelingInfo } : {}) },
      },
      featureSet: {
        geometryType: geometryTypes[kind],
        spatialReference: WEB_MERCATOR,
        features: features.map((f) => {
          const attributes: Json = { __OBJECTID: ++id + part * MAX_COLLECTION_FEATURES };
          for (const field of fields) attributes[field.name] = attributeValue(f.get(field.name));
          const geometry = esriJson.writeGeometryObject(f.getGeometry()!, { dataProjection: 'EPSG:3857', featureProjection: 'EPSG:3857' }) as Json;
          return { geometry: roundGeometry(geometry), attributes };
        }),
      },
    };
  });
  return { ...common, layerType: 'ArcGISFeatureLayer', featureCollection: { layers, showLegend: true } };
}

function attributeValue(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

/** Coordinates to centimeters, which is all a web map needs (and keeps it small). */
function roundGeometry(g: Json): Json {
  const round = (v: unknown): unknown => (typeof v === 'number' ? Math.round(v * 100) / 100 : Array.isArray(v) ? v.map(round) : v);
  const out: Json = {};
  for (const [k, v] of Object.entries(g)) if (k !== 'spatialReference') out[k] = round(v);
  return out;
}

/** The base map: one of config.json's as a web map's, else the web map's own kept, else none. */
function basemapJson(basemap: SaveInput['basemap']): { json: Json; skipped?: { title: string; reason: string } } {
  const config = basemap.config;
  if (config) {
    const title = config.label;
    if (config.type === 'xyz') {
      return { json: { title, baseMapLayers: [{ id: `basemap-${config.id}`, title, layerType: 'WebTiledLayer', templateUrl: templateOf(config.url), visibility: true, opacity: 1, ...(config.attributions ? { copyright: stripTags(config.attributions) } : {}) }] } };
    }
    if (config.type === 'esri') {
      const url = config.url.replace(/\/+$/, '');
      return { json: { title, baseMapLayers: [{ id: `basemap-${config.id}`, title, layerType: 'VectorTileLayer', styleUrl: config.style ?? `${url}/resources/styles/root.json`, visibility: true, opacity: 1 }] } };
    }
    if (config.type === 'style') return { json: { title, baseMapLayers: [{ id: `basemap-${config.id}`, title, layerType: 'VectorTileLayer', styleUrl: config.url, visibility: true, opacity: 1 }] } };
    // Plain {z}/{x}/{y}.pbf tiles have no style a web map could name.
    return { json: { title: '背景なし', baseMapLayers: [] }, skipped: { title: `背景地図: ${title}`, reason: 'スタイルのないベクタータイルは Web マップに書けません' } };
  }
  if (basemap.json && Array.isArray(basemap.json.baseMapLayers)) return { json: basemap.json };
  return { json: { title: '背景なし', baseMapLayers: [] } };
}

/** An XYZ URL template as a web tiled layer's (`{level}`, `{col}`, `{row}`, `{subDomain}`). */
export function templateOf(url: string): string {
  return url.replace(/\{z\}/g, '{level}').replace(/\{x\}/g, '{col}').replace(/\{-?y\}/g, '{row}').replace(/\{[a-c]-[a-c]\}/g, '{subDomain}');
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&copy;/g, '©').replace(/&amp;/g, '&').trim();
}

// ---- Base maps ----

/** A URL compared loosely: no scheme, query, trailing slash or case. */
function looseUrl(url: string): string {
  return url
    .replace(/^https?:\/\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * The base map of config.json a web map's base map is, matched by its
 * layers' URLs (tile template, VectorTileServer, style) or else by title; undefined when none.
 */
export function matchBaseMap(basemap: WebMapPlan['basemap'], configs: readonly BaseMapConfig[]): BaseMapConfig | undefined {
  const main = basemap.layers.filter((l) => !l.reference);
  for (const layer of main) {
    const urls =
      layer.type === 'tiles'
        ? layer.urls.map(looseUrl)
        : layer.type === 'vector-tiles'
          ? [layer.url, layer.style].filter((u): u is string => !!u).map(looseUrl)
          : layer.type === 'service'
            ? [looseUrl(layer.ref.url)]
            : [];
    const found = configs.find((c) => {
      const own = [looseUrl(c.url), ...(c.style ? [looseUrl(c.style)] : [])];
      return urls.some((u) => own.some((o) => u === o || (c.type === 'esri' && u.startsWith(`${o}/`))));
    });
    if (found) return found;
  }
  const title = basemap.title.trim().toLowerCase();
  return configs.find((c) => c.label.trim().toLowerCase() === title || c.id.toLowerCase() === title);
}
