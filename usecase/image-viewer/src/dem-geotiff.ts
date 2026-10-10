/**
 * GeoTIFF DEMs: a one-band GeoTIFF of heights (metres above mean sea level, as
 * most DEMs are) in any coordinate system, resampled onto a longitude /
 * latitude grid so it serves as elevation data the way a DTED cell does: the
 * terrain of orthorectification, contours, the 3D relief and the viewshed.
 */
import { DTED_VOID, type Dted } from './dted.js';

/** The heights of a DEM as read: one band, rows north to south. */
export interface DemRaster {
  width: number;
  height: number;
  data: ArrayLike<number>;
  /** The value of pixels with no data (NaN always counts as none). */
  noData: number | null;
  /** `[minX, minY, maxX, maxY]` of the pixels' outer edges, in the raster's coordinate system (north up). */
  extent: readonly number[];
}

/** Posts in a resampled DEM at most (16 M: 64 MB of heights). */
export const MAX_DEM_POSTS = 16_000_000;

/** Posts between the points that are transformed exactly; the ones between are interpolated. */
const STEP = 16;

/**
 * `raster` resampled (bilinear, voids left out) onto a longitude / latitude
 * grid covering `lonLat` (`[west, south, east, north]`, degrees) with about as
 * many posts as it has pixels (at most `maxPosts`). `toRaster` takes a
 * longitude and latitude to the raster's coordinate system. Posts outside the
 * raster or over no data are {@link DTED_VOID}.
 */
export function resampleDem(raster: DemRaster, toRaster: (lonLat: number[]) => number[], lonLat: readonly number[], maxPosts = MAX_DEM_POSTS): Dted {
  const [west, south, east, north] = lonLat;
  const k = Math.max(1, Math.sqrt((raster.width * raster.height) / maxPosts));
  const width = Math.max(2, Math.round(raster.width / k));
  const height = Math.max(2, Math.round(raster.height / k));
  const dLon = (east - west) / width;
  const dLat = (north - south) / height;
  // Posts at the middle of each cell of the grid, the first column at west + dLon / 2.
  const lon0 = west + dLon / 2;
  const lat0 = north - dLat / 2;

  // The raster's coordinates of every STEP-th post, exactly.
  const gw = Math.ceil((width - 1) / STEP) + 1;
  const gh = Math.ceil((height - 1) / STEP) + 1;
  const gx = new Float64Array(gw * gh);
  const gy = new Float64Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const [x, y] = toRaster([lon0 + Math.min(i * STEP, width - 1) * dLon, lat0 - Math.min(j * STEP, height - 1) * dLat]);
      gx[j * gw + i] = x;
      gy[j * gw + i] = y;
    }
  }

  const [minX, minY, maxX, maxY] = raster.extent;
  const px = (maxX - minX) / raster.width;
  const py = (maxY - minY) / raster.height;
  const { data, noData } = raster;
  const W = raster.width;
  const H = raster.height;
  const out = new Float32Array(width * height);
  for (let r = 0; r < height; r++) {
    const j = Math.min(Math.floor(r / STEP), gh - 2);
    const ty = gh > 1 ? (r - j * STEP) / (Math.min((j + 1) * STEP, height - 1) - j * STEP) : 0;
    for (let c = 0; c < width; c++) {
      const i = Math.min(Math.floor(c / STEP), gw - 2);
      const tx = gw > 1 ? (c - i * STEP) / (Math.min((i + 1) * STEP, width - 1) - i * STEP) : 0;
      const a = j * gw + i;
      const lerp = (g: Float64Array) => (g[a] * (1 - tx) + g[a + 1] * tx) * (1 - ty) + (g[a + gw] * (1 - tx) + g[a + gw + 1] * tx) * ty;
      // Pixel centres are at half pixels.
      const fx = (lerp(gx) - minX) / px - 0.5;
      const fy = (maxY - lerp(gy)) / py - 0.5;
      out[r * width + c] = sample(data, W, H, fx, fy, noData);
    }
  }

  return {
    level: 'GeoTIFF',
    west: lon0,
    south: lat0 - (height - 1) * dLat,
    spacing: [dLon, dLat],
    width,
    height,
    data: out,
    verticalAccuracy: null,
  };
}

/** The raster at pixel `fx`, `fy` (bilinear, voids left out), or DTED_VOID outside it or where it has no data. */
function sample(data: ArrayLike<number>, W: number, H: number, fx: number, fy: number, noData: number | null): number {
  if (!(fx >= -0.5 && fy >= -0.5 && fx <= W - 0.5 && fy <= H - 0.5)) return DTED_VOID;
  const x = Math.min(Math.max(fx, 0), W - 1);
  const y = Math.min(Math.max(fy, 0), H - 1);
  const i = Math.min(Math.floor(x), Math.max(0, W - 2));
  const j = Math.min(Math.floor(y), Math.max(0, H - 2));
  const tx = W > 1 ? x - i : 0;
  const ty = H > 1 ? y - j : 0;
  let sum = 0;
  let weight = 0;
  const add = (xi: number, yi: number, w: number) => {
    if (w === 0 || xi >= W || yi >= H) return;
    const v = data[yi * W + xi];
    if (Number.isNaN(v) || v === noData || v === DTED_VOID) return;
    sum += v * w;
    weight += w;
  };
  add(i, j, (1 - tx) * (1 - ty));
  add(i + 1, j, tx * (1 - ty));
  add(i, j + 1, (1 - tx) * ty);
  add(i + 1, j + 1, tx * ty);
  return weight > 0 ? sum / weight : DTED_VOID;
}
