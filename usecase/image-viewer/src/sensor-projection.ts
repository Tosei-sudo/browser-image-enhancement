/**
 * Satellite images shown where they belong without orthorectifying them
 * first: the image keeps its own pixel grid as a projection of its own, and
 * the map reprojects its tiles through the image's sensor model as they are
 * drawn, like any other image in a CRS different from the map's.
 *
 * The model is the image's RPC at one height (the model's height offset,
 * near the scene's mean ground height), or, for an image with ground
 * control points only, a polynomial fitted to them. Only the corners of each
 * tile's triangulation go through the model, so a tile costs a few hundred
 * model evaluations, not one per pixel: as fast as a UTM image on the
 * Web Mercator map. The relief is not corrected (see the orthorectification
 * in geometric.ts for that): a point higher or lower than that height is
 * shifted by its height difference times the tangent of the view angle.
 *
 * Pixel coordinates in the projection: x to the right and y up from the
 * image's top-left corner, one unit per pixel (so the image covers 0, −height
 * to width, 0), which is how a GeoTIFF with a pixel size of 1 and a tie point
 * at 0, 0 is read (see {@link sensorGeo}).
 */
import Projection from 'ol/proj/Projection.js';
import { addCoordinateTransforms, addProjection, fromLonLat, get as getProjection, getTransform, toLonLat, type ProjectionLike } from 'ol/proj.js';
import { getDistance } from 'ol/sphere.js';
import type { GeoTIFFRaster } from 'browser-image-enhancement/openlayers';
import { rpcProjector, type Rpc } from './rpc.js';

/** Where the pixels of an image are on the ground. Pixel x, y run right and down from the top-left corner of the first pixel. */
export interface SensorModel {
  toLonLat(x: number, y: number): [number, number];
  toPixel(lon: number, lat: number): [number, number];
}

/** How a sensor projection places its image, for the layer's information. */
export interface SensorPlacement {
  /** 'rpc': by the RPC model at `height`; 'gcp': by a polynomial through the ground control points. */
  kind: 'rpc' | 'gcp';
  /** For 'rpc': the height above the WGS 84 ellipsoid the image is put at, in metres. */
  height?: number;
  /** For 'gcp': the points and the order of the polynomial. */
  points?: number;
  order?: number;
  /** For 'gcp': the root mean square misfit at the points, in pixels. */
  rms?: number;
  model: SensorModel;
}

const placements = new Map<string, SensorPlacement>();
let count = 0;

/** The image's sensor model at the RPC's height offset. */
export function rpcModel(rpc: Rpc, height = rpc.heightOff): SensorModel {
  const p = rpcProjector(rpc);
  return {
    // RPC sample and line 0 are the centre of the first pixel.
    toLonLat: (x, y) => p.toGround(x - 0.5, y - 0.5, height),
    toPixel: (lon, lat) => {
      const [s, l] = p.toImage(lon, lat, height);
      return [s + 0.5, l + 0.5];
    },
  };
}

/**
 * A polynomial model through ground control points (ModelTiepoint values: I,
 * J, K, X, Y, Z for each point, I and J at pixel corners as in GDAL), with
 * X, Y in `crs` (WGS 84 when not given). Third order for 20 points or more,
 * second for 10 or more, else affine; null for fewer than 3 points, points in
 * a line, or a CRS OpenLayers does not know.
 */
export function gcpModel(tiepoints: readonly number[], crs: ProjectionLike = 'EPSG:4326'): { model: SensorModel; order: number; points: number; rms: number } | null {
  const n = Math.floor(tiepoints.length / 6);
  if (n < 3) return null;
  const toWgs84 = getProjection(crs) ? getTransform(crs, 'EPSG:4326') : null;
  if (!toWgs84) return null;
  const pixels: number[][] = [];
  const lonLats: number[][] = [];
  for (let k = 0; k < n; k++) {
    pixels.push([tiepoints[k * 6], tiepoints[k * 6 + 1]]);
    lonLats.push(toWgs84([tiepoints[k * 6 + 3], tiepoints[k * 6 + 4]]));
  }
  const order = n >= 20 ? 3 : n >= 10 ? 2 : 1;
  const forward = fitPolynomial(pixels, lonLats, order);
  const inverse = fitPolynomial(lonLats, pixels, order);
  if (!forward || !inverse) return null;
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const [x, y] = inverse(lonLats[k][0], lonLats[k][1]);
    sum += (x - pixels[k][0]) ** 2 + (y - pixels[k][1]) ** 2;
  }
  return { model: { toLonLat: forward, toPixel: inverse }, order, points: n, rms: Math.sqrt(sum / n) };
}

/** The EPSG code the GeoKeys name (projected, else geographic), as 'EPSG:n'; null when they name none. */
export function geoKeysCrs(keys: readonly number[] | undefined): string | null {
  if (!keys || keys.length < 4) return null;
  let geographic: number | null = null;
  for (let i = 4; i + 3 < keys.length; i += 4) {
    const [id, location, , value] = keys.slice(i, i + 4);
    if (location !== 0) continue;
    if (id === 3072 && value > 0 && value < 32767) return `EPSG:${value}`;
    if (id === 2048 && value > 0 && value < 32767) geographic = value;
  }
  return geographic ? `EPSG:${geographic}` : null;
}

/**
 * A projection whose coordinates are the pixels of a `width` × `height`
 * image placed by `model`, with transforms to WGS 84 and Web Mercator. Far
 * outside the image (where a map tile's corners may fall), an affine fit to
 * the model takes over: a polynomial model goes wild there.
 */
export function sensorProjection(model: SensorModel, width: number, height: number, placement: Omit<SensorPlacement, 'model'>): Projection {
  const safe = withAffineOutside(model, width, height);
  const [cx, cy] = [width / 2, height / 2];
  const a = safe.toLonLat(cx, cy);
  const metersPerPixel = (getDistance(a, safe.toLonLat(cx + 1, cy)) + getDistance(a, safe.toLonLat(cx, cy + 1))) / 2 || 1;
  const code = `SENSOR:${++count}`;
  const projection = new Projection({ code, units: 'pixels', extent: [0, -height, width, 0], metersPerUnit: metersPerPixel });
  addProjection(projection);
  const toWgs84 = (c: number[]) => safe.toLonLat(c[0], -c[1]);
  const fromWgs84 = (c: number[]) => {
    const [x, y] = safe.toPixel(c[0], c[1]);
    return [x, -y];
  };
  addCoordinateTransforms(projection, 'EPSG:4326', toWgs84, fromWgs84);
  addCoordinateTransforms(projection, 'EPSG:3857', (c) => fromLonLat(toWgs84(c)), (c) => fromWgs84(toLonLat(c)));
  placements.set(code, { ...placement, model: safe });
  return projection;
}

/** How the image of a sensor projection is placed; null for any other projection. */
export function sensorPlacement(projection: ProjectionLike | null | undefined): SensorPlacement | null {
  const code = typeof projection === 'string' ? projection : projection?.getCode();
  return code ? (placements.get(code) ?? null) : null;
}

/** GeoKeys for WGS 84 longitude and latitude. */
export const WGS84_KEYS = [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326];

/** The georeferencing that makes a GeoTIFF's coordinates its pixels, for a {@link sensorProjection}. */
export function sensorGeo(): NonNullable<GeoTIFFRaster['geo']> {
  return { modelPixelScale: [1, 1, 0], modelTiepoint: [0, 0, 0, 0, 0, 0] };
}

/**
 * An affine ModelTransformation (WGS 84) that best places the pixels x0, y0
 * to x0 + w, y0 + h of a sensor image when written as a GeoTIFF of their own
 * (a clip saved from the view), `k` of them to a written pixel: rotation
 * kept, relief not.
 */
export function sensorWindowTransform(model: SensorModel, x0: number, y0: number, w: number, h: number, k: [number, number] = [1, 1]): number[] | null {
  const pixels: number[][] = [];
  const lonLats: number[][] = [];
  for (let j = 0; j <= 4; j++) {
    for (let i = 0; i <= 4; i++) {
      const x = x0 + (w * i) / 4;
      const y = y0 + (h * j) / 4;
      pixels.push([(x - x0) / k[0], (y - y0) / k[1]]);
      lonLats.push(model.toLonLat(x, y));
    }
  }
  const lon = leastSquares(pixels.map(([x, y]) => [1, x, y]), lonLats.map((c) => c[0]));
  const lat = leastSquares(pixels.map(([x, y]) => [1, x, y]), lonLats.map((c) => c[1]));
  if (!lon || !lat) return null;
  return [lon[1], lon[2], 0, lon[0], lat[1], lat[2], 0, lat[0], 0, 0, 0, 0, 0, 0, 0, 1];
}

/** `model`, with an affine fit to it used for points far outside the image. */
function withAffineOutside(model: SensorModel, width: number, height: number): SensorModel {
  const pixels: number[][] = [];
  const lonLats: number[][] = [];
  for (let j = 0; j <= 4; j++) {
    for (let i = 0; i <= 4; i++) {
      const p = [(width * i) / 4, (height * j) / 4];
      const g = model.toLonLat(p[0], p[1]);
      if (!g.every(Number.isFinite)) continue;
      pixels.push(p);
      lonLats.push(g);
    }
  }
  const toLonLat = fitPolynomial(pixels, lonLats, 1);
  const toPixel = fitPolynomial(lonLats, pixels, 1);
  if (!toLonLat || !toPixel) return model;
  // Within half the image's size around it, the model; beyond, the plane.
  const near = (x: number, y: number) => x > -width / 2 && x < width * 1.5 && y > -height / 2 && y < height * 1.5;
  return {
    toLonLat: (x, y) => {
      if (!near(x, y)) return toLonLat(x, y);
      const g = model.toLonLat(x, y);
      return g.every(Number.isFinite) ? g : toLonLat(x, y);
    },
    toPixel: (lon, lat) => {
      const guess = toPixel(lon, lat);
      if (!near(guess[0], guess[1])) return guess;
      const p = model.toPixel(lon, lat);
      return p.every(Number.isFinite) ? p : guess;
    },
  };
}

/** A polynomial map of the given order from `from` to `to` (2D points), fitted by least squares; null when the points do not determine it. */
function fitPolynomial(from: readonly number[][], to: readonly number[][], order: number): ((u: number, v: number) => [number, number]) | null {
  const n = from.length;
  if (!n) return null;
  // Centre and scale the input for a well-conditioned fit.
  let mu = 0;
  let mv = 0;
  for (const [u, v] of from) {
    mu += u / n;
    mv += v / n;
  }
  let su = 0;
  let sv = 0;
  for (const [u, v] of from) {
    su = Math.max(su, Math.abs(u - mu));
    sv = Math.max(sv, Math.abs(v - mv));
  }
  su ||= 1;
  sv ||= 1;
  const terms = (u: number, v: number): number[] => {
    const a = (u - mu) / su;
    const b = (v - mv) / sv;
    const t: number[] = [];
    for (let d = 0; d <= order; d++) for (let j = 0; j <= d; j++) t.push(a ** (d - j) * b ** j);
    return t;
  };
  const rows = from.map(([u, v]) => terms(u, v));
  if (rows.length < rows[0].length) return null;
  const cx = leastSquares(rows, to.map((p) => p[0]));
  const cy = leastSquares(rows, to.map((p) => p[1]));
  if (!cx || !cy) return null;
  return (u, v) => {
    const t = terms(u, v);
    let x = 0;
    let y = 0;
    for (let i = 0; i < t.length; i++) {
      x += cx[i] * t[i];
      y += cy[i] * t[i];
    }
    return [x, y];
  };
}

/** The least-squares solution of rows · c = values (normal equations, Gaussian elimination with pivoting); null when singular. */
function leastSquares(rows: readonly number[][], values: readonly number[]): number[] | null {
  const m = rows[0]?.length ?? 0;
  const a = Array.from({ length: m }, () => new Array<number>(m + 1).fill(0));
  rows.forEach((r, k) => {
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) a[i][j] += r[i] * r[j];
      a[i][m] += r[i] * values[k];
    }
  });
  const scale = Math.max(...a.map((r, i) => Math.abs(r[i])), 1e-300);
  for (let c = 0; c < m; c++) {
    let p = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (!(Math.abs(a[p][c]) > 1e-12 * scale)) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < m; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k <= m; k++) a[r][k] -= f * a[c][k];
    }
  }
  return a.map((r, i) => r[m] / r[i]);
}
