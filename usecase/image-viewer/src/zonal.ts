/**
 * Zonal statistics (ゾーン統計): the pixels of an image inside each polygon,
 * summed up per band (mean, min, max, standard deviation, count, sum,
 * median). A pixel belongs to a polygon when its centre is inside it (holes
 * and multipolygons count); a polygon smaller than a pixel takes the pixel
 * under its centre, so every polygon over the image gets a value.
 */
import { medianInPlace } from './select.js';

/** A statistic that can be asked for. */
export type ZonalStat = 'mean' | 'min' | 'max' | 'std' | 'count' | 'sum' | 'median';

/** The statistics in the order they are offered, with their Japanese names. */
export const ZONAL_STATS: ReadonlyArray<{ id: ZonalStat; label: string }> = [
  { id: 'mean', label: '平均' },
  { id: 'min', label: '最小' },
  { id: 'max', label: '最大' },
  { id: 'std', label: '標準偏差' },
  { id: 'count', label: '画素数' },
  { id: 'sum', label: '合計' },
  { id: 'median', label: '中央値' },
];

/** A polygon's rings (outer, then holes; several polygons' rings for a multipolygon), as [x, y] pairs in pixel units. */
export type Rings = ReadonlyArray<ReadonlyArray<readonly [number, number]>>;

/**
 * The cells of a `width` × `height` grid whose centres are inside `rings`
 * (even-odd over all rings). The grid's cell (i, j) covers pixels
 * `x0 + i / scale` … `x0 + (i + 1) / scale` (and the same for y), so a grid
 * read at a lower resolution (`scale` < 1) lines up with the polygon.
 */
export function rasterizePolygon(rings: Rings, x0: number, y0: number, width: number, height: number, scale = 1): Uint8Array {
  const mask = new Uint8Array(width * height);
  const crossings: number[] = [];
  for (let j = 0; j < height; j++) {
    const y = y0 + (j + 0.5) / scale;
    crossings.length = 0;
    for (const ring of rings) {
      const n = ring.length;
      for (let k = 0, m = n - 1; k < n; m = k++) {
        const [ax, ay] = ring[m];
        const [bx, by] = ring[k];
        // Half-open in y, so a vertex on the scanline is counted once.
        if (ay <= y !== by <= y) crossings.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
      }
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);
    for (let c = 0; c + 1 < crossings.length; c += 2) {
      // Cells whose centre x0 + (i + 0.5) / scale lies in [left, right).
      const from = Math.max(0, Math.ceil((crossings[c] - x0) * scale - 0.5));
      const to = Math.min(width, Math.ceil((crossings[c + 1] - x0) * scale - 0.5));
      for (let i = from; i < to; i++) mask[j * width + i] = 1;
    }
  }
  return mask;
}

/** The statistics of one band over a zone; NaN where there was no value (count 0). */
export type ZoneStat = Record<ZonalStat, number>;

/**
 * The statistics of each band over the cells set in `mask` (all cells
 * without one), leaving out no data (`isNoData`, and NaN).
 */
export function zoneStats(bands: ReadonlyArray<ArrayLike<number>>, mask: ArrayLike<number> | null, isNoData: (v: number) => boolean = () => false, median = false): ZoneStat[] {
  return bands.map((values) => {
    let n = 0;
    let sum = 0;
    let sum2 = 0;
    let min = Infinity;
    let max = -Infinity;
    const kept = median ? new Float64Array(values.length) : null;
    for (let i = 0; i < values.length; i++) {
      if (mask && !mask[i]) continue;
      const v = values[i];
      if (Number.isNaN(v) || isNoData(v)) continue;
      n++;
      sum += v;
      sum2 += v * v;
      if (v < min) min = v;
      if (v > max) max = v;
      if (kept) kept[n - 1] = v;
    }
    if (!n) return { mean: NaN, min: NaN, max: NaN, std: NaN, count: 0, sum: 0, median: NaN };
    const mean = sum / n;
    let mid = NaN;
    if (kept) mid = medianInPlace(kept.subarray(0, n));
    return { mean, min, max, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), count: n, sum, median: mid };
  });
}

/** The attribute name of a band's statistic: `B1_mean`, or `mean` for a one-band image. */
export function statField(band: number, stat: ZonalStat, bands: number): string {
  return bands > 1 ? `B${band + 1}_${stat}` : stat;
}

/** The pixel bounds (clipped to the image) of `rings`, or null when they miss it. */
export function pixelBounds(rings: Rings, width: number, height: number): [number, number, number, number] | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  const c0 = Math.max(0, Math.floor(x0));
  const r0 = Math.max(0, Math.floor(y0));
  const c1 = Math.min(width, Math.max(c0 + 1, Math.ceil(x1)));
  const r1 = Math.min(height, Math.max(r0 + 1, Math.ceil(y1)));
  return c1 > c0 && r1 > r0 && x1 >= 0 && y1 >= 0 && x0 <= width && y0 <= height ? [c0, r0, c1, r1] : null;
}
