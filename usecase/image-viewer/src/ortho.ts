/**
 * Orthorectification: a satellite image with an RPC model, projected onto the
 * terrain of the open DEMs, as a north-up raster in Web Mercator (EPSG:3857,
 * the map's projection). Each output pixel is traced back to the image: its
 * longitude and latitude, the terrain height there (DEM height above mean
 * sea level + EGM96 geoid = ellipsoidal height), then the RPC model gives the
 * image position. Where no DEM covers the ground, the RPC model's height
 * offset is used instead.
 *
 * The resampling is browser-image-geometry's `warpRaster`, which keeps the
 * sample type and band count (16-bit multispectral images stay 16-bit).
 */
import { identity, warpRaster, type Raster, type Resample } from 'browser-image-geometry';
import { elevationAt, geoidHeight, type GeoidGrid } from './dem.js';
import type { Dted } from './dted.js';
import { rpcProjector, type Rpc } from './rpc.js';

export interface OrthoInput {
  /** The image (or a reduced copy of it, see `scale`). */
  raster: Raster;
  /** Full-resolution image pixels per raster pixel, across and down (1 for the image itself). */
  scale: number | readonly [number, number];
  rpc: Rpc;
  /** Elevation cells; may be empty. */
  cells: Dted[];
  geoid: GeoidGrid;
  resample?: Resample;
  /** Output pixel size in metres on the ground. Default: about the raster's own resolution. */
  groundPixelSize?: number;
}

export interface OrthoResult {
  raster: Raster;
  /** `[x0, pixelWidth, 0, y0, 0, -pixelHeight]` in EPSG:3857. */
  geoTransform: readonly [number, number, number, number, number, number];
  /** `[minX, minY, maxX, maxY]` in EPSG:3857. */
  extent: readonly [number, number, number, number];
  /** Share of the traced positions that had a DEM height (0 to 1). */
  demCoverage: number;
}

const R = 6378137;

export function toMercator(lon: number, lat: number): [number, number] {
  const y = Math.log(Math.tan(Math.PI / 4 + (Math.max(-85.06, Math.min(85.06, lat)) * Math.PI) / 360)) * R;
  return [(lon * Math.PI * R) / 180, y];
}

export function fromMercator(x: number, y: number): [number, number] {
  return [(x / R) * (180 / Math.PI), (Math.atan(Math.exp(y / R)) * 360) / Math.PI - 90];
}

/** Ellipsoidal terrain height, counting how often a DEM answered. */
export function terrain(cells: readonly Dted[], geoid: GeoidGrid, fallback: number) {
  const stats = { hits: 0, misses: 0 };
  const height = (lon: number, lat: number): number => {
    const h = elevationAt(cells, lon, lat);
    if (h === null) {
      stats.misses++;
      return fallback;
    }
    stats.hits++;
    return h + geoidHeight(geoid, lon, lat);
  };
  return { height, stats };
}

/**
 * Where image position `(sample, line)` lies on the terrain: the ground point
 * seen there at a height, then the terrain height at that point, a few times over.
 */
export function imageToTerrain(
  rpc: Rpc,
  height: (lon: number, lat: number) => number,
  sample: number,
  line: number,
): [lon: number, lat: number, height: number] {
  const project = rpcProjector(rpc);
  let h = rpc.heightOff;
  let lon = rpc.lonOff;
  let lat = rpc.latOff;
  for (let i = 0; i < 6; i++) {
    [lon, lat] = project.toGround(sample, line, h);
    const next = height(lon, lat);
    if (Math.abs(next - h) < 0.01) break;
    h = next;
  }
  return [lon, lat, h];
}

export function orthorectify(input: OrthoInput): OrthoResult {
  const { raster, scale, rpc } = input;
  const project = rpcProjector(rpc);
  const { height, stats } = terrain(input.cells, input.geoid, rpc.heightOff);
  // Raster position (pixel corners at integers) ↔ RPC sample / line (first pixel's center at 0).
  const [kx, ky] = typeof scale === 'number' ? [scale, scale] : scale;
  const toRaster = (sample: number, line: number): number[] => [(sample + 0.5) / kx, (line + 0.5) / ky];
  const fromRaster = (x: number, y: number): [number, number] => [x * kx - 0.5, y * ky - 0.5];

  const result = warpRaster(raster, identity(), {
    resample: input.resample ?? 'bilinear',
    yUp: true,
    gridStep: 16,
    tolerance: 0.25,
    coordinateTransform: {
      forward: ([x, y]) => {
        const [lon, lat] = imageToTerrain(rpc, height, ...fromRaster(x, y));
        return toMercator(lon, lat);
      },
      inverse: ([x, y]) => {
        const [lon, lat] = fromMercator(x, y);
        const [sample, line] = project.toImage(lon, lat, height(lon, lat));
        return toRaster(sample, line);
      },
    },
    ...(input.groundPixelSize ? { pixelSize: mercatorPixelSize(input.groundPixelSize, rpc.latOff) } : {}),
  });
  const total = stats.hits + stats.misses;
  return { raster: result.raster, geoTransform: result.geoTransform, extent: result.extent, demCoverage: total ? stats.hits / total : 0 };
}

/** Web Mercator units for `metres` on the ground at latitude `lat`. */
export function mercatorPixelSize(metres: number, lat: number): number {
  return metres / Math.cos((lat * Math.PI) / 180);
}
