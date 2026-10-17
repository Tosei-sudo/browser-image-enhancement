/**
 * Placing a raster that has no projection (a picture, a scanned map, a TIFF
 * without georeferencing or without a CRS): a CRS and an affine transform
 * from its pixels to that CRS's coordinates, from a world file (.tfw, .jgw,
 * .pgw…), a GDAL .aux.xml, a .prj, the extent's corners, or four corner
 * points (rotation allowed).
 *
 * A north-up placement becomes the GeoTIFF's own georeferencing (pixel size
 * and tie point), shown in the CRS like any GeoTIFF. A rotated one keeps the
 * pixels as a projection of their own that the map warps through the affine
 * transform as it draws, as satellite images are (see sensor-projection.ts).
 */
import proj4 from 'proj4';
import { register } from 'ol/proj/proj4.js';
import { get as getProjection, getTransform } from 'ol/proj.js';
import type Projection from 'ol/proj/Projection.js';
import type { GeoTIFFRaster } from 'browser-image-enhancement/openlayers';
import { projectionOf } from './services/common.js';
import { crsCodeOfWkt, crsPresetName } from './processing/reproject.js';
import { sensorGeo, sensorProjection } from './sensor-projection.js';

/** How a placement was made, for the information panel. */
export type GeorefMethod = 'worldfile' | 'aux' | 'extent' | 'corners' | 'keep';

/** Where a raster's pixels are: its CRS and the affine transform to it. */
export interface Georef {
  /** `EPSG:6677`, or a WKT (from a .prj or .aux.xml that names no EPSG code). */
  crs: string;
  /**
   * GDAL's GeoTransform: x = t[0] + t[1]·col + t[2]·row, y = t[3] + t[4]·col +
   * t[5]·row, col and row counted from the top-left corner of the first pixel.
   */
  transform: number[];
  method: GeorefMethod;
  /** The side file it came from. */
  from?: string;
}

/** Placement found in side files, perhaps without a CRS (a world file alone) or without a transform (a .prj alone). */
export interface SideGeoref {
  crs: string | null;
  transform: number[] | null;
  method: GeorefMethod;
  from: string;
}

const worldFile = /\.(tfw|tifw|tiffw|jgw|jpgw|jpegw|pgw|pngw|gfw|gifw|bpw|bmpw|j2w|jp2w|wld)$/i;

/** Whether `name` is a world file. */
export function isWorldFileName(name: string): boolean {
  return worldFile.test(name);
}

/** Whether `name` is a GDAL side file (`a.png.aux.xml`). */
export function isAuxXmlName(name: string): boolean {
  return /\.aux\.xml$/i.test(name);
}

/** The image name (without extension, lower case) a world file, .aux.xml or .prj belongs to. */
export function sideBaseName(name: string): string {
  const file = name.split(/[\\/]/).pop() ?? name;
  return file
    .replace(/\.aux\.xml$/i, '')
    .replace(/\.[^.]*$/, '')
    .toLowerCase();
}

/** The six numbers of a world file (A, D, B, E, C, F, one a line) as a GeoTransform; throws when it has not got them. */
export function parseWorldFile(text: string): number[] {
  const values = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .slice(0, 6)
    .map((l) => Number(l.replace(/,/g, '.')));
  if (values.length < 6 || !values.every(Number.isFinite)) throw new Error('ワールドファイルには数字が 6 行必要です');
  const [a, d, b, e, c, f] = values;
  if (a * e - b * d === 0) throw new Error('ワールドファイルの画素の大きさが 0 です');
  // C and F are the centre of the top-left pixel; the GeoTransform starts at its corner.
  return [c - a / 2 - b / 2, a, b, f - d / 2 - e / 2, d, e];
}

/** A GeoTransform as a world file's text. */
export function worldFileText(t: readonly number[]): string {
  const [x0, a, b, y0, d, e] = t;
  return [a, d, b, e, x0 + a / 2 + b / 2, y0 + d / 2 + e / 2].map((v) => String(v)).join('\n') + '\n';
}

/** The CRS (`<SRS>`) and GeoTransform of a GDAL .aux.xml, either may be missing. */
export function parseAuxXml(text: string): { crs: string | null; transform: number[] | null } {
  const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const srs = /<SRS[^>]*>([\s\S]*?)<\/SRS>/i.exec(text)?.[1]?.trim();
  const gt = /<GeoTransform>([\s\S]*?)<\/GeoTransform>/i.exec(text)?.[1];
  const transform = gt ? gt.split(/[\s,]+/).filter((v) => v !== '').map(Number) : null;
  return {
    crs: srs ? unescape(srs) : null,
    transform: transform && transform.length === 6 && transform.every(Number.isFinite) && transform[1] * transform[5] - transform[2] * transform[4] !== 0 ? transform : null,
  };
}

/** The GeoTransform that puts a `width` × `height` image over `extent` (west, south, east, north), north up. */
export function extentTransform([west, south, east, north]: readonly number[], width: number, height: number): number[] {
  if (!(east > west && north > south)) throw new Error('範囲は 左 < 右、下 < 上 にしてください');
  return [west, (east - west) / width, 0, north, 0, -(north - south) / height];
}

/**
 * The GeoTransform that best puts the corners of a `width` × `height` image
 * (top left, top right, bottom right, bottom left) at `points` (x, y in the
 * CRS; a missing one is left out), by least squares; throws for fewer than 3
 * points or points in a line.
 */
export function cornersTransform(points: ReadonlyArray<readonly [number, number] | null>, width: number, height: number): number[] {
  const corners = [[0, 0], [width, 0], [width, height], [0, height]];
  const rows: number[][] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  points.forEach((p, i) => {
    if (!p || !p.every(Number.isFinite)) return;
    rows.push([1, corners[i][0], corners[i][1]]);
    xs.push(p[0]);
    ys.push(p[1]);
  });
  if (rows.length < 3) throw new Error('四隅のうち 3 点以上の座標を入れてください');
  const cx = solve3(rows, xs);
  const cy = solve3(rows, ys);
  if (!cx || !cy || cx[1] * cy[2] - cx[2] * cy[1] === 0) throw new Error('四隅の座標が一直線に並んでいます');
  return [cx[0], cx[1], cx[2], cy[0], cy[1], cy[2]];
}

/** The least-squares solution of rows · c = values for three unknowns; null when singular. */
function solve3(rows: readonly number[][], values: readonly number[]): number[] | null {
  // Centred for conditioning: projected coordinates are millions, pixels thousands.
  const a = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
  rows.forEach((r, k) => {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) a[i][j] += r[i] * r[j];
      a[i][3] += r[i] * values[k];
    }
  });
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (!(Math.abs(a[p][c]) > 1e-12 * Math.max(1, Math.abs(a[0][0])))) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k <= 3; k++) a[r][k] -= f * a[c][k];
    }
  }
  return a.map((r, i) => r[3] / r[i]);
}

/** The four corners of a `width` × `height` image placed by `t` (top left, top right, bottom right, bottom left). */
export function transformCorners(t: readonly number[], width: number, height: number): Array<[number, number]> {
  return [[0, 0], [width, 0], [width, height], [0, height]].map(([c, r]) => [t[0] + t[1] * c + t[2] * r, t[3] + t[4] * c + t[5] * r]);
}

/** Whether `t` reads like longitude and latitude: the image within ±180°, ±90° and its pixels under a degree. */
export function looksLikeDegrees(t: readonly number[], width: number, height: number): boolean {
  return transformCorners(t, width, height).every(([x, y]) => Math.abs(x) <= 180 && Math.abs(y) <= 90) && Math.abs(t[1]) < 1 && Math.abs(t[5]) < 1;
}

/** `EPSG:6677` for `6677`, `epsg:6677` or a WKT that names it; the WKT itself when it names none; null for nothing. */
export function normalizeCrs(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return `EPSG:${trimmed}`;
  const code = /^EPSG\s*:\s*(\d+)/i.exec(trimmed);
  if (code) return `EPSG:${code[1]}`;
  if (/^\s*[A-Z]+\s*\[/i.test(trimmed)) return crsCodeOfWkt(trimmed) ?? trimmed;
  return null;
}

/** The CRS for people: `JGD2011 平面直角座標系 IX 系（EPSG:6677）`, `EPSG:2451`, or a WKT's name. */
export function crsLabel(crs: string): string {
  if (/^EPSG:\d+$/.test(crs)) {
    const name = crsPresetName(crs);
    return name ? `${name}（${crs}）` : crs;
  }
  return /^\s*\w+\s*\[\s*"([^"]+)"/.exec(crs)?.[1] ?? 'WKT';
}

let wkts = 0;
const wktCodes = new Map<string, string>();

/**
 * The projection of `crs`: an EPSG code, loaded from the registry in
 * config.json when it is not built in, or a WKT proj4 can read; null when
 * neither works.
 */
export async function crsProjection(crs: string): Promise<Projection | null> {
  if (/^EPSG:\d+$/.test(crs)) return projectionOf(crs);
  let code = wktCodes.get(crs);
  if (!code) {
    code = `WKT:${++wkts}`;
    try {
      proj4.defs(code, crs);
      register(proj4);
    } catch {
      return null;
    }
    wktCodes.set(crs, code);
  }
  return getProjection(code);
}

/** GeoKeys naming an EPSG CRS (geographic or projected), or none for a CRS without a code. */
function geoKeys(crs: string, projection: Projection): number[] {
  const code = /^EPSG:(\d+)$/.exec(crs)?.[1];
  if (!code || Number(code) > 65535) return [1, 1, 0, 0];
  const geographic = projection.getUnits() === 'degrees';
  return [1, 1, 0, 3, 1024, 0, 1, geographic ? 2 : 1, 1025, 0, 1, 1, geographic ? 2048 : 3072, 0, 1, Number(code)];
}

/**
 * The georeferencing and projection that put a `width` × `height` image
 * where `georef` says: the GeoTIFF's own (north up), or its pixels as a
 * projection warped through the transform (rotated or flipped). Throws, with
 * a message for the person, when the CRS is not known.
 */
export async function georefPlacement(georef: Georef, width: number, height: number): Promise<{ geo: NonNullable<GeoTIFFRaster['geo']>; projection: Projection }> {
  const projection = await crsProjection(georef.crs);
  if (!projection) throw new Error(`座標系 ${crsLabel(georef.crs)} の定義が見つかりません`);
  const t = georef.transform;
  if (t.length !== 6 || !t.every(Number.isFinite)) throw new Error('配置の値が正しくありません');
  const northUp = t[2] === 0 && t[4] === 0 && t[1] > 0 && t[5] < 0;
  if (northUp) {
    return {
      geo: { modelPixelScale: [t[1], -t[5], 0], modelTiepoint: [0, 0, 0, t[0], t[3], 0], geoKeyDirectory: geoKeys(georef.crs, projection) },
      projection,
    };
  }
  const det = t[1] * t[5] - t[2] * t[4];
  const toLonLat = getTransform(projection, 'EPSG:4326');
  const fromLonLat = getTransform('EPSG:4326', projection);
  const model = {
    toLonLat: (x: number, y: number) => toLonLat([t[0] + t[1] * x + t[2] * y, t[3] + t[4] * x + t[5] * y]) as [number, number],
    toPixel: (lon: number, lat: number): [number, number] => {
      const [gx, gy] = fromLonLat([lon, lat]);
      const dx = gx - t[0];
      const dy = gy - t[3];
      return [(t[5] * dx - t[2] * dy) / det, (t[1] * dy - t[4] * dx) / det];
    },
  };
  return { geo: { ...sensorGeo(), geoKeyDirectory: [1, 1, 0, 0] }, projection: sensorProjection(model, width, height, { kind: 'affine', crs: crsLabel(georef.crs) }) };
}

/** Where an image without a projection goes: at the origin of Web Mercator, one metre a pixel, as the viewer puts pictures. */
export function unplacedGeo(width: number, height: number): NonNullable<GeoTIFFRaster['geo']> {
  return {
    modelPixelScale: [1, 1, 0],
    modelTiepoint: [0, 0, 0, -width / 2, height / 2, 0],
    geoKeyDirectory: [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 3857],
  };
}

/** How a placement was made, for the information panel. */
export function describeGeoref(georef: Georef): string {
  const how = { worldfile: 'ワールドファイル', aux: '.aux.xml', extent: '範囲', corners: '四隅の座標', keep: '画像の座標' }[georef.method];
  return `${how}${georef.from ? `（${georef.from}）` : ''}・${crsLabel(georef.crs)}`;
}

/** Reads a GeoTIFF's GeoTransform from its pixel size and tie point, or its ModelTransformation; null when it has neither. */
export function ownTransform(scale: readonly number[] | undefined, tiepoint: readonly number[] | undefined, matrix: readonly number[] | undefined): number[] | null {
  if (scale && tiepoint && tiepoint.length >= 6) {
    const [i, j, , x, y] = tiepoint;
    return [x - i * scale[0], scale[0], 0, y + j * scale[1], 0, -scale[1]];
  }
  if (matrix && matrix.length >= 8) return [matrix[3], matrix[0], matrix[1], matrix[7], matrix[4], matrix[5]];
  return null;
}
