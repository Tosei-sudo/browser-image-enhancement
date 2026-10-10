/**
 * Esri image services (ImageServer) and the map image of map services
 * (MapServer), drawn as picture tiles that the viewer can correct on the GPU
 * like its own images.
 *
 * An image service is drawn with `exportImage`, one 512 px tile at a time,
 * with the mosaic rule (which images of its mosaic dataset are shown, by a
 * condition on the catalog's attributes, and in what order) and the rendering
 * rule (raster function) of its settings ({@link EsriRasterSettings}). A map
 * service is drawn from its tile cache when it has one in Web Mercator and the
 * settings leave its layers as they are, else with `export` (the layers
 * chosen, with a condition on each). A click asks `identify` what is there:
 * the pixel value and the images under it, or the features of the map's layers.
 *
 * Images cannot carry a token in a POST, so a token, when given, goes in the
 * tile URLs (as ArcGIS's own clients do); other requests send it in a POST.
 */
import Feature from 'ol/Feature.js';
import EsriJSON from 'ol/format/EsriJSON.js';
import Point from 'ol/geom/Point.js';
import { transformExtent } from 'ol/proj.js';
import { createXYZ } from 'ol/tilegrid.js';
import TileGrid from 'ol/tilegrid/TileGrid.js';
import type { Extent } from 'ol/extent.js';
import type OlMap from 'ol/Map.js';
import { esriJson, toField } from './esri.js';
import { projectionOf, request, ServiceError, withParams, type Field, type LayerChoice, type OpenContext, type ServiceLayer } from './common.js';
import {
  changesMap,
  describeSettings,
  isDefault,
  mapLayerParams,
  mosaicMethodOf,
  mosaicRuleOf,
  renderingRuleOf,
  ruleSettings,
  rulesFor,
  type EsriRasterSettings,
  type MosaicDefaults,
  type ServiceRule,
} from './esri-rules.js';
import { pictureTiles } from './raster.js';
import { fieldsOf } from './wms.js';

/** Whether `url` is an ArcGIS image service (`…/ImageServer`). */
export function isImageServerUrl(url: string): boolean {
  return /\/ImageServer\/?(\?.*)?$/i.test(url);
}

/** Whether `url` is an ArcGIS map service itself (`…/MapServer`, not one of its layers). */
export function isMapServerUrl(url: string): boolean {
  return /\/MapServer\/?(\?.*)?$/i.test(url);
}

/** The choice names of the picture layers of image and map services. */
export const IMAGE_CHOICE = 'image';
export const MAP_CHOICE = 'map';

/** One layer of a map service, for the list of layers to draw. */
export interface MapSublayer {
  id: number;
  name: string;
  parentId: number;
  /** Ids of its sublayers (a group layer). */
  children: number[];
  defaultVisibility: boolean;
  geometryType?: string;
}

/** What the rules dialog can change on an image or map service layer, and what it knows of the service. */
export interface EsriRaster {
  kind: 'image' | 'map';
  /** The service URL. */
  url: string;
  title: string;
  /** ImageServer: the attributes of the mosaic dataset's catalog. */
  fields: Field[];
  /** ImageServer: the raster functions the service offers. */
  rasterFunctions: Array<{ name: string; description?: string }>;
  /** ImageServer: the mosaic methods the service allows (as mosaic rule methods), and its default. */
  mosaicMethods: string[];
  defaults: MosaicDefaults;
  /** ImageServer: the number of bands. */
  bandCount: number;
  /** MapServer: its layers. */
  sublayers: MapSublayer[];
  /** The presets of config.json for this service. */
  rules: ServiceRule[];
  get(): EsriRasterSettings;
  /** Draws with other settings. */
  set(settings: EsriRasterSettings): void;
  /** ImageServer: how many images of the catalog meet `where` (null when the service cannot count). */
  count(where: string): Promise<number | null>;
  /** ImageServer: the values an attribute has in the catalog (up to 200), for picking a condition. */
  values(field: string): Promise<Array<string | number>>;
  /** ImageServer: the view as a GeoTIFF of the stored values (no stretch), as drawn now; null for map services. */
  exportView?: (map: OlMap) => Promise<{ blob: Blob; name: string }>;
}

interface TileInfo {
  rows?: number;
  cols?: number;
  format?: string;
  origin?: { x: number; y: number };
  spatialReference?: { wkid?: number; latestWkid?: number };
  lods?: Array<{ level: number; resolution: number }>;
}

interface EsriExtentJson {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  spatialReference?: { wkid?: number; latestWkid?: number; wkt?: string };
}

interface ImageServerJson {
  name?: string;
  description?: string;
  extent?: EsriExtentJson;
  fullExtent?: EsriExtentJson;
  pixelType?: string;
  bandCount?: number;
  fields?: Parameters<typeof toField>[0][];
  rasterFunctionInfos?: Array<{ name: string; description?: string }>;
  allowedMosaicMethods?: string;
  defaultMosaicMethod?: string;
  sortField?: string;
  sortValue?: string | number | null;
  sortAscending?: boolean;
  mosaicOperator?: string;
  maxImageWidth?: number;
  maxImageHeight?: number;
  capabilities?: string;
  singleFusedMapCache?: boolean;
  tileInfo?: TileInfo;
  serviceDataType?: string;
}

interface MapServerJson {
  mapName?: string;
  documentInfo?: { Title?: string };
  layers?: Array<{ id: number; name: string; parentLayerId?: number; defaultVisibility?: boolean; subLayerIds?: number[] | null; geometryType?: string; type?: string }>;
  fullExtent?: EsriExtentJson;
  initialExtent?: EsriExtentJson;
  singleFusedMapCache?: boolean;
  tileInfo?: TileInfo;
  maxImageWidth?: number;
  maxImageHeight?: number;
}

const TILE = 512;
const PICTURE_FORMATS = ['PNG', 'PNG8', 'PNG24', 'PNG32', 'JPEG', 'JPG', 'MIXED', 'JPGPNG'];

/** The image service's single choice. */
export async function imageServerChoice(serviceUrl: string, token?: string): Promise<{ title: string; choice: LayerChoice }> {
  const json = await esriJson<ImageServerJson>(serviceUrl, {}, token);
  const title = json.name || serviceUrl.split('/').slice(-2, -1)[0] || serviceUrl;
  const bands = json.bandCount ? `${json.bandCount} バンド` : '';
  return { title, choice: { name: IMAGE_CHOICE, title, abstract: ['イメージサービス', bands, json.pixelType].filter(Boolean).join('・') } };
}

/** Opens an image service as a picture layer. */
export async function openImageServer(serviceUrl: string, context: OpenContext, settings?: EsriRasterSettings): Promise<ServiceLayer> {
  const token = context.token;
  const json = await esriJson<ImageServerJson>(serviceUrl, {}, token);
  const title = json.name || serviceUrl.split('/').slice(-2, -1)[0] || serviceUrl;
  const rules = rulesFor(context.rules ?? [], serviceUrl);
  let current: EsriRasterSettings = settings ?? (rules.find((r) => r.default) ? ruleSettings(rules.find((r) => r.default)!) : {});
  const defaults: MosaicDefaults = {
    method: json.defaultMosaicMethod,
    sortField: json.sortField || undefined,
    sortValue: json.sortValue,
    ascending: json.sortAscending,
    operation: json.mosaicOperator,
  };
  const extent = await extentOf(json.extent ?? json.fullExtent);
  const cache = cacheGrid(json.singleFusedMapCache ? json.tileInfo : undefined, extent);
  const grid = createXYZ({ extent: transformExtent([-180, -85.06, 180, 85.06], 'EPSG:4326', 'EPSG:3857'), maxZoom: 22, tileSize: TILE });
  const tileGrid = cache ?? grid;

  /** Query parameters of `exportImage` (and `identify`) for the settings. */
  const ruleParams = (s: EsriRasterSettings, rendering = true): Record<string, string> => {
    const params: Record<string, string> = {};
    const mosaic = mosaicRuleOf(s, defaults);
    if (mosaic) params.mosaicRule = JSON.stringify(mosaic);
    const render = rendering ? renderingRuleOf(s) : undefined;
    if (render) params.renderingRule = JSON.stringify(render);
    if (rendering && s.bandIds?.length) params.bandIds = s.bandIds.join(',');
    return params;
  };
  const tileUrl = (z: number, x: number, y: number): string => {
    if (cache && isDefault(current)) {
      const level = cache.lods[z];
      return withParams(`${serviceUrl}/tile/${level}/${y}/${x}`, { token });
    }
    const e = tileGrid.getTileCoordExtent([z, x, y]);
    const size = tileGrid.getTileSize(z) as number | number[];
    const [w, h] = Array.isArray(size) ? size : [size, size];
    return withParams(`${serviceUrl}/exportImage`, {
      bbox: e.join(','),
      bboxSR: '3857',
      imageSR: '3857',
      size: `${w},${h}`,
      format: 'jpgpng',
      interpolation: 'RSP_BilinearInterpolation',
      ...ruleParams(current),
      token,
      f: 'image',
    });
  };

  const service: ServiceLayer = {
    ref: { kind: 'esri', url: serviceUrl, layer: IMAGE_CHOICE, ...(isDefault(current) && !current.rule ? {} : { settings: current }) },
    title,
    layer: undefined!,
    correction: null,
    vector: null,
    extent,
    info: [],
  };
  const baseInfo: Array<[string, string]> = [
    ['種類', 'Esri イメージサービス'],
    ['URL', serviceUrl],
    ...(json.bandCount ? [['バンド数', String(json.bandCount)] as [string, string]] : []),
    ...(json.pixelType ? [['画素の型', json.pixelType] as [string, string]] : []),
    ...(cache ? [['タイルキャッシュ', '既定の表示のときに使用'] as [string, string]] : []),
  ];
  const tiles = pictureTiles({
    url: tileUrl,
    tileGrid,
    projection: 'EPSG:3857',
    gpu: context.gpu,
    onNoCors: () => context.say(`${title}: サーバーが CORS を許可していないため、補正せずに表示します`),
  });
  service.layer = tiles.layer;
  if (extent) tiles.layer.setExtent(extent);
  Object.defineProperty(service, 'correction', { get: tiles.correction });
  const updateInfo = () => {
    service.info.length = 0;
    service.info.push(...baseInfo, ...describeSettings(current));
  };
  updateInfo();

  const canCatalog = /catalog/i.test(json.capabilities ?? 'Catalog');
  const fields = canCatalog ? (json.fields ?? []).map((f) => toField(f, false, new Set())).filter((f): f is Field => f !== null) : [];
  const allowed = (json.allowedMosaicMethods ?? '').split(',').map((m) => mosaicMethodOf(m)).filter((m): m is string => !!m);
  const maxSize: [number, number] = [json.maxImageWidth || 4000, json.maxImageHeight || 4000];

  const raster: EsriRaster = {
    kind: 'image',
    url: serviceUrl,
    title,
    fields,
    rasterFunctions: json.rasterFunctionInfos ?? [],
    mosaicMethods: allowed,
    defaults,
    bandCount: json.bandCount ?? 0,
    sublayers: [],
    rules,
    get: () => current,
    set: (next) => {
      // Fails here (bad JSON), not in every tile.
      renderingRuleOf(next);
      current = { ...next };
      service.ref = { kind: 'esri', url: serviceUrl, layer: IMAGE_CHOICE, ...(isDefault(current) && !current.rule ? {} : { settings: current }) };
      updateInfo();
      tiles.refresh();
    },
    count: async (where) => {
      if (!canCatalog) return null;
      const result = await esriJson<{ count?: number }>(`${serviceUrl}/query`, { where: where.trim() || '1=1', returnCountOnly: 'true' }, token).catch(() => null);
      return typeof result?.count === 'number' ? result.count : null;
    },
    values: async (field) => {
      if (!canCatalog) return [];
      const result = await esriJson<{ features?: Array<{ attributes?: Record<string, unknown> }> }>(
        `${serviceUrl}/query`,
        { where: '1=1', outFields: field, returnDistinctValues: 'true', returnGeometry: 'false', orderByFields: field, resultRecordCount: '200' },
        token,
      ).catch(() => null);
      const values = (result?.features ?? []).map((f) => f.attributes?.[field]).filter((v): v is string | number => typeof v === 'string' || typeof v === 'number');
      return [...new Set(values)].slice(0, 200);
    },
    exportView: async (map) => {
      const size = map.getSize();
      if (!size) throw new ServiceError('地図の大きさが分かりません');
      const view = map.getView().calculateExtent(size);
      const bbox = transformExtent(view, map.getView().getProjection(), 'EPSG:3857');
      const ratio = Math.min(1, maxSize[0] / (size[0] * devicePixelRatio), maxSize[1] / (size[1] * devicePixelRatio));
      const w = Math.max(1, Math.round(size[0] * devicePixelRatio * ratio));
      const h = Math.max(1, Math.round(size[1] * devicePixelRatio * ratio));
      // The stored values unless a raster function was chosen: the viewer stretches them itself.
      const raw = renderingRuleOf(current) ? current : { ...current, rasterFunction: 'None', renderingRule: undefined };
      const blob = await esriBinary(
        `${serviceUrl}/exportImage`,
        { bbox: bbox.join(','), bboxSR: '3857', imageSR: '3857', size: `${w},${h}`, format: 'tiff', compression: 'LZ77', ...ruleParams(raw) },
        token,
      );
      return { blob, name: `${title}_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}.tif` };
    },
  };
  service.raster = raster;

  service.featureInfo = async (coordinate, map) => {
    const view = map.getView();
    const [x, y] = coordinate;
    const res = view.getResolution() ?? 1;
    const result = await esriJson<{
      value?: string;
      name?: string;
      catalogItems?: { features?: Array<{ attributes?: Record<string, unknown>; geometry?: object }>; spatialReference?: { wkid?: number; latestWkid?: number } } | null;
      catalogItemVisibilities?: number[];
    }>(
      `${serviceUrl}/identify`,
      {
        geometry: JSON.stringify({ x, y, spatialReference: { wkid: 3857 } }),
        geometryType: 'esriGeometryPoint',
        pixelSize: JSON.stringify({ x: res, y: res, spatialReference: { wkid: 3857 } }),
        returnGeometry: 'false',
        returnCatalogItems: String(canCatalog),
        ...ruleParams(current, false),
      },
      token,
    );
    const value = result.value ?? '';
    const items = result.catalogItems?.features ?? [];
    if (!items.length) {
      const feature = new Feature({ geometry: new Point(coordinate), 画素値: value });
      return { features: [feature], fields: fieldsOf([feature]) };
    }
    const sr = result.catalogItems?.spatialReference;
    const projection = (await projectionOf(`EPSG:${sr?.latestWkid ?? sr?.wkid ?? 3857}`)) ?? 'EPSG:3857';
    const format = new EsriJSON();
    const visible = result.catalogItemVisibilities ?? [];
    const features = items.map((item, i) => {
      const f = format.readFeature({ ...item, attributes: item.attributes ?? {} }, { dataProjection: projection, featureProjection: view.getProjection() }) as Feature;
      f.set('表示', visible[i] === 0 ? '下に隠れている' : '表示中');
      if (visible[i] !== 0) f.set('画素値', value);
      return f;
    });
    // The images shown first.
    features.sort((a, b) => (a.get('表示') === '表示中' ? 0 : 1) - (b.get('表示') === '表示中' ? 0 : 1));
    const extra: Field[] = [
      { name: '表示', alias: '表示', type: 'string', editable: false, nullable: true },
      { name: '画素値', alias: '画素値', type: 'string', editable: false, nullable: true },
    ];
    return { features, fields: [...extra, ...(fields.length ? fields : fieldsOf(features).filter((f) => f.name !== '表示' && f.name !== '画素値'))] };
  };
  return service;
}

/** The map service's choice of its whole map, drawn by the server. */
export function mapChoice(title: string): LayerChoice {
  return { name: MAP_CHOICE, title: `${title}（地図画像）`, abstract: 'サーバーが描いた地図をそのまま重ねます（レイヤーの表示と条件は「表示ルール」で変えられます）' };
}

/** Opens the map of a map service as a picture layer. */
export async function openMapServer(serviceUrl: string, context: OpenContext, settings?: EsriRasterSettings): Promise<ServiceLayer> {
  const token = context.token;
  const json = await esriJson<MapServerJson>(serviceUrl, {}, token);
  const title = json.documentInfo?.Title || json.mapName || serviceUrl.split('/').slice(-2, -1)[0] || serviceUrl;
  const rules = rulesFor(context.rules ?? [], serviceUrl);
  let current: EsriRasterSettings = settings ?? (rules.find((r) => r.default) ? ruleSettings(rules.find((r) => r.default)!) : {});
  const extent = await extentOf(json.fullExtent ?? json.initialExtent);
  const cache = cacheGrid(json.singleFusedMapCache ? json.tileInfo : undefined, extent);
  const tileGrid = cache ?? createXYZ({ extent: transformExtent([-180, -85.06, 180, 85.06], 'EPSG:4326', 'EPSG:3857'), maxZoom: 22, tileSize: TILE });
  const sublayers: MapSublayer[] = (json.layers ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    parentId: l.parentLayerId ?? -1,
    children: l.subLayerIds ?? [],
    defaultVisibility: l.defaultVisibility !== false,
    geometryType: l.geometryType,
  }));

  const tileUrl = (z: number, x: number, y: number): string => {
    if (cache && !changesMap(current)) return withParams(`${serviceUrl}/tile/${cache.lods[z]}/${y}/${x}`, { token });
    const e = tileGrid.getTileCoordExtent([z, x, y]);
    const size = tileGrid.getTileSize(z) as number | number[];
    const [w, h] = Array.isArray(size) ? size : [size, size];
    return withParams(`${serviceUrl}/export`, {
      bbox: e.join(','),
      bboxSR: '3857',
      imageSR: '3857',
      size: `${w},${h}`,
      dpi: '96',
      format: 'png32',
      transparent: 'true',
      ...mapLayerParams(current),
      token,
      f: 'image',
    });
  };
  const service: ServiceLayer = {
    ref: { kind: 'esri', url: serviceUrl, layer: MAP_CHOICE, ...(isDefault(current) && !current.rule ? {} : { settings: current }) },
    title,
    layer: undefined!,
    correction: null,
    vector: null,
    extent,
    info: [],
  };
  const baseInfo: Array<[string, string]> = [
    ['種類', 'Esri マップサービス（地図画像）'],
    ['URL', serviceUrl],
    ['レイヤー数', String(sublayers.filter((l) => !l.children.length).length)],
    ...(cache ? [['タイルキャッシュ', 'レイヤーの表示と条件が既定のときに使用'] as [string, string]] : []),
  ];
  const updateInfo = () => {
    service.info.length = 0;
    service.info.push(...baseInfo, ...describeSettings(current));
  };
  updateInfo();
  const tiles = pictureTiles({
    url: tileUrl,
    tileGrid,
    projection: 'EPSG:3857',
    gpu: context.gpu,
    onNoCors: () => context.say(`${title}: サーバーが CORS を許可していないため、補正せずに表示します`),
  });
  service.layer = tiles.layer;
  if (extent) tiles.layer.setExtent(extent);
  Object.defineProperty(service, 'correction', { get: tiles.correction });

  service.raster = {
    kind: 'map',
    url: serviceUrl,
    title,
    fields: [],
    rasterFunctions: [],
    mosaicMethods: [],
    defaults: {},
    bandCount: 0,
    sublayers,
    rules,
    get: () => current,
    set: (next) => {
      current = { ...next };
      service.ref = { kind: 'esri', url: serviceUrl, layer: MAP_CHOICE, ...(isDefault(current) && !current.rule ? {} : { settings: current }) };
      updateInfo();
      tiles.refresh();
    },
    count: async () => null,
    values: async () => [],
  };

  service.featureInfo = async (coordinate, map) => {
    const view = map.getView();
    const size = map.getSize() ?? [1, 1];
    const mapExtent = transformExtent(view.calculateExtent(size), view.getProjection(), 'EPSG:3857');
    const shown = current.layers;
    const params = mapLayerParams(current);
    const result = await esriJson<{ results?: Array<{ layerId: number; layerName: string; attributes?: Record<string, unknown>; geometry?: object; geometryType?: string }> }>(
      `${serviceUrl}/identify`,
      {
        geometry: `${coordinate[0]},${coordinate[1]}`,
        geometryType: 'esriGeometryPoint',
        sr: '3857',
        layers: shown ? `visible:${shown.length ? shown.join(',') : '-1'}` : 'visible',
        ...(params.layerDefs ? { layerDefs: params.layerDefs } : {}),
        tolerance: '5',
        mapExtent: mapExtent.join(','),
        imageDisplay: `${size[0]},${size[1]},96`,
        returnGeometry: 'true',
      },
      token,
    );
    const format = new EsriJSON();
    const features = (result.results ?? []).map((r) => {
      const f = r.geometry
        ? (format.readFeature({ geometry: r.geometry, attributes: r.attributes ?? {} }, { dataProjection: 'EPSG:3857', featureProjection: view.getProjection() }) as Feature)
        : (format.readFeature({ attributes: r.attributes ?? {} }) as Feature);
      f.set('レイヤー', r.layerName);
      return f;
    });
    const all = fieldsOf(features);
    return { features, fields: [...all.filter((f) => f.name === 'レイヤー'), ...all.filter((f) => f.name !== 'レイヤー')] };
  };
  return service;
}

/** A Web Mercator tile cache as a tile grid (with the cache levels by zoom), or null when there is none the viewer can use. */
function cacheGrid(info: TileInfo | undefined, extent: Extent | null): (TileGrid & { lods: number[] }) | null {
  if (!info?.origin || !info.lods?.length) return null;
  const wkid = info.spatialReference?.latestWkid ?? info.spatialReference?.wkid;
  if (wkid !== 3857 && wkid !== 102100 && wkid !== 102113 && wkid !== 900913) return null;
  if (info.format && !PICTURE_FORMATS.includes(info.format.toUpperCase())) return null;
  const lods = [...info.lods].sort((a, b) => b.resolution - a.resolution);
  const grid = new TileGrid({
    origin: [info.origin.x, info.origin.y],
    resolutions: lods.map((l) => l.resolution),
    tileSize: [info.cols ?? 256, info.rows ?? 256],
    ...(extent ? { extent } : {}),
  });
  return Object.assign(grid, { lods: lods.map((l) => l.level) });
}

/** An extent of the REST API in Web Mercator, or null when it is missing or in an unknown CRS. */
async function extentOf(e: EsriExtentJson | undefined): Promise<Extent | null> {
  if (!e || ![e.xmin, e.ymin, e.xmax, e.ymax].every(Number.isFinite)) return null;
  const wkid = e.spatialReference?.latestWkid ?? e.spatialReference?.wkid;
  if (!wkid) return null;
  const projection = await projectionOf(`EPSG:${wkid}`);
  if (!projection) return null;
  const out = transformExtent([e.xmin, e.ymin, e.xmax, e.ymax], projection, 'EPSG:3857');
  return out.every(Number.isFinite) ? out : null;
}

/** A binary answer (`f=image`) of the REST API; the token in a POST. An error in JSON becomes a ServiceError. */
async function esriBinary(url: string, params: Record<string, string>, token?: string): Promise<Blob> {
  const all = new URLSearchParams({ ...params, f: 'image', ...(token ? { token } : {}) });
  const response = token
    ? await request(url, { method: 'POST', body: all, headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    : await request(`${url}?${all}`);
  const type = response.headers.get('content-type') ?? '';
  if (/json|text/i.test(type)) {
    const json = (await response.json().catch(() => null)) as { error?: { message?: string; details?: string[] } } | null;
    throw new ServiceError(`サービスがエラーを返しました: ${[json?.error?.message ?? '画像ではない応答', ...(json?.error?.details ?? [])].join(' ')}`);
  }
  return response.blob();
}
