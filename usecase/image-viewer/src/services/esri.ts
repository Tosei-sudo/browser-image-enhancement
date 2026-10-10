/**
 * Esri feature services (ArcGIS REST: FeatureServer, and the feature layers
 * of a MapServer, read only): the service's layers, every feature of a layer
 * (paged by object id, up to {@link MAX_FEATURES}), the service's own
 * symbols (simple, unique value and class breaks renderers), and `applyEdits`
 * for editable layers. A token, when given, goes with every request.
 */
import type Feature from 'ol/Feature.js';
import EsriJSON from 'ol/format/EsriJSON.js';
import type Geometry from 'ol/geom/Geometry.js';
import { toLonLat, transformExtent } from 'ol/proj.js';
import type { FeatureLike } from 'ol/Feature.js';
import { Circle, Fill, Icon, RegularShape, Stroke, Style } from 'ol/style.js';
import { LayerStyle, ownSpec } from '../vector-style.js';
import type ImageStyle from 'ol/style/Image.js';
import type { Extent } from 'ol/extent.js';
import { MAX_FEATURES, projectionOf, request, ServiceError, type Field, type LayerChoice, type ServiceCatalog, type ServiceLayer } from './common.js';
import { vectorLayer } from './vector.js';
import { extentHeights, raiseFootprints } from './esri-multipatch.js';
import { imageServerChoice, MAP_CHOICE, mapChoice, openImageServer, openMapServer } from './esri-raster.js';

/** What the viewer keeps of an Esri layer's description. */
export interface EsriLayerInfo {
  /** The layer's URL (`…/FeatureServer/0`). */
  url: string;
  name: string;
  /** `esriGeometryPoint`, `esriGeometryMultipoint`, `esriGeometryPolyline`, `esriGeometryPolygon` or `esriGeometryMultiPatch`. */
  geometryType: string;
  objectIdField: string;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  /** Attributes a new feature starts with (from the layer's first template). */
  template: Record<string, unknown>;
  token?: string;
  /** The attributes the layer's `timeInfo` names as its start and end times. */
  time?: { start?: string; end?: string };
}

interface EsriField {
  name: string;
  type: string;
  alias?: string;
  length?: number;
  editable?: boolean;
  nullable?: boolean;
  domain?: { type: string; codedValues?: Array<{ name: string; code: string | number }>; range?: [number, number] } | null;
}

interface EsriLayerJson {
  id: number;
  name: string;
  type?: string;
  geometryType?: string;
  objectIdField?: string;
  fields?: EsriField[];
  capabilities?: string;
  maxRecordCount?: number;
  extent?: { xmin: number; ymin: number; xmax: number; ymax: number; spatialReference?: { wkid?: number; latestWkid?: number } };
  drawingInfo?: { renderer?: EsriRenderer };
  editFieldsInfo?: Record<string, string> | null;
  timeInfo?: { startTimeField?: string | null; endTimeField?: string | null } | null;
  templates?: Array<{ prototype?: { attributes?: Record<string, unknown> } }>;
  types?: Array<{ templates?: Array<{ prototype?: { attributes?: Record<string, unknown> } }> }>;
}

/** Whether `url` looks like an ArcGIS REST service or layer. */
export function isEsriUrl(url: string): boolean {
  return /\/(FeatureServer|MapServer)(\/\d+)?\/?(\?.*)?$/i.test(url) || /\/ImageServer\/?(\?.*)?$/i.test(url);
}

/**
 * GET (or POST, with `post`) to the REST API as JSON; an `error` member becomes a ServiceError.
 * A request with a token is always a POST, so the token stays out of URLs (server and proxy logs, history).
 */
export async function esriJson<T>(url: string, params: Record<string, string>, token?: string, post = false): Promise<T> {
  const all = new URLSearchParams({ ...params, f: 'json', ...(token ? { token } : {}) });
  const response = post || token
    ? await request(url, { method: 'POST', body: all, headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    : await request(`${url}?${all}`);
  const json = (await response.json().catch(() => null)) as (T & { error?: { code: number; message: string; details?: string[] } }) | null;
  if (!json) throw new ServiceError('応答が JSON ではありません');
  if (json.error) {
    const { code, message, details } = json.error;
    if (code === 499 || code === 498 || code === 403) throw new ServiceError(token ? `トークンが無効か、権限がありません（${message}）` : 'このサービスにはトークンが必要です');
    throw new ServiceError(`サービスがエラーを返しました: ${[message, ...(details ?? [])].join(' ')}`);
  }
  return json;
}

/**
 * Reads an Esri service: a feature service (`…/FeatureServer`) or one of its
 * layers (`…/FeatureServer/0`); a map service (`…/MapServer`: its map as a
 * picture, then its feature layers) or one of its layers; or an image service
 * (`…/ImageServer`, one picture layer).
 */
export async function readEsri(input: string, token?: string): Promise<ServiceCatalog> {
  const clean = input.replace(/\?.*$/, '').replace(/\/+$/, '');
  if (/\/ImageServer$/i.test(clean)) {
    const { title, choice } = await imageServerChoice(clean, token);
    return { kind: 'esri', url: clean, title, choices: [choice], open: (_choice, context, pick) => openImageServer(clean, context, pick?.settings) };
  }
  const m = /^(.*\/(?:FeatureServer|MapServer))(?:\/(\d+))?$/i.exec(clean);
  if (!m) throw new ServiceError('FeatureServer・MapServer・ImageServer の URL を入力してください');
  const [, serviceUrl, layerId] = m;
  const mapServer = /MapServer$/i.test(serviceUrl);
  const service = await esriJson<{ layers?: Array<{ id: number; name: string; geometryType?: string; type?: string }>; serviceDescription?: string; documentInfo?: { Title?: string }; mapName?: string }>(
    serviceUrl,
    {},
    token,
  );
  const title = service.documentInfo?.Title || service.mapName || serviceUrl.split('/').slice(-2, -1)[0] || serviceUrl;
  const layers = (service.layers ?? []).filter((l) => (l.type ?? 'Feature Layer') === 'Feature Layer' && (layerId === undefined || String(l.id) === layerId));
  const choices: LayerChoice[] = layers.map((l) => ({ name: String(l.id), title: l.name, abstract: geometryNames[l.geometryType ?? ''] }));
  // A map service's own map first: what most people want from it.
  if (mapServer && layerId === undefined) choices.unshift(mapChoice(title));
  if (choices.length === 0) throw new ServiceError('フィーチャーレイヤーがありません');
  return {
    kind: 'esri',
    url: serviceUrl,
    title,
    choices,
    open: (choice, context, pick) =>
      choice.name === MAP_CHOICE ? openMapServer(serviceUrl, context, pick?.settings) : openLayer(`${serviceUrl}/${choice.name}`, mapServer, context.token),
  };
}

const geometryNames: Record<string, string> = {
  esriGeometryPoint: 'ポイント',
  esriGeometryMultipoint: 'マルチポイント',
  esriGeometryPolyline: 'ライン',
  esriGeometryPolygon: 'ポリゴン',
  esriGeometryMultiPatch: 'マルチパッチ（3D）',
};

async function openLayer(url: string, mapServer: boolean, token?: string): Promise<ServiceLayer> {
  const json = await esriJson<EsriLayerJson>(url, {}, token);
  const caps = new Set((json.capabilities ?? '').split(',').map((c) => c.trim().toLowerCase()));
  const editing = !mapServer && (caps.has('editing') || caps.has('create') || caps.has('update') || caps.has('delete'));
  const info: EsriLayerInfo = {
    url,
    name: json.name,
    geometryType: json.geometryType ?? '',
    objectIdField: json.objectIdField ?? json.fields?.find((f) => f.type === 'esriFieldTypeOID')?.name ?? 'OBJECTID',
    canCreate: editing && caps.has('create'),
    canUpdate: editing && caps.has('update'),
    canDelete: editing && caps.has('delete'),
    template: json.templates?.[0]?.prototype?.attributes ?? json.types?.[0]?.templates?.[0]?.prototype?.attributes ?? {},
    token,
    ...(json.timeInfo?.startTimeField ? { time: { start: json.timeInfo.startTimeField, end: json.timeInfo.endTimeField ?? undefined } } : {}),
  };
  // Editing (Create, Update or Delete) given without the finer capabilities means all three.
  if (editing && !info.canCreate && !info.canUpdate && !info.canDelete) info.canCreate = info.canUpdate = info.canDelete = true;

  const managed = new Set(Object.values(json.editFieldsInfo ?? {}).filter((v): v is string => typeof v === 'string'));
  const fields = (json.fields ?? []).map((f) => toField(f, info.canUpdate || info.canCreate, managed)).filter((f): f is Field => f !== null);
  const multipatch = info.geometryType === 'esriGeometryMultiPatch';
  // Multipatches: their footprints on the map, raised in 3D from their lowest to highest height.
  const { features, truncated } = await queryAll(url, info.objectIdField, json.maxRecordCount ?? 1000, token, multipatch ? { multipatchOption: 'xyFootprint' } : {});
  let raised: number | null = null;
  if (multipatch) {
    if (editing) info.canCreate = info.canUpdate = info.canDelete = false;
    const heights = await multipatchHeights(url, info.objectIdField, features.map((f) => f.getId() as number), json.maxRecordCount ?? 1000, token).catch(() => new Map<unknown, [number, number]>());
    raised = raiseFootprints(features, heights, (p) => toLonLat(p, 'EPSG:3857'));
  }
  const own = rendererStyle(json.drawingInfo?.renderer, url);
  const layer = vectorLayer(features, own);
  const extent = json.extent ? await extentOf(json.extent) : null;

  return {
    ref: { kind: 'esri', url, layer: String(json.id) },
    title: json.name,
    layer,
    correction: null,
    vector: { source: layer.getSource()!, fields, idField: info.objectIdField, truncated },
    esri: info,
    // Drawn as the service draws it until another style is chosen.
    style: new LayerStyle(layer, ownSpec(), own),
    extent,
    info: [
      ['種類', mapServer ? 'Esri マップサービス（フィーチャーレイヤー）' : 'Esri フィーチャーサービス'],
      ['URL', url],
      ['ジオメトリ', geometryNames[info.geometryType] ?? info.geometryType],
      ['地物数', `${features.length.toLocaleString()}${truncated ? `（先頭 ${MAX_FEATURES.toLocaleString()} 件）` : ''}`],
      ['編集', [info.canCreate && '追加', info.canUpdate && '更新', info.canDelete && '削除'].filter(Boolean).join('・') || '不可'],
      ...(raised !== null ? [['3D', raised ? `${raised.toLocaleString()} 件を高さの範囲で立ち上げ（3D 表示）` : '高さを取得できません（ArcGIS Enterprise 10.9 以降の extent が必要）'] as [string, string]] : []),
    ],
  };
}

export function toField(f: EsriField, editableLayer: boolean, managed: Set<string>): Field | null {
  const types: Record<string, Field['type']> = {
    esriFieldTypeOID: 'oid',
    esriFieldTypeString: 'string',
    esriFieldTypeSmallInteger: 'integer',
    esriFieldTypeInteger: 'integer',
    esriFieldTypeBigInteger: 'integer',
    esriFieldTypeSingle: 'double',
    esriFieldTypeDouble: 'double',
    esriFieldTypeDate: 'date',
    esriFieldTypeDateOnly: 'string',
    esriFieldTypeTimeOnly: 'string',
    esriFieldTypeGlobalID: 'other',
    esriFieldTypeGUID: 'other',
  };
  const type = types[f.type];
  if (!type) return null; // geometry, blob, raster, XML
  return {
    name: f.name,
    alias: f.alias || f.name,
    type,
    editable: editableLayer && f.editable !== false && type !== 'oid' && type !== 'other' && !managed.has(f.name),
    nullable: f.nullable !== false,
    length: f.length,
    codes: f.domain?.type === 'codedValue' ? f.domain.codedValues : undefined,
    range: f.domain?.type === 'range' ? f.domain.range : undefined,
  };
}

const format = new EsriJSON();
const WEB_MERCATOR = { wkid: 102100, latestWkid: 3857 };

/** Every feature of the layer (up to MAX_FEATURES): the object ids first, then the features in batches. */
export async function queryAll(url: string, oid: string, maxRecords: number, token?: string, extra: Record<string, string> = {}): Promise<{ features: Feature[]; truncated: boolean }> {
  const ids = await esriJson<{ objectIds?: number[] | null }>(`${url}/query`, { where: '1=1', returnIdsOnly: 'true' }, token, true);
  const all = (ids.objectIds ?? []).sort((a, b) => a - b);
  const truncated = all.length > MAX_FEATURES;
  const wanted = all.slice(0, MAX_FEATURES);
  const batch = Math.max(1, Math.min(maxRecords, 1000));
  const parts: Array<Promise<Feature[]>> = [];
  for (let i = 0; i < wanted.length; i += batch) parts.push(queryIds(url, oid, wanted.slice(i, i + batch), token, extra));
  // A few requests at a time.
  const features: Feature[] = [];
  for (let i = 0; i < parts.length; i += 4) for (const p of await Promise.all(parts.slice(i, i + 4))) features.push(...p);
  return { features, truncated };
}

/** The features with these object ids, in Web Mercator, each with its object id as feature id. */
export async function queryIds(url: string, oid: string, ids: number[], token?: string, extra: Record<string, string> = {}): Promise<Feature[]> {
  if (ids.length === 0) return [];
  const json = await esriJson<object>(
    `${url}/query`,
    { objectIds: ids.join(','), outFields: '*', returnGeometry: 'true', outSR: JSON.stringify(WEB_MERCATOR), ...extra },
    token,
    true,
  );
  const features = format.readFeatures(json, { dataProjection: 'EPSG:3857', featureProjection: 'EPSG:3857' }) as Feature[];
  for (const f of features) f.setId(f.get(oid));
  return features;
}

/** The lowest and highest height of each multipatch (by object id), from its 3D extent. */
async function multipatchHeights(url: string, oid: string, ids: number[], maxRecords: number, token?: string): Promise<Map<unknown, [number, number]>> {
  const heights = new Map<unknown, [number, number]>();
  const batch = Math.max(1, Math.min(maxRecords, 1000));
  for (let i = 0; i < ids.length; i += batch) {
    const json = await esriJson<{ features?: Array<{ attributes?: Record<string, unknown>; geometry?: unknown }> }>(
      `${url}/query`,
      { objectIds: ids.slice(i, i + batch).join(','), outFields: oid, returnGeometry: 'true', returnZ: 'true', multipatchOption: 'extent' },
      token,
      true,
    );
    for (const f of json.features ?? []) {
      const range = extentHeights(f.geometry);
      if (range) heights.set(f.attributes?.[oid], range);
    }
  }
  return heights;
}

/** A geometry as Esri JSON in Web Mercator (outer rings clockwise, as the REST API expects). */
export function esriGeometry(geometry: Geometry): object {
  return { ...format.writeGeometryObject(geometry, { dataProjection: 'EPSG:3857', featureProjection: 'EPSG:3857' }), spatialReference: WEB_MERCATOR };
}

export interface EditResult {
  objectId?: number;
  success: boolean;
  error?: { code: number; description: string } | null;
}

/** Sends adds, updates and deletes in one `applyEdits`; each feature succeeds or fails on its own. */
export async function applyEdits(
  info: EsriLayerInfo,
  edits: { adds: object[]; updates: object[]; deletes: number[] },
): Promise<{ addResults: EditResult[]; updateResults: EditResult[]; deleteResults: EditResult[] }> {
  const params: Record<string, string> = { rollbackOnFailure: 'false' };
  if (edits.adds.length) params.adds = JSON.stringify(edits.adds);
  if (edits.updates.length) params.updates = JSON.stringify(edits.updates);
  if (edits.deletes.length) params.deletes = edits.deletes.join(',');
  const result = await esriJson<{ addResults?: EditResult[]; updateResults?: EditResult[]; deleteResults?: EditResult[] }>(
    `${info.url}/applyEdits`,
    params,
    info.token,
    true,
  );
  return { addResults: result.addResults ?? [], updateResults: result.updateResults ?? [], deleteResults: result.deleteResults ?? [] };
}

async function extentOf(e: NonNullable<EsriLayerJson['extent']>): Promise<Extent | null> {
  if (![e.xmin, e.ymin, e.xmax, e.ymax].every(Number.isFinite)) return null;
  const wkid = e.spatialReference?.latestWkid ?? e.spatialReference?.wkid ?? 4326;
  const projection = await projectionOf(`EPSG:${wkid}`);
  if (!projection) return null;
  return transformExtent([e.xmin, e.ymin, e.xmax, e.ymax], projection, 'EPSG:3857');
}

// ---- Symbols ----

interface EsriSymbol {
  type: string;
  style?: string;
  color?: number[] | null;
  size?: number;
  width?: number;
  height?: number;
  angle?: number;
  xoffset?: number;
  yoffset?: number;
  outline?: { color?: number[] | null; width?: number; style?: string } | null;
  url?: string;
  imageData?: string;
  contentType?: string;
}

interface EsriRenderer {
  type: string;
  symbol?: EsriSymbol;
  field1?: string;
  field2?: string;
  field3?: string;
  fieldDelimiter?: string;
  uniqueValueInfos?: Array<{ value: string; symbol: EsriSymbol }>;
  field?: string;
  minValue?: number;
  classBreakInfos?: Array<{ classMinValue?: number; classMaxValue: number; symbol: EsriSymbol }>;
  defaultSymbol?: EsriSymbol | null;
}

/** Points to pixels. */
const px = (pt = 0) => (pt * 4) / 3;

function rgba(color: number[] | null | undefined): string {
  if (!color) return 'rgba(0,0,0,0)';
  const [r, g, b, a = 255] = color;
  return `rgba(${r},${g},${b},${a / 255})`;
}

const dashes: Record<string, number[]> = {
  esriSLSDash: [8, 4],
  esriSLSDot: [2, 4],
  esriSLSDashDot: [8, 4, 2, 4],
  esriSLSDashDotDot: [8, 4, 2, 4, 2, 4],
  esriSLSShortDash: [4, 3],
  esriSLSLongDash: [12, 4],
};

function stroke(s: { color?: number[] | null; width?: number; style?: string } | null | undefined): Stroke | undefined {
  if (!s || s.style === 'esriSLSNull' || !s.color) return undefined;
  return new Stroke({ color: rgba(s.color), width: Math.max(px(s.width ?? 1), 0.5), lineDash: dashes[s.style ?? ''] });
}

/** One Esri symbol as an OpenLayers style; unknown kinds become a gray default. */
export function symbolStyle(sym: EsriSymbol | null | undefined, baseUrl: string): Style {
  if (!sym) return new Style();
  switch (sym.type) {
    case 'esriSMS':
      return new Style({ image: markerImage(sym) });
    case 'esriPMS': {
      const src = sym.imageData ? `data:${sym.contentType ?? 'image/png'};base64,${sym.imageData}` : sym.url ? new URL(sym.url, `${baseUrl}/`).href : undefined;
      if (!src) break;
      return new Style({
        image: new Icon({ src, width: px(sym.width ?? 16), height: px(sym.height ?? 16), rotation: ((sym.angle ?? 0) * Math.PI) / 180, displacement: [px(sym.xoffset), px(sym.yoffset)], declutterMode: 'obstacle' }),
      });
    }
    case 'esriSLS':
      return new Style({ stroke: stroke(sym) });
    case 'esriSFS':
      return new Style({ fill: sym.style === 'esriSFSNull' || !sym.color ? undefined : new Fill({ color: rgba(sym.color) }), stroke: stroke(sym.outline) });
    case 'esriPFS':
      return new Style({ fill: new Fill({ color: 'rgba(128,128,128,0.3)' }), stroke: stroke(sym.outline) });
  }
  return new Style({ stroke: new Stroke({ color: '#666', width: 1.5 }), fill: new Fill({ color: 'rgba(128,128,128,0.3)' }), image: new Circle({ radius: 5, fill: new Fill({ color: '#666' }), declutterMode: 'obstacle' }) });
}

function markerImage(sym: EsriSymbol): ImageStyle {
  const radius = px(sym.size ?? 8) / 2;
  const fill = sym.color ? new Fill({ color: rgba(sym.color) }) : undefined;
  const line = stroke(sym.outline);
  const rotation = ((sym.angle ?? 0) * Math.PI) / 180;
  const displacement = [px(sym.xoffset), px(sym.yoffset)];
  switch (sym.style) {
    case 'esriSMSSquare':
      return new RegularShape({ points: 4, radius: radius * Math.SQRT2, angle: Math.PI / 4, fill, stroke: line, rotation, displacement, declutterMode: 'obstacle' });
    case 'esriSMSDiamond':
      return new RegularShape({ points: 4, radius, fill, stroke: line, rotation, displacement, declutterMode: 'obstacle' });
    case 'esriSMSTriangle':
      return new RegularShape({ points: 3, radius, fill, stroke: line, rotation, displacement, declutterMode: 'obstacle' });
    case 'esriSMSCross':
      return new RegularShape({ points: 4, radius, radius2: 0, stroke: line ?? new Stroke({ color: rgba(sym.color), width: 2 }), rotation, displacement, declutterMode: 'obstacle' });
    case 'esriSMSX':
      return new RegularShape({ points: 4, radius, radius2: 0, angle: Math.PI / 4, stroke: line ?? new Stroke({ color: rgba(sym.color), width: 2 }), rotation, displacement, declutterMode: 'obstacle' });
    default:
      return new Circle({ radius, fill, stroke: line, displacement, declutterMode: 'obstacle' });
  }
}

/** The layer's renderer as a style function (simple, unique value, class breaks). */
export function rendererStyle(renderer: EsriRenderer | undefined, baseUrl: string): (feature: FeatureLike) => Style | undefined {
  if (!renderer) {
    const plain = symbolStyle({ type: '' }, baseUrl);
    return () => plain;
  }
  const fallback = renderer.defaultSymbol ? symbolStyle(renderer.defaultSymbol, baseUrl) : undefined;
  if (renderer.type === 'uniqueValue' && renderer.field1) {
    const fields = [renderer.field1, renderer.field2, renderer.field3].filter((f): f is string => !!f);
    const delimiter = renderer.fieldDelimiter ?? ',';
    const styles = new Map((renderer.uniqueValueInfos ?? []).map((u) => [String(u.value), symbolStyle(u.symbol, baseUrl)]));
    return (f) => styles.get(fields.map((name) => String(f.get(name) ?? '<Null>')).join(delimiter)) ?? fallback;
  }
  if (renderer.type === 'classBreaks' && renderer.field) {
    const field = renderer.field;
    const breaks = [...(renderer.classBreakInfos ?? [])].sort((a, b) => a.classMaxValue - b.classMaxValue).map((b) => ({ max: b.classMaxValue, style: symbolStyle(b.symbol, baseUrl) }));
    const min = renderer.minValue ?? -Infinity;
    return (f) => {
      const v = Number(f.get(field));
      if (!Number.isFinite(v) || v < min) return fallback;
      return breaks.find((b) => v <= b.max)?.style ?? fallback;
    };
  }
  const style = symbolStyle(renderer.symbol, baseUrl);
  return () => style;
}
