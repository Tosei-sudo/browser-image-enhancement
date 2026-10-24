/**
 * Raw raster values from a service: what WCS and OGC API – Coverages share.
 * The values come as a GeoTIFF of the area asked for (the view, the
 * selected features, or all of it), no larger than {@link MAX_SIDE} pixels a
 * side and {@link MAX_PIXELS} in all, and open like a local GeoTIFF, so band
 * math, stretches and zonal statistics work on the values themselves.
 */
import { transformExtent } from 'ol/proj.js';
import type { Extent } from 'ol/extent.js';
import { request, ServiceError, type OpenContext, type OpenPick } from './common.js';

/** The most pixels a side, and in all, of a coverage read. */
export const MAX_SIDE = 8192;
export const MAX_PIXELS = 40_000_000;
/** The largest GeoTIFF read. */
export const MAX_BYTES = 1024 * 1024 * 1024;

/** The area asked for, in degrees (west, south, east, north); null for all of it. */
export function areaInDegrees(context: OpenContext, pick: OpenPick): Extent | null {
  if (pick.bbox) return pick.bbox;
  const which = pick.area ?? 'all';
  if (which === 'all') return null;
  const area = context.area?.(which);
  if (!area) throw new ServiceError(which === 'selection' ? '地物が未選択' : '表示範囲の取得に失敗');
  return transformExtent(area, 'EPSG:3857', 'EPSG:4326');
}

/**
 * The scale (1 or less) that brings `width` × `height` within the caps;
 * 1 when it fits already.
 */
export function fitScale(width: number, height: number): number {
  const side = Math.min(1, MAX_SIDE / Math.max(width, 1), MAX_SIDE / Math.max(height, 1));
  const total = Math.min(1, Math.sqrt(MAX_PIXELS / Math.max(width * height, 1)));
  return Math.min(side, total);
}

/** A file name made of `name`, safe for the layer list and project files, ending in `.tif`. */
export function tiffName(name: string): string {
  const base = name.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'coverage';
  return /\.tiff?$/i.test(base) ? base : `${base}.tif`;
}

/**
 * Reads a GeoTIFF from `url` (no more than {@link MAX_BYTES}); a service
 * exception (XML or JSON) becomes an error with its text.
 */
export async function fetchGeoTiff(url: string, name: string, init?: RequestInit): Promise<File> {
  const response = await request(url, init);
  if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) throw new ServiceError('画像が大きすぎ。範囲の縮小が必要');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new ServiceError('画像が大きすぎ。範囲の縮小が必要');
      }
      chunks.push(value);
    }
  } else {
    chunks.push(new Uint8Array(await response.arrayBuffer()));
  }
  const head = chunks[0] ?? new Uint8Array();
  const tiff = (head[0] === 0x49 && head[1] === 0x49) || (head[0] === 0x4d && head[1] === 0x4d);
  if (!tiff) {
    const text = new TextDecoder().decode(head.slice(0, 2000));
    const exception = /<(?:\w+:)?ExceptionText>([\s\S]*?)<\//.exec(text)?.[1] ?? (/"(?:description|detail|title)"\s*:\s*"([^"]*)"/.exec(text)?.[1]);
    throw new ServiceError(exception ? `サービスからエラー応答: ${exception.trim().slice(0, 200)}` : '応答が GeoTIFF 以外');
  }
  return new File(chunks as BlobPart[], tiffName(name), { type: 'image/tiff' });
}

/** `url` with the file name the project uses when it fetches it again (`#file=`; never sent to the server). */
export function withFileName(url: string, name: string): string {
  return `${url.replace(/#.*$/, '')}#file=${encodeURIComponent(name)}`;
}
