/**
 * Esri elevation services as elevation data: an image service of heights
 * (`…/ImageServer`, such as WorldElevation/Terrain), or an elevation tile
 * service (an image service whose tile cache is LERC, such as
 * WorldElevation3D/Terrain3D). They are read on demand, for the area
 * something needs: the image being orthorectified, the tiles of the 3D
 * relief, the ground around a viewshed's observer, or the view taken in as a
 * DEM layer.
 *
 * A tile service is read from its cache (LERC tiles, decoded here, at the
 * level that gives about as many posts as asked for); any other image service
 * with `exportImage`, as 32-bit floats in longitude / latitude. Heights are
 * taken as metres above mean sea level, as DTED's are.
 */
import Lerc from 'lerc';
import { fromArrayBuffer } from 'geotiff';
import { getTransform, transformExtent, type ProjectionLike } from 'ol/proj.js';
import { DTED_VOID, type Dted } from '../dted.js';
import { resampleDem } from '../dem-geotiff.js';
import { esriJson } from './esri.js';
import { projectionOf, request, ServiceError, withParams } from './common.js';
import { authFetch, freshTokenFor, tokenFor } from '../auth.js';

/** Elevation data read on demand from a service. */
export interface ElevationSource {
  /** The service URL. */
  url: string;
  title: string;
  /** How it is read: `tiles` (its LERC tile cache) or `export` (`exportImage`). */
  kind: 'tiles' | 'export';
  /** `[west, south, east, north]` in degrees of what it covers. */
  lonLat: [number, number, number, number];
  /** Ground size of its finest post in metres, when known. */
  postSize: number | null;
  /**
   * Heights over `lonLat` (`[west, south, east, north]`, degrees) with at most
   * about `maxPosts` posts (fewer where the service has no finer data), or
   * null where it covers none of it.
   */
  read(lonLat: readonly number[], maxPosts: number): Promise<Dted | null>;
}

interface TileInfoJson {
  rows?: number;
  cols?: number;
  format?: string;
  origin?: { x: number; y: number };
  spatialReference?: { wkid?: number; latestWkid?: number };
  lods?: Array<{ level: number; resolution: number }>;
}

interface ElevationServiceJson {
  name?: string;
  extent?: { xmin: number; ymin: number; xmax: number; ymax: number; spatialReference?: { wkid?: number; latestWkid?: number } };
  bandCount?: number;
  pixelSizeX?: number;
  spatialReference?: { wkid?: number; latestWkid?: number };
  capabilities?: string;
  singleFusedMapCache?: boolean;
  cacheType?: string;
  tileInfo?: TileInfoJson;
}

/** Tiles kept decoded per service (the 3D relief asks for the same ones again). */
const TILE_CACHE = 256;
/** Requests to one service at a time. */
const CONCURRENT = 6;
/** Tiles read for one area at most: a coarser level is used beyond. */
const MAX_TILES = 400;
/** Values below this are no data too (servers fill with the lowest float). */
const LOWEST = -1e30;

/** Whether `json` describes a tile cache of LERC heights. */
function isLercCache(json: ElevationServiceJson): boolean {
  return !!json.tileInfo?.lods?.length && /lerc/i.test(json.tileInfo.format ?? '') && (json.singleFusedMapCache !== false || /elevation/i.test(json.cacheType ?? ''));
}

/** The code of an Esri spatial reference (Web Mercator under its old numbers too). */
function wkidOf(sr: { wkid?: number; latestWkid?: number } | undefined): number | null {
  const wkid = sr?.latestWkid ?? sr?.wkid;
  if (!wkid) return null;
  return wkid === 102100 || wkid === 102113 || wkid === 900913 ? 3857 : wkid;
}

/** Runs at most `n` of the tasks given at a time. */
function limiter(n: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async (task) => {
    if (running >= n) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await task();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

/** `a` cut to `b` (`[west, south, east, north]`), or null when they do not meet. */
function intersect(a: readonly number[], b: readonly number[]): [number, number, number, number] | null {
  const out: [number, number, number, number] = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return out[0] < out[2] && out[1] < out[3] ? out : null;
}

/** Ground metres per degree of longitude and latitude at `lat`. */
function metresPerDegree(lat: number): [number, number] {
  return [111_320 * Math.cos((lat * Math.PI) / 180), 110_574];
}

/**
 * Opens an Esri image service of heights, or an elevation tile service, as
 * elevation data. Throws (a ServiceError) when it is neither.
 */
export async function openElevationService(input: string, token?: string): Promise<ElevationSource> {
  const url = input.replace(/\?.*$/, '').replace(/\/+$/, '');
  if (!/\/ImageServer$/i.test(url)) throw new ServiceError('ArcGIS のイメージサービス（…/ImageServer）の URL を入れてください');
  const json = await esriJson<ElevationServiceJson>(url, {}, token);
  const title = json.name || url.split('/').slice(-2, -1)[0] || url;
  const tiles = isLercCache(json);
  if (!tiles && (json.bandCount ?? 1) !== 1) throw new ServiceError(`${title} は ${json.bandCount} バンドの画像です。標高に使えるのは 1 バンドのサービスか、LERC のタイルキャッシュを持つ標高サービスです`);
  if (!tiles && json.capabilities && !/image/i.test(json.capabilities)) throw new ServiceError(`${title} は画像を書き出せません（Image の機能がありません）`);

  const e = json.extent;
  const extentCode = wkidOf(e?.spatialReference ?? json.spatialReference);
  const extentProjection = extentCode ? await projectionOf(`EPSG:${extentCode}`) : null;
  let lonLat: [number, number, number, number] = [-180, -90, 180, 90];
  if (e && extentProjection && [e.xmin, e.ymin, e.xmax, e.ymax].every(Number.isFinite)) {
    const t = transformExtent([e.xmin, e.ymin, e.xmax, e.ymax], extentProjection, 'EPSG:4326');
    if (t.every(Number.isFinite)) lonLat = intersect(t, [-180, -90, 180, 90]) ?? lonLat;
  }
  const limit = limiter(CONCURRENT);

  if (tiles) return tileSource(url, title, json.tileInfo!, lonLat, token, limit);

  const maxSize: [number, number] = [(json as { maxImageWidth?: number }).maxImageWidth || 4000, (json as { maxImageHeight?: number }).maxImageHeight || 4000];
  const metresPerUnit = extentProjection?.getMetersPerUnit() ?? 1;
  const postSize = json.pixelSizeX && json.pixelSizeX > 0 ? json.pixelSizeX * metresPerUnit : null;
  return {
    url,
    title,
    kind: 'export',
    lonLat,
    postSize,
    read: async (area, maxPosts) => {
      const box = intersect(area, lonLat);
      if (!box) return null;
      const [w, s, east, n] = box;
      const [mx, my] = metresPerDegree((s + n) / 2);
      // As many posts as the service has there, at most maxPosts and what it exports at once.
      let width = postSize ? ((east - w) * mx) / postSize : Infinity;
      let height = postSize ? ((n - s) * my) / postSize : Infinity;
      if (!Number.isFinite(width)) {
        const side = Math.sqrt(maxPosts);
        const aspect = ((east - w) * mx) / ((n - s) * my);
        width = side * Math.sqrt(aspect);
        height = side / Math.sqrt(aspect);
      }
      const k = Math.max(1, Math.sqrt((width * height) / maxPosts), width / maxSize[0], height / maxSize[1]);
      width = Math.max(2, Math.round(width / k));
      height = Math.max(2, Math.round(height / k));
      const blob = await limit(() =>
        exportHeights(url, { bbox: box.join(','), bboxSR: '4326', imageSR: '4326', size: `${width},${height}`, format: 'tiff', pixelType: 'F32', noData: String(DTED_VOID), noDataInterpretation: 'esriNoDataMatchAny', interpolation: 'RSP_BilinearInterpolation' }, token),
      );
      const tiff = await fromArrayBuffer(await blob.arrayBuffer());
      const image = await tiff.getImage();
      const raster = (await image.readRasters({ samples: [0], interleave: true })) as unknown as ArrayLike<number>;
      const w0 = image.getWidth();
      const h0 = image.getHeight();
      const noData = image.getGDALNoData();
      const data = new Float32Array(w0 * h0);
      let any = false;
      for (let i = 0; i < data.length; i++) {
        const v = raster[i];
        const none = Number.isNaN(v) || v === noData || v === DTED_VOID || v < LOWEST;
        data[i] = none ? DTED_VOID : v;
        any ||= !none;
      }
      if (!any) return null;
      // Pixel-is-area over the box: posts at the pixels' centres.
      const dLon = (east - w) / w0;
      const dLat = (n - s) / h0;
      return { level: title, west: w + dLon / 2, south: s + dLat / 2, spacing: [dLon, dLat], width: w0, height: h0, data, verticalAccuracy: null };
    },
  };
}

/** An elevation tile service read from its LERC tiles. */
async function tileSource(
  url: string,
  title: string,
  info: TileInfoJson,
  lonLat: [number, number, number, number],
  token: string | undefined,
  limit: <T>(task: () => Promise<T>) => Promise<T>,
): Promise<ElevationSource> {
  const code = wkidOf(info.spatialReference) ?? 3857;
  const projection = await projectionOf(`EPSG:${code}`);
  if (!projection) throw new ServiceError(`${title} のタイルの座標系（EPSG:${code}）が分かりません`);
  if (!info.origin) throw new ServiceError(`${title} のタイルの原点が分かりません`);
  const origin = info.origin;
  const cols = info.cols ?? 256;
  const rows = info.rows ?? 256;
  // Finest first.
  const lods = [...info.lods!].sort((a, b) => a.resolution - b.resolution);
  const metresPerUnit = projection.getMetersPerUnit() ?? 1;
  // In Web Mercator a unit is cos(latitude) metres on the ground: at the middle of what it covers.
  const groundScale = code === 3857 ? Math.cos(((lonLat[1] + lonLat[3]) / 2) * (Math.PI / 180)) : 1;
  const postSize = lods[0].resolution * metresPerUnit * groundScale;
  const toTiles = getTransform('EPSG:4326', projection as ProjectionLike);

  const cache = new Map<string, Promise<Float32Array | null>>();
  /** A tile's heights, `cols` × `rows`, NaN where it has none; null when the service has no such tile. */
  const tile = (level: number, row: number, col: number): Promise<Float32Array | null> => {
    const key = `${level}/${row}/${col}`;
    let found = cache.get(key);
    if (found) {
      cache.delete(key);
      cache.set(key, found);
      return found;
    }
    found = limit(() => fetchTile(withParams(`${url}/tile/${level}/${row}/${col}`, { token: token ?? tokenFor(url) }), cols, rows)).catch((error: unknown) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, found);
    if (cache.size > TILE_CACHE) cache.delete(cache.keys().next().value!);
    return found;
  };

  return {
    url,
    title,
    kind: 'tiles',
    lonLat,
    postSize,
    read: async (area, maxPosts) => {
      // Web Mercator stops short of the poles.
      const box = intersect(area, code === 3857 ? [lonLat[0], Math.max(lonLat[1], -85.05), lonLat[2], Math.min(lonLat[3], 85.05)] : lonLat);
      if (!box) return null;
      const [minX, minY, maxX, maxY] = transformExtent(box, 'EPSG:4326', projection);
      // The finest level with at most twice the posts asked for (resampled down to them) and MAX_TILES tiles, else the coarsest.
      const tilesAt = (resolution: number) => {
        const c0 = Math.floor((minX - origin.x) / (resolution * cols));
        const c1 = Math.floor((maxX - origin.x) / (resolution * cols) - 1e-9);
        const r0 = Math.floor((origin.y - maxY) / (resolution * rows));
        const r1 = Math.floor((origin.y - minY) / (resolution * rows) - 1e-9);
        return { c0, c1, r0, r1, count: (c1 - c0 + 1) * (r1 - r0 + 1) };
      };
      const posts = (resolution: number) => ((maxX - minX) * (maxY - minY)) / (resolution * resolution);
      const lod = lods.find((l) => posts(l.resolution) <= 2 * maxPosts && tilesAt(l.resolution).count <= MAX_TILES) ?? lods[lods.length - 1];
      const { c0, c1, r0, r1 } = tilesAt(lod.resolution);
      const nx = c1 - c0 + 1;
      const ny = r1 - r0 + 1;
      if (nx * ny > MAX_TILES * 4) throw new ServiceError(`${title}: 範囲が広すぎます`);
      const W = nx * cols;
      const H = ny * rows;
      const data = new Float32Array(W * H).fill(NaN);
      let any = false;
      const jobs: Array<Promise<void>> = [];
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          jobs.push(
            tile(lod.level, r, c).then((heights) => {
              if (!heights) return;
              any = true;
              const x0 = (c - c0) * cols;
              const y0 = (r - r0) * rows;
              for (let y = 0; y < rows; y++) data.set(heights.subarray(y * cols, (y + 1) * cols), (y0 + y) * W + x0);
            }),
          );
        }
      }
      await Promise.all(jobs);
      if (!any) return null;
      // The pixels over the box (and one more around), so the posts keep the tiles' spacing.
      const res = lod.resolution;
      const left = origin.x + c0 * cols * res;
      const top = origin.y - r0 * rows * res;
      const x0 = Math.max(0, Math.floor((minX - left) / res) - 1);
      const x1 = Math.min(W, Math.ceil((maxX - left) / res) + 1);
      const y0 = Math.max(0, Math.floor((top - maxY) / res) - 1);
      const y1 = Math.min(H, Math.ceil((top - minY) / res) + 1);
      const cw = x1 - x0;
      const ch = y1 - y0;
      const cropped = new Float32Array(cw * ch);
      for (let y = 0; y < ch; y++) cropped.set(data.subarray((y0 + y) * W + x0, (y0 + y) * W + x1), y * cw);
      const extent = [left + x0 * res, top - y1 * res, left + x1 * res, top - y0 * res];
      const cell = resampleDem({ width: cw, height: ch, data: cropped, noData: null, extent }, (p) => toTiles(p) as number[], box, maxPosts);
      return { ...cell, level: title };
    },
  };
}

/** One LERC tile as `cols` × `rows` heights (NaN where masked), or null when the service has none there. */
async function fetchTile(url: string, cols: number, rows: number): Promise<Float32Array | null> {
  let response: Response;
  try {
    response = await authFetch(url);
  } catch {
    throw new ServiceError('標高タイルを読み込めませんでした（接続、または CORS を確認してください）');
  }
  // Tiles outside the data are missing (404), or answered with an error in JSON.
  if (response.status === 404 || response.status === 204) return null;
  if (!response.ok) throw new ServiceError(`標高タイルでサーバーがエラーを返しました（HTTP ${response.status}）`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength < 16 || new Uint8Array(buffer)[0] === 0x7b /* { */) return null;
  const block = Lerc.decode(buffer);
  const values = block.pixels[0];
  const out = new Float32Array(cols * rows);
  // Some services send cols + 1 by rows + 1 posts: take the nearest for each pixel.
  for (let y = 0; y < rows; y++) {
    const sy = block.height === rows ? y : Math.min(block.height - 1, Math.round(((y + 0.5) * block.height) / rows - 0.5));
    for (let x = 0; x < cols; x++) {
      const sx = block.width === cols ? x : Math.min(block.width - 1, Math.round(((x + 0.5) * block.width) / cols - 0.5));
      const i = sy * block.width + sx;
      const v = values[i];
      out[y * cols + x] = (block.mask && !block.mask[i]) || !(v > LOWEST) ? NaN : v;
    }
  }
  return out;
}

/** `exportImage` as a TIFF; an error in JSON becomes a ServiceError. The token in a POST. */
async function exportHeights(url: string, params: Record<string, string>, token?: string): Promise<Blob> {
  token ||= await freshTokenFor(url);
  const all = new URLSearchParams({ ...params, f: 'image', ...(token ? { token } : {}) });
  const response = token
    ? await request(`${url}/exportImage`, { method: 'POST', body: all, headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    : await request(`${url}/exportImage?${all}`);
  if (/json|text/i.test(response.headers.get('content-type') ?? '')) {
    const json = (await response.json().catch(() => null)) as { error?: { message?: string; details?: string[] } } | null;
    throw new ServiceError(`標高を読み込めませんでした: ${[json?.error?.message ?? '画像ではない応答', ...(json?.error?.details ?? [])].join(' ')}`);
  }
  return response.blob();
}
