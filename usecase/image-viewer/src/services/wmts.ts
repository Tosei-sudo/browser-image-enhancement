/**
 * WMTS: the layers of GetCapabilities (KVP or REST), each with its tile
 * matrix sets and image formats to choose from. Web Mercator matrix sets come
 * first, since they need no reprojection.
 */
import WMTSCapabilities from 'ol/format/WMTSCapabilities.js';
import WMTS, { optionsFromCapabilities } from 'ol/source/WMTS.js';
import { transformExtent } from 'ol/proj.js';
import type { Extent } from 'ol/extent.js';
import { epsgCode, projectionOf, request, ServiceError, withParams, type LayerChoice, type ServiceCatalog, type ServiceLayer } from './common.js';
import { pictureTiles } from './raster.js';

interface WmtsLayer {
  Identifier: string;
  Title?: string;
  Abstract?: string;
  Format?: string[];
  TileMatrixSetLink?: Array<{ TileMatrixSet: string }>;
  WGS84BoundingBox?: Extent;
}

/** Reads WMTS capabilities at `url`: a `WMTSCapabilities.xml` (REST) or a KVP service URL. */
export async function readWmts(url: string): Promise<ServiceCatalog> {
  const capsUrl = /\.xml($|\?)/i.test(url) ? url : withParams(url, { SERVICE: 'WMTS', REQUEST: 'GetCapabilities' });
  const text = await (await request(capsUrl)).text();
  let caps: ReturnType<WMTSCapabilities['read']>;
  try {
    caps = new WMTSCapabilities().read(text);
  } catch {
    throw new ServiceError('WMTS の GetCapabilities を読めませんでした');
  }
  const layers: WmtsLayer[] = caps?.Contents?.Layer ?? [];
  if (layers.length === 0) throw new ServiceError('表示できるレイヤーがありません');
  const sets: Array<{ Identifier: string; SupportedCRS: string }> = caps.Contents.TileMatrixSet ?? [];
  const crsOf = (id: string) => sets.find((s) => s.Identifier === id)?.SupportedCRS ?? '';
  const rank = (id: string) => ({ 3857: 0, 4326: 1 })[epsgCode(crsOf(id)) ?? -1] ?? 2;

  const choices: LayerChoice[] = layers.map((l) => {
    const matrixSets = (l.TileMatrixSetLink ?? []).map((s) => s.TileMatrixSet).sort((a, b) => rank(a) - rank(b));
    const formats = [...(l.Format ?? [])].sort((a, b) => formatRank(a) - formatRank(b));
    return { name: l.Identifier, title: l.Title || l.Identifier, abstract: l.Abstract, matrixSets, formats };
  });

  return {
    kind: 'wmts',
    url,
    title: caps.ServiceIdentification?.Title || url,
    choices,
    open: async (choice, context, pick = {}) => {
      const layer = layers.find((l) => l.Identifier === choice.name)!;
      const matrixSet = pick.matrixSet ?? choice.matrixSets?.[0];
      const format = pick.format ?? choice.formats?.[0];
      if (!matrixSet) throw new ServiceError('タイル行列セットがありません');
      const crs = crsOf(matrixSet);
      const projection = await projectionOf(crs);
      if (!projection) throw new ServiceError(`${crs} に対応していません`);
      const options = optionsFromCapabilities(caps, { layer: choice.name, matrixSet, format, projection });
      if (!options) throw new ServiceError('このレイヤーの設定を読めませんでした');
      const fn = new WMTS(options).getTileUrlFunction();
      const service: ServiceLayer = {
        ref: { kind: 'wmts', url, layer: choice.name, matrixSet, format },
        title: choice.title,
        layer: undefined!,
        correction: null,
        vector: null,
        extent: layer.WGS84BoundingBox
          ? transformExtent([layer.WGS84BoundingBox[0], Math.max(layer.WGS84BoundingBox[1], -85), layer.WGS84BoundingBox[2], Math.min(layer.WGS84BoundingBox[3], 85)], 'EPSG:4326', 'EPSG:3857')
          : null,
        info: [
          ['種類', 'WMTS'],
          ['URL', url],
          ['レイヤー名', choice.name],
          ['タイル行列セット', matrixSet],
          ['座標系', crs],
          ['画像形式', format ?? ''],
        ],
      };
      const tiles = pictureTiles({
        url: (z, x, y) => fn([z, x, y], 1, projection) ?? '',
        tileGrid: options.tileGrid,
        projection,
        gpu: context.gpu,
        onNoCors: () => context.say(`${service.title}: サーバーが CORS を許可していないため、補正せずに表示します`),
      });
      service.layer = tiles.layer;
      Object.defineProperty(service, 'correction', { get: tiles.correction });
      return service;
    },
  };
}

function formatRank(format: string): number {
  return ['image/png', 'image/jpeg', 'image/webp'].indexOf(format) + 1 || 9;
}
