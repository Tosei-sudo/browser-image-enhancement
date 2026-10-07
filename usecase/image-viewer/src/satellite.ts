/**
 * What the viewer needs from a satellite image for orthorectification: its
 * RPC model (from the GeoTIFF tag or a side file) and whether it is
 * georeferenced at all. An image with RPC but no georeferencing (a level-1
 * product) is placed where its RPC model puts it, at the model's height
 * offset, until it is orthorectified.
 *
 * Ground control points (several ModelTiepoints and no pixel size, as in
 * ICEYE and other SAR GRD products) are not an affine georeferencing: map
 * libraries read them as one pixel per map unit at 0, 0. Such an image is
 * placed by its RPC model when it has one, else by a plane fitted to its
 * points.
 */
import { fromArrayBuffer, fromBlob, fromUrl, type GeoTIFF } from 'geotiff';
import type { GeoTIFFRaster } from 'browser-image-enhancement/openlayers';
import { rpcFromTag, rpcProjector, type Rpc } from './rpc.js';
import { sensorViewFromText, type SensorView } from './simple-ortho.js';

/** The RPC model and georeferencing state of a TIFF. */
export interface TiffInfo {
  rpc: Rpc | null;
  /** Whether the image has an affine georeferencing (a pixel size and a tie point, or a transformation matrix). */
  georeferenced: boolean;
  /** For an image placed only by ground control points: the box they cover, north up, in their own coordinate system. */
  gcpGeo: GeoTIFFRaster['geo'] | null;
  /** Where the satellite looked from, when the GDAL metadata says. */
  view: SensorView | null;
  width: number;
  height: number;
}

/** Opens a TIFF from a file or URL, reading only the parts asked for. */
export async function openTiff(from: Blob | string): Promise<GeoTIFF> {
  if (typeof from === 'string') return fromUrl(from);
  return typeof FileReader === 'undefined' ? fromArrayBuffer(await from.arrayBuffer()) : fromBlob(from);
}

/** The RPC model in the TIFF's RPCCoefficientTag (50844), whether it has georeferencing tags, and the sensor angles in its GDAL metadata. */
export async function tiffInfo(from: Blob | string): Promise<TiffInfo> {
  const tiff = await openTiff(from);
  const image = await tiff.getImage();
  const fd = image.fileDirectory;
  let rpc: Rpc | null = null;
  if (fd.hasTag(50844)) {
    try {
      rpc = rpcFromTag((await fd.loadValue(50844)) as ArrayLike<number>);
    } catch {
      rpc = null;
    }
  }
  let view: SensorView | null = null;
  if (fd.hasTag(42112)) {
    const text = await fd.loadValue(42112).catch(() => null);
    view = typeof text === 'string' ? sensorViewFromText(text) : null;
  }
  const width = image.getWidth();
  const height = image.getHeight();
  const tiepoints = fd.hasTag(33922) ? Array.from((await fd.loadValue(33922)) as ArrayLike<number>, Number) : [];
  const georeferenced = fd.hasTag(34264) || (fd.hasTag(33550) && tiepoints.length >= 6);
  let gcpGeo: GeoTIFFRaster['geo'] | null = null;
  if (!georeferenced && tiepoints.length >= 18) {
    const keys = fd.hasTag(34735) ? Array.from((await fd.loadValue(34735)) as ArrayLike<number>, Number) : undefined;
    const doubles = fd.hasTag(34736) ? Array.from((await fd.loadValue(34736)) as ArrayLike<number>, Number) : undefined;
    const ascii = fd.hasTag(34737) ? String(await fd.loadValue(34737)) : undefined;
    gcpGeo = gcpBox(tiepoints, width, height, { geoKeyDirectory: keys, geoDoubleParams: doubles, geoAsciiParams: ascii });
  }
  return { rpc, georeferenced, gcpGeo, view, width, height };
}

/**
 * The north-up box of a `width` × `height` image placed by the ground control
 * points in ModelTiepoint values (I, J, K, X, Y, Z for each point): the
 * corners from the plane X, Y = a + b·I + c·J fitted to them by least
 * squares. Null when the points are fewer than three or all in a line.
 */
export function gcpBox(tiepoints: readonly number[], width: number, height: number, crs: Omit<NonNullable<GeoTIFFRaster['geo']>, 'modelPixelScale' | 'modelTiepoint' | 'modelTransformation'> = {}): GeoTIFFRaster['geo'] | null {
  const n = Math.floor(tiepoints.length / 6);
  if (n < 3) return null;
  // Normal equations of the fit, with I and J centred for accuracy.
  let mi = 0;
  let mj = 0;
  let mx = 0;
  let my = 0;
  for (let k = 0; k < n; k++) {
    mi += tiepoints[k * 6] / n;
    mj += tiepoints[k * 6 + 1] / n;
    mx += tiepoints[k * 6 + 3] / n;
    my += tiepoints[k * 6 + 4] / n;
  }
  let [sii, sij, sjj, six, sjx, siy, sjy] = [0, 0, 0, 0, 0, 0, 0];
  for (let k = 0; k < n; k++) {
    const i = tiepoints[k * 6] - mi;
    const j = tiepoints[k * 6 + 1] - mj;
    const x = tiepoints[k * 6 + 3] - mx;
    const y = tiepoints[k * 6 + 4] - my;
    sii += i * i;
    sij += i * j;
    sjj += j * j;
    six += i * x;
    sjx += j * x;
    siy += i * y;
    sjy += j * y;
  }
  const det = sii * sjj - sij * sij;
  if (!(Math.abs(det) > 1e-12 * Math.max(1, sii * sjj))) return null;
  const bx = (six * sjj - sjx * sij) / det;
  const cx = (sjx * sii - six * sij) / det;
  const by = (siy * sjj - sjy * sij) / det;
  const cy = (sjy * sii - siy * sij) / det;
  const corners = [[0, 0], [width, 0], [0, height], [width, height]].map(([i, j]) => [mx + bx * (i - mi) + cx * (j - mj), my + by * (i - mi) + cy * (j - mj)]);
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const west = Math.min(...xs);
  const north = Math.max(...ys);
  if (![west, north, ...xs, ...ys].every(Number.isFinite)) return null;
  return {
    ...crs,
    modelPixelScale: [(Math.max(...xs) - west) / width, (north - Math.min(...ys)) / height, 0],
    modelTiepoint: [0, 0, 0, west, north, 0],
  };
}

/**
 * Approximate georeferencing from an RPC model: the box of the image corners
 * on the ground at the model's height offset, north up, in WGS 84.
 */
export function rpcGeo(rpc: Rpc, width: number, height: number): GeoTIFFRaster['geo'] {
  const p = rpcProjector(rpc);
  const corners = [
    [-0.5, -0.5],
    [width - 0.5, -0.5],
    [-0.5, height - 0.5],
    [width - 0.5, height - 0.5],
  ].map(([s, l]) => p.toGround(s, l, rpc.heightOff));
  const lons = corners.map((c) => c[0]);
  const lats = corners.map((c) => c[1]);
  const west = Math.min(...lons);
  const north = Math.max(...lats);
  return {
    modelPixelScale: [(Math.max(...lons) - west) / width, (north - Math.min(...lats)) / height, 0],
    modelTiepoint: [0, 0, 0, west, north, 0],
    geoKeyDirectory: [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326],
  };
}
