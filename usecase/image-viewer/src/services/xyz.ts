/**
 * XYZ tiles: a URL template with `{z}`, `{x}` and `{y}` (or `{-y}`, counted
 * from the bottom as TMS does, and `{q}`, a Bing quadkey), in Web
 * Mercator, as QGIS's XYZ connections and most tile servers have them. A
 * name for the layer can follow the template after `#name=`: it stays in
 * the browser (the fragment is never sent to the server).
 */
import { transformExtent } from 'ol/proj.js';
import { createXYZ } from 'ol/tilegrid.js';
import { ServiceError, type ServiceCatalog, type ServiceLayer } from './common.js';
import { pictureTiles } from './raster.js';

/** The one layer of an XYZ template. */
export const XYZ_LAYER = 'tiles';

/** Whether `url` is an XYZ tile template. */
export function isXyzUrl(url: string): boolean {
  return /\{z\}/i.test(url) && /\{-?y\}/i.test(url) && /\{x\}/i.test(url);
}

/** The template and the layer name of an XYZ URL (`template#name=…&zmin=…&zmax=…`). */
export function splitXyz(url: string): { template: string; name: string | null; zmin: number; zmax: number } {
  const hash = url.indexOf('#');
  const template = hash < 0 ? url : url.slice(0, hash);
  const params = new URLSearchParams(hash < 0 ? '' : url.slice(hash + 1));
  const zoom = (key: string, fallback: number) => {
    const n = Number(params.get(key));
    return params.has(key) && Number.isInteger(n) && n >= 0 && n <= 24 ? n : fallback;
  };
  return { template, name: params.get('name'), zmin: zoom('zmin', 0), zmax: zoom('zmax', 19) };
}

/** An XYZ URL with a name and zoom range (as {@link splitXyz} reads it). */
export function xyzUrl(template: string, name?: string, zmin?: number, zmax?: number): string {
  const params = new URLSearchParams();
  if (name) params.set('name', name);
  if (zmin !== undefined && zmin > 0) params.set('zmin', String(zmin));
  if (zmax !== undefined && zmax !== 19) params.set('zmax', String(zmax));
  const rest = params.toString();
  return rest ? `${template}#${rest}` : template;
}

/** The URL of the tile at z / x / y (y from the top) of a template. */
export function xyzTileUrl(template: string, z: number, x: number, y: number): string {
  const quadkey = () => {
    let q = '';
    for (let i = z; i > 0; i--) {
      const mask = 1 << (i - 1);
      q += String((x & mask ? 1 : 0) + (y & mask ? 2 : 0));
    }
    return q;
  };
  return template.replace(/\{(-?y|x|z|q)\}/gi, (_, key: string) => {
    switch (key.toLowerCase()) {
      case 'z':
        return String(z);
      case 'x':
        return String(x);
      case 'y':
        return String(y);
      case '-y':
        return String(2 ** z - 1 - y);
      default:
        return quadkey();
    }
  });
}

export async function readXyz(url: string): Promise<ServiceCatalog> {
  const { template, name, zmin, zmax } = splitXyz(url);
  if (!isXyzUrl(template)) throw new ServiceError('XYZ タイルの URL には {z}・{x}・{y} を含めてください');
  let host: string;
  try {
    host = new URL(template.replace(/\{[^}]*\}/g, '0'), location.href).host;
  } catch {
    throw new ServiceError('XYZ タイルの URL を読めませんでした');
  }
  const title = name || `XYZ タイル（${host}）`;
  return {
    kind: 'xyz',
    url,
    title,
    choices: [{ name: XYZ_LAYER, title }],
    open: async (_choice, context) => {
      const world = transformExtent([-180, -85.06, 180, 85.06], 'EPSG:4326', 'EPSG:3857');
      const tileGrid = createXYZ({ extent: world, maxZoom: zmax, minZoom: zmin, tileSize: 256 });
      const service: ServiceLayer = {
        ref: { kind: 'xyz', url, layer: XYZ_LAYER },
        title,
        layer: undefined!,
        correction: null,
        vector: null,
        extent: null,
        info: [
          ['種類', 'XYZ タイル'],
          ['URL', template],
          ['ズーム', `${zmin} – ${zmax}`],
        ],
      };
      const tiles = pictureTiles({
        url: (z, x, y) => xyzTileUrl(template, z, x, y),
        tileGrid,
        projection: 'EPSG:3857',
        gpu: context.gpu,
        onNoCors: () => context.say(`${service.title}: サーバーが CORS を許可していないため、補正せずに表示します`),
      });
      service.layer = tiles.layer;
      Object.defineProperty(service, 'correction', { get: tiles.correction });
      return service;
    },
  };
}
