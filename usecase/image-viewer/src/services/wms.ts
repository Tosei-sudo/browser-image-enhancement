/**
 * WMS: the layers of GetCapabilities (1.3.0 or 1.1.1), drawn as 256 px
 * GetMap tiles in the best CRS the layer offers (Web Mercator when it can,
 * so nothing is reprojected), and GetFeatureInfo at a clicked point.
 */
import WMSCapabilities from 'ol/format/WMSCapabilities.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import WMSGetFeatureInfo from 'ol/format/WMSGetFeatureInfo.js';
import type Feature from 'ol/Feature.js';
import { createXYZ } from 'ol/tilegrid.js';
import { transform, transformExtent } from 'ol/proj.js';
import type Projection from 'ol/proj/Projection.js';
import type { Extent } from 'ol/extent.js';
import {
  epsgCode,
  projectionOf,
  request,
  ServiceError,
  withParams,
  type Field,
  type LayerChoice,
  type OpenContext,
  type ServiceCatalog,
  type ServiceLayer,
  type ServiceTime,
} from './common.js';
import { wmsTimes, wmsTimeText } from '../time.js';
import { pictureTiles } from './raster.js';

interface WmsLayer {
  Name?: string;
  Title?: string;
  Abstract?: string;
  CRS?: string[];
  SRS?: string[];
  queryable?: boolean;
  EX_GeographicBoundingBox?: Extent;
  LatLonBoundingBox?: Extent | { extent: Extent };
  Layer?: WmsLayer[];
  /** WMS 1.3.0 dimensions (inherited from parent layers by the reader). */
  Dimension?: Array<{ name?: string; default?: string | null; values?: string }>;
}

const JSON_INFO = ['application/json', 'application/geo+json', 'application/vnd.geo+json', 'application/geojson'];
const GML_INFO = ['application/vnd.ogc.gml', 'application/vnd.ogc.gml/3.1.1', 'text/xml', 'application/gml+xml'];

/** Reads a WMS GetCapabilities document at `url` (the service URL, with or without the request). */
export async function readWms(url: string): Promise<ServiceCatalog> {
  const capsUrl = withParams(url, { SERVICE: 'WMS', REQUEST: 'GetCapabilities' });
  const text = await (await request(capsUrl)).text();
  let caps: ReturnType<WMSCapabilities['read']>;
  try {
    caps = new WMSCapabilities().read(text);
  } catch {
    throw new ServiceError('WMS の GetCapabilities を読めませんでした');
  }
  if (!caps?.Capability?.Layer) throw new ServiceError('WMS の GetCapabilities を読めませんでした');
  const version: string = caps.version ?? '1.3.0';
  const requests = caps.Capability.Request ?? {};
  const getMap: string = requests.GetMap?.DCPType?.[0]?.HTTP?.Get?.OnlineResource ?? url;
  const getInfo: string = requests.GetFeatureInfo?.DCPType?.[0]?.HTTP?.Get?.OnlineResource ?? getMap;
  const mapFormats: string[] = requests.GetMap?.Format ?? [];
  const format = ['image/png', 'image/png8', 'image/jpeg'].find((f) => mapFormats.includes(f)) ?? mapFormats.find((f) => f.startsWith('image/')) ?? 'image/png';
  const infoFormats: string[] = requests.GetFeatureInfo?.Format ?? [];
  const infoFormat = infoFormats.find((f) => JSON_INFO.includes(f)) ?? infoFormats.find((f) => GML_INFO.includes(f));

  const layers = new Map<string, WmsLayer>();
  const walk = (layer: WmsLayer) => {
    if (layer.Name) layers.set(layer.Name, layer);
    layer.Layer?.forEach(walk);
  };
  walk(caps.Capability.Layer);
  if (layers.size === 0) throw new ServiceError('表示できるレイヤーがありません');

  const choices: LayerChoice[] = [...layers.values()].map((l) => ({ name: l.Name!, title: l.Title || l.Name!, abstract: l.Abstract }));
  return {
    kind: 'wms',
    url,
    title: caps.Service?.Title || url,
    choices,
    open: (choice, context) =>
      openLayer(layers.get(choice.name)!, { url, getMap, getInfo, version, format, infoFormat }, context),
  };
}

interface Endpoint {
  url: string;
  getMap: string;
  getInfo: string;
  version: string;
  format: string;
  infoFormat?: string;
}

async function openLayer(layer: WmsLayer, ep: Endpoint, context: OpenContext): Promise<ServiceLayer> {
  const name = layer.Name!;
  const { crs, projection } = await pickCrs(layer.CRS ?? layer.SRS ?? []);
  const v13 = ep.version.startsWith('1.3');
  // WMS 1.3.0 uses the CRS's own axis order: latitude first for EPSG:4326 and the like.
  const flip = v13 && !/CRS:?84/i.test(crs) && projection.getAxisOrientation().startsWith('ne');
  const geo = geographicBox(layer);
  const gridExtent = projection.getExtent() ?? (geo ? transformExtent(geo, 'EPSG:4326', projection) : null);
  if (!gridExtent) throw new ServiceError(`${crs} の範囲が分からないため表示できません`);
  const tileGrid = createXYZ({ extent: gridExtent, maxZoom: 22, tileSize: 256 });
  // The time asked for (none: the server's default), set by the timeline.
  let time: string | null = null;
  const base = { SERVICE: 'WMS', VERSION: ep.version, LAYERS: name, STYLES: '', FORMAT: ep.format, TRANSPARENT: 'TRUE', [v13 ? 'CRS' : 'SRS']: crs };
  const bbox = (e: Extent) => (flip ? [e[1], e[0], e[3], e[2]] : e).join(',');

  const service: ServiceLayer = {
    ref: { kind: 'wms', url: ep.url, layer: name },
    title: layer.Title || name,
    layer: undefined!,
    correction: null,
    vector: null,
    extent: geo ? transformExtent(clampLat(geo), 'EPSG:4326', 'EPSG:3857') : null,
    info: [
      ['種類', 'WMS'],
      ['URL', ep.url],
      ['レイヤー名', name],
      ['座標系', crs],
      ['バージョン', ep.version],
    ],
  };
  const tiles = pictureTiles({
    url: (z, x, y) =>
      withParams(ep.getMap, { ...base, ...(time ? { TIME: time } : {}), REQUEST: 'GetMap', WIDTH: 256, HEIGHT: 256, BBOX: bbox(tileGrid.getTileCoordExtent([z, x, y])) }),
    tileGrid,
    projection,
    gpu: context.gpu,
    onNoCors: () => context.say(`${service.title}: サーバーが CORS を許可していないため、補正せずに表示します`),
  });
  service.layer = tiles.layer;
  const dimension = layer.Dimension?.find((d) => d.name?.toLowerCase() === 'time');
  if (dimension) {
    const { times, dateOnly } = wmsTimes(dimension.values ?? '');
    const timeDimension: ServiceTime = {
      values: times,
      default: dimension.default ?? undefined,
      current: () => time,
      set: (t) => {
        let next: string | null = null;
        if (t !== null) {
          // The latest time offered that is not after t (the first one before them all).
          let pick = t;
          if (times.length) {
            let i = times.length - 1;
            while (i > 0 && times[i] > t) i--;
            pick = times[i];
          }
          next = wmsTimeText(pick, dateOnly);
        }
        if (next === time) return;
        time = next;
        tiles.refresh();
      },
    };
    service.time = timeDimension;
    service.info.push(['時間', times.length ? `${wmsTimeText(times[0], dateOnly)} 〜 ${wmsTimeText(times[times.length - 1], dateOnly)}（${times.length} 時点）` : (dimension.values ?? '')]);
  }
  Object.defineProperty(service, 'correction', { get: tiles.correction });

  if (layer.queryable && ep.infoFormat) {
    const infoFormat = ep.infoFormat;
    service.featureInfo = async (coordinate, map) => {
      const view = map.getView();
      const at = transform(coordinate, view.getProjection(), projection);
      const step = transform([coordinate[0] + view.getResolution()!, coordinate[1]], view.getProjection(), projection);
      const res = Math.hypot(step[0] - at[0], step[1] - at[1]);
      const half = 50 * res;
      const url = withParams(ep.getInfo, {
        ...base,
        ...(time ? { TIME: time } : {}),
        REQUEST: 'GetFeatureInfo',
        QUERY_LAYERS: name,
        INFO_FORMAT: infoFormat,
        FEATURE_COUNT: 50,
        WIDTH: 101,
        HEIGHT: 101,
        BBOX: bbox([at[0] - half, at[1] - half, at[0] + half, at[1] + half]),
        [v13 ? 'I' : 'X']: 50,
        [v13 ? 'J' : 'Y']: 50,
      });
      const text = await (await request(url)).text();
      const options = { dataProjection: projection, featureProjection: view.getProjection() };
      const features: Feature[] = JSON_INFO.includes(infoFormat)
        ? (new GeoJSON().readFeatures(text, options) as Feature[])
        : (new WMSGetFeatureInfo().readFeatures(text, options) as Feature[]);
      return { features, fields: fieldsOf(features) };
    };
  }
  return service;
}

/** Web Mercator when offered (no reprojection), else WGS 84, else the first CRS with a known definition. */
async function pickCrs(list: string[]): Promise<{ crs: string; projection: Projection }> {
  const unique = [...new Set(list)];
  const order = [
    ...unique.filter((c) => epsgCode(c) === 3857),
    ...unique.filter((c) => epsgCode(c) === 4326),
    ...unique.filter((c) => ![3857, 4326].includes(epsgCode(c) ?? -1)),
  ];
  for (const crs of order) {
    const projection = await projectionOf(crs);
    if (projection) return { crs, projection };
  }
  throw new ServiceError('このレイヤーの座標系に対応していません');
}

function geographicBox(layer: WmsLayer): Extent | null {
  if (layer.EX_GeographicBoundingBox) return layer.EX_GeographicBoundingBox;
  const box = layer.LatLonBoundingBox;
  if (!box) return null;
  return Array.isArray(box) ? box : box.extent;
}

function clampLat(e: Extent): Extent {
  return [e[0], Math.max(e[1], -85), e[2], Math.min(e[3], 85)];
}

/** Fields of features read without a schema: every property but the geometry, as text. */
export function fieldsOf(features: Feature[]): Field[] {
  const names = new Set<string>();
  for (const f of features) for (const key of Object.keys(f.getProperties())) if (key !== f.getGeometryName()) names.add(key);
  return [...names].map((name) => {
    const values = features.map((f) => f.get(name)).filter((v) => v !== null && v !== undefined && v !== '');
    const numeric = values.length > 0 && values.every((v) => typeof v === 'number');
    return { name, alias: name, type: numeric ? 'double' : 'string', editable: false, nullable: true } satisfies Field;
  });
}
