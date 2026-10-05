/**
 * Simple orthorectification without an RPC model: an image that is already
 * georeferenced, but onto a flat ground (one reference height), is corrected
 * for the terrain with the open DEMs and the direction the satellite looked
 * from (its azimuth and elevation angle).
 *
 * A point `h` metres above the reference height, seen at elevation angle `e`,
 * shows up `(h − h0) / tan(e)` metres from where it is, away from the
 * satellite. So each output pixel reads the image that far away from itself,
 * in the direction the satellite is not. Where no DEM covers the ground,
 * nothing is moved.
 *
 * The image's own CRS is turned into grids on the main thread (where the
 * viewer's projections are registered), so this runs in a worker with plain
 * arithmetic.
 */
import { identity, warpRaster, type Raster, type Resample } from 'browser-image-geometry';
import { elevationAt } from './dem.js';
import type { Dted } from './dted.js';
import { fromMercator, type OrthoResult } from './ortho.js';

/** Where the satellite was, seen from the ground, in degrees. */
export interface SensorView {
  /** Clockwise from north, 0 to 360. */
  azimuth: number;
  /** Above the horizon, 90 straight above (nadir). */
  elevation: number;
}

/** A function sampled on a regular grid, interpolated bilinearly between nodes. */
export interface GridMap {
  /** `[minX, minY, maxX, maxY]` the nodes span. */
  extent: readonly [number, number, number, number];
  cols: number;
  rows: number;
  /** `[x, y]` per node, rows from `minY` up. */
  values: Float64Array;
}

/** Samples `fn` on `cols` × `rows` nodes over `extent`. */
export function sampleGrid(extent: readonly [number, number, number, number], cols: number, rows: number, fn: (x: number, y: number) => readonly number[]): GridMap {
  const [minX, minY, maxX, maxY] = extent;
  const values = new Float64Array(cols * rows * 2);
  for (let j = 0; j < rows; j++) {
    const y = minY + ((maxY - minY) * j) / (rows - 1);
    for (let i = 0; i < cols; i++) {
      const p = fn(minX + ((maxX - minX) * i) / (cols - 1), y);
      values[(j * cols + i) * 2] = p[0];
      values[(j * cols + i) * 2 + 1] = p[1];
    }
  }
  return { extent, cols, rows, values };
}

/** The grid's value at `(x, y)`; outside it, extended from the edge cells. */
export function gridLookup({ extent, cols, rows, values }: GridMap, x: number, y: number): [number, number] {
  const fx = ((x - extent[0]) / (extent[2] - extent[0])) * (cols - 1);
  const fy = ((y - extent[1]) / (extent[3] - extent[1])) * (rows - 1);
  const i = Math.max(0, Math.min(cols - 2, Math.floor(fx)));
  const j = Math.max(0, Math.min(rows - 2, Math.floor(fy)));
  const tx = fx - i;
  const ty = fy - j;
  const a = (j * cols + i) * 2;
  const b = a + cols * 2;
  const at = (k: number) =>
    (values[a + k] * (1 - tx) + values[a + 2 + k] * tx) * (1 - ty) + (values[b + k] * (1 - tx) + values[b + 2 + k] * tx) * ty;
  return [at(0), at(1)];
}

export interface SimpleOrthoInput {
  /** The image (or a reduced copy of it). */
  raster: Raster;
  /** Raster position (pixel corners at integers) → EPSG:3857 on the reference plane. */
  toMap: GridMap;
  /** EPSG:3857 → raster position, over the output and the farthest the terrain moves it. */
  toRaster: GridMap;
  /** Output area in EPSG:3857. */
  extent: readonly [number, number, number, number];
  /** Output pixel size in EPSG:3857 units. */
  pixelSize: number;
  cells: Dted[];
  view: SensorView;
  /** The height (above mean sea level, like the DEMs) the image was placed at. */
  referenceHeight: number;
  resample?: Resample;
}

/** Ground metres, per metre above the reference height, east and north (away from the satellite). */
export function displacement({ azimuth, elevation }: SensorView): [east: number, north: number] {
  const az = (azimuth * Math.PI) / 180;
  const cot = 1 / Math.tan((Math.max(1, Math.min(90, elevation)) * Math.PI) / 180);
  return [-Math.sin(az) * cot, -Math.cos(az) * cot];
}

export function simpleOrthorectify(input: SimpleOrthoInput): OrthoResult {
  const { raster, toMap, toRaster, cells, referenceHeight } = input;
  const [ex, ny] = displacement(input.view);
  const stats = { hits: 0, misses: 0 };
  const result = warpRaster(raster, identity(), {
    resample: input.resample ?? 'bilinear',
    yUp: true,
    gridStep: 16,
    tolerance: 0.25,
    extent: input.extent,
    pixelSize: input.pixelSize,
    coordinateTransform: {
      forward: ([x, y]) => gridLookup(toMap, x, y),
      inverse: ([x, y]) => {
        const [lon, lat] = fromMercator(x, y);
        const h = elevationAt(cells, lon, lat);
        if (h === null) {
          stats.misses++;
          return gridLookup(toRaster, x, y);
        }
        stats.hits++;
        // Web Mercator units are 1 / cos(latitude) ground metres.
        const k = (h - referenceHeight) / Math.cos((lat * Math.PI) / 180);
        return gridLookup(toRaster, x + ex * k, y + ny * k);
      },
    },
  });
  const total = stats.hits + stats.misses;
  return { raster: result.raster, geoTransform: result.geoTransform, extent: result.extent, demCoverage: total ? stats.hits / total : 0 };
}

/**
 * The satellite's azimuth and elevation from metadata text: a DigitalGlobe /
 * Maxar .IMD (`meanSatAz`, `meanSatEl`), GDAL metadata (the same items in its
 * XML), or keys like `satellite_azimuth` and `view_angle` / `off_nadir`
 * (elevation is then taken as 90° − off-nadir, close enough for a correction
 * of this kind). Null when the azimuth or both angles are missing.
 */
export function sensorViewFromText(text: string): SensorView | null {
  const find = (keys: string): number | null => {
    const m = new RegExp(`(?:${keys})[^\\d\\n-]{0,40}?(-?\\d+(?:\\.\\d+)?)`, 'i').exec(text);
    return m ? Number(m[1]) : null;
  };
  const azimuth = find('meanSatAz|sat_?azimuth|satellite_?azimuth|SATAZIMUTH');
  let elevation = find('meanSatEl|sat_?elevation|satellite_?elevation|SATELEVATION');
  if (elevation === null) {
    const offNadir = find('meanOffNadirViewAngle|off_?nadir(?:_?angle)?|view_angle');
    if (offNadir !== null) elevation = 90 - Math.abs(offNadir);
  }
  if (azimuth === null || elevation === null || !(elevation > 0 && elevation <= 90)) return null;
  return { azimuth: azimuth >= 0 && azimuth < 360 ? azimuth : ((azimuth % 360) + 360) % 360, elevation };
}

/** A DigitalGlobe / Maxar image metadata file. */
export function isImdName(name: string): boolean {
  return /\.imd$/i.test(name);
}
