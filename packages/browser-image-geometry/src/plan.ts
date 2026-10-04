/**
 * Main-thread planning: the output grid (size and position), the mapping each
 * output pixel uses, how far to shrink the source first, and which part of the
 * source each strip of the output reads.
 */
import { invertTransform, pointFunction, assertTransform } from './transform.js';
import { halve, KERNEL_MARGIN, rowMapper, type Mapping } from './resample.js';
import type { AffineMatrix, CoordinateTransform, RGBA, Resample, Transform } from './types.js';

/** How the output image is laid out and sampled. Used by {@link warp} and {@link warpImageData}. */
export interface OutputOptions {
  /** Interpolation. Default `bilinear`. */
  resample?: Resample;
  /** Color of pixels that fall outside the source. Default transparent `[0, 0, 0, 0]`. */
  background?: RGBA;
  /**
   * Output area `[minX, minY, maxX, maxY]` in output coordinates (the transform's
   * target, or `coordinateTransform`'s output). Default: the whole transformed source.
   */
  extent?: readonly [number, number, number, number];
  /** Output pixel size in output coordinates, one number or `[x, y]`. Default: about the source resolution. */
  pixelSize?: number | readonly [number, number];
  /** Output width in pixels. With `height`, overrides `pixelSize`; alone, keeps pixels square. */
  width?: number;
  /** Output height in pixels. */
  height?: number;
  /**
   * Converts the transform's target coordinates to the output's (e.g.
   * `proj4('EPSG:4326', 'EPSG:3857')`). Runs on the main thread on a coarse grid.
   */
  coordinateTransform?: CoordinateTransform;
  /** Grid spacing in output pixels for `coordinateTransform`. Default 32. */
  gridStep?: number;
  /** Largest allowed grid interpolation error, in source pixels. Default 0.125. */
  tolerance?: number;
  /** Overrides the transform's `yUp`: true puts the largest y at the top of the output. */
  yUp?: boolean;
  /**
   * What sampling reads beyond the source's outer pixel centers. `transparent`
   * (default) fades the edge out, which keeps the outline of a warped image
   * smooth; `clamp` repeats the edge pixels, for outputs that lie wholly on
   * the source (a resize), so opaque images stay opaque up to their border.
   */
  edges?: 'transparent' | 'clamp';
}

/** The most pixels an output may have (16384 × 16384, the usual canvas limit). */
export const MAX_OUTPUT_PIXELS = 2 ** 28;

/** Where a warped image sits in output coordinates. */
export interface WarpInfo {
  /** Output pixel → output coordinates, GDAL order: `[x0, pixelWidth, rowRotation, y0, columnRotation, pixelHeight]`. */
  readonly geoTransform: readonly [number, number, number, number, number, number];
  /** Area covered by the output image, `[minX, minY, maxX, maxY]` (for OpenLayers' `ImageStatic`). */
  readonly extent: readonly [number, number, number, number];
}

export interface Plan extends WarpInfo {
  width: number;
  height: number;
  mapping: Mapping;
  resample: Resample;
  background: RGBA;
  /** Times to halve the source before sampling. */
  levels: number;
  /** Repeat the edge pixels instead of fading out beyond them. */
  clampEdges: boolean;
}

type XY = [number, number];

const EDGE_SAMPLES = 64;
/** Pixels are counted as whole when within this of an integer, so exact sizes are not rounded up by float error. */
const SNAP = 1e-6;

function checkPositive(value: number | undefined, what: string): void {
  if (value !== undefined && !(Number.isFinite(value) && value > 0)) throw new RangeError(`${what} must be a positive number.`);
}

/** Source → output coordinates, through the coordinate transform when there is one. */
function forwardFunction(transform: Transform, ct?: CoordinateTransform): (x: number, y: number) => XY {
  const f = pointFunction(transform);
  const p: XY = [0, 0];
  return (x, y) => {
    f(x, y, p);
    if (!ct) return [p[0], p[1]];
    const q = ct.forward([p[0], p[1]]);
    return [q[0], q[1]];
  };
}

/** Bounding box of the transformed source outline. */
function autoExtent(width: number, height: number, fwd: (x: number, y: number) => XY): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    const [X, Y] = fwd(x, y);
    if (!Number.isFinite(X) || !Number.isFinite(Y)) {
      throw new RangeError('The transform sends part of the image to infinity (a projective horizon inside the image?). Pass `extent`.');
    }
    minX = Math.min(minX, X);
    minY = Math.min(minY, Y);
    maxX = Math.max(maxX, X);
    maxY = Math.max(maxY, Y);
  };
  for (let i = 0; i <= EDGE_SAMPLES; i++) {
    const t = i / EDGE_SAMPLES;
    add(t * width, 0);
    add(t * width, height);
    add(0, t * height);
    add(width, t * height);
  }
  return [minX, minY, maxX, maxY];
}

/**
 * A homography divides by `w = h6·x + h7·y + h8`, which is linear, so its sign
 * over the image is decided by the four corners. A sign change (or w near 0)
 * means the horizon crosses the image: part of it goes to infinity and no
 * automatic extent makes sense.
 */
function checkHorizon(width: number, height: number, m: readonly number[]): void {
  const w = [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ].map(([x, y]) => m[6] * x + m[7] * y + m[8]);
  const scale = Math.max(...w.map(Math.abs));
  if (!(scale > 0) || !(w.every((v) => v > 1e-9 * scale) || w.every((v) => v < -1e-9 * scale))) {
    throw new RangeError('The transform sends part of the image to infinity (a projective horizon inside the image?). Pass `extent`.');
  }
}

/** Output area per source pixel near the image center, as a square pixel size. */
function autoPixelSize(width: number, height: number, fwd: (x: number, y: number) => XY): number {
  const cx = width / 2;
  const cy = height / 2;
  const h = Math.max(1, Math.min(width, height) / 8);
  const p = fwd(cx, cy);
  const px = fwd(cx + h, cy);
  const py = fwd(cx, cy + h);
  const det = Math.abs((px[0] - p[0]) * (py[1] - p[1]) - (px[1] - p[1]) * (py[0] - p[0])) / (h * h);
  if (!(det > 0) || !Number.isFinite(det)) throw new RangeError('Could not work out an output pixel size; pass `pixelSize`.');
  return Math.sqrt(det);
}

function pixelsAcross(span: number, size: number): number {
  return Math.max(1, Math.ceil(span / size - SNAP));
}

/** The output grid: size and output pixel → output coordinate affine. */
function outputGrid(
  srcWidth: number,
  srcHeight: number,
  transform: Transform,
  options: OutputOptions,
): { width: number; height: number; matrix: AffineMatrix; yUp: boolean } {
  const fwd = forwardFunction(transform, options.coordinateTransform);
  if (!options.extent && transform.type === 'projective') checkHorizon(srcWidth, srcHeight, transform.matrix);
  const extent = options.extent ?? autoExtent(srcWidth, srcHeight, fwd);
  const [minX, minY, maxX, maxY] = extent;
  if (![minX, minY, maxX, maxY].every(Number.isFinite) || !(maxX > minX) || !(maxY > minY)) {
    throw new RangeError('`extent` must be [minX, minY, maxX, maxY] with max > min.');
  }
  checkPositive(options.width, '`width`');
  checkPositive(options.height, '`height`');
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  let sizeX: number;
  let sizeY: number;
  if (options.width !== undefined || options.height !== undefined) {
    sizeX = options.width !== undefined ? spanX / Math.round(options.width) : spanY / Math.round(options.height!);
    sizeY = options.height !== undefined ? spanY / Math.round(options.height) : sizeX;
  } else if (options.pixelSize !== undefined) {
    const ps = options.pixelSize;
    [sizeX, sizeY] = typeof ps === 'number' ? [ps, ps] : [ps[0], ps[1]];
    checkPositive(sizeX, '`pixelSize`');
    checkPositive(sizeY, '`pixelSize`');
  } else {
    sizeX = sizeY = autoPixelSize(srcWidth, srcHeight, fwd);
  }
  const width = options.width !== undefined ? Math.round(options.width) : pixelsAcross(spanX, sizeX);
  const height = options.height !== undefined ? Math.round(options.height) : pixelsAcross(spanY, sizeY);
  if (width < 1 || height < 1) throw new RangeError('`width` and `height` must round to at least 1 pixel.');
  if (width * height > MAX_OUTPUT_PIXELS) {
    throw new RangeError(
      `The output would be ${width} × ${height} pixels, more than ${MAX_OUTPUT_PIXELS} in all. Pass a larger \`pixelSize\`, a smaller \`extent\`, or \`width\` / \`height\` (or check the control points).`,
    );
  }
  const yUp = options.yUp ?? !!transform.yUp;
  const matrix: AffineMatrix = yUp ? [sizeX, 0, minX, 0, -sizeY, maxY] : [sizeX, 0, minX, 0, sizeY, minY];
  return { width, height, matrix, yUp };
}

/**
 * Source pixels per output pixel near the output center, in the direction
 * shrunk least: halving goes by this, so an axis that is not shrunk keeps its
 * detail (halving both axes for a one-sided shrink would blur the other).
 */
function sourceScale(mapping: Mapping, width: number, height: number): number {
  const map = rowMapper(mapping);
  const y = Math.floor(height / 2);
  const x = Math.floor(width / 2);
  const span = Math.max(1, Math.floor(Math.min(width, height) / 8));
  const row = new Float64Array(width * 2);
  const below = new Float64Array(width * 2);
  map(y, width, row);
  map(Math.min(height - 1, y + span), width, below);
  const dy = Math.min(height - 1, y + span) - y;
  const x1 = Math.min(width - 1, x + span);
  const dx = x1 - x;
  if (dx === 0 || dy === 0) return 1;
  const ax = (row[x1 * 2] - row[x * 2]) / dx;
  const ay = (row[x1 * 2 + 1] - row[x * 2 + 1]) / dx;
  const bx = (below[x * 2] - row[x * 2]) / dy;
  const by = (below[x * 2 + 1] - row[x * 2 + 1]) / dy;
  const scale = Math.min(Math.hypot(ax, ay), Math.hypot(bx, by));
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function buildGrid(
  width: number,
  height: number,
  matrix: AffineMatrix,
  inverse: Transform,
  ct: CoordinateTransform,
  firstStep: number,
  tolerance: number,
): Mapping {
  const toSource = pointFunction(inverse);
  const [a, b, c, d, e, f] = matrix;
  const p: XY = [0, 0];
  const exact = (u: number, v: number): XY => {
    const q = ct.inverse([a * u + b * v + c, d * u + e * v + f]);
    toSource(q[0], q[1], p);
    return [p[0], p[1]];
  };
  for (let step = Math.max(1, Math.floor(firstStep)); ; step = Math.max(1, Math.floor(step / 2))) {
    const columns = Math.ceil(width / step) + 1;
    const rows = Math.ceil(height / step) + 1;
    const points = new Float64Array(columns * rows * 2);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < columns; i++) {
        const [x, y] = exact(i * step, j * step);
        points[(j * columns + i) * 2] = x;
        points[(j * columns + i) * 2 + 1] = y;
      }
    }
    const grid: Mapping = { kind: 'grid', step, columns, rows, points, divisor: 1 };
    if (step === 1 || gridError(grid, exact) <= tolerance) return grid;
  }
}

/** Largest difference, in source pixels, between the grid and the exact mapping at cell centers. */
function gridError(grid: Extract<Mapping, { kind: 'grid' }>, exact: (u: number, v: number) => XY): number {
  const { step, columns, rows, points } = grid;
  let worst = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < columns - 1; i++) {
      const q = (k: number, c: number) => points[k * 2 + c];
      const k00 = j * columns + i;
      const ix = (q(k00, 0) + q(k00 + 1, 0) + q(k00 + columns, 0) + q(k00 + columns + 1, 0)) / 4;
      const iy = (q(k00, 1) + q(k00 + 1, 1) + q(k00 + columns, 1) + q(k00 + columns + 1, 1)) / 4;
      const [x, y] = exact((i + 0.5) * step, (j + 0.5) * step);
      const err = Math.hypot(ix - x, iy - y);
      if (Number.isFinite(err)) worst = Math.max(worst, err);
      else if (Number.isFinite(x) !== Number.isFinite(ix)) worst = Infinity;
    }
  }
  return worst;
}

/** Works out everything a warp needs before any pixel is touched. */
export function planWarp(srcWidth: number, srcHeight: number, transform: Transform, options: OutputOptions = {}): Plan {
  assertTransform(transform);
  const resample = options.resample ?? 'bilinear';
  if (!(resample in KERNEL_MARGIN)) throw new TypeError(`Unknown resample: ${String(resample)}`);
  const background = options.background ?? [0, 0, 0, 0];
  if (!Array.isArray(background) || background.length !== 4 || !background.every((v) => Number.isFinite(v) && v >= 0 && v <= 255)) {
    throw new TypeError('`background` must be [r, g, b, a] with values 0-255.');
  }
  checkPositive(options.gridStep, '`gridStep`');
  checkPositive(options.tolerance, '`tolerance`');
  const edges = options.edges ?? 'transparent';
  if (edges !== 'transparent' && edges !== 'clamp') throw new TypeError(`Unknown edges: ${String(edges)}`);

  const { width, height, matrix, yUp } = outputGrid(srcWidth, srcHeight, transform, options);
  const inverse = invertTransform(transform);
  let mapping: Mapping = options.coordinateTransform
    ? buildGrid(width, height, matrix, inverse, options.coordinateTransform, options.gridStep ?? 32, options.tolerance ?? 0.125)
    : { kind: 'transform', inverse, output: matrix, divisor: 1 };

  // Shrinking by more than 2×: sample a halved source instead, so detail does not alias.
  let levels = 0;
  if (resample !== 'nearest') {
    const scale = sourceScale(mapping, width, height);
    while (scale / 2 ** levels > 2 && Math.min(srcWidth, srcHeight) / 2 ** (levels + 1) >= 1) levels++;
  }
  if (levels > 0) mapping = { ...mapping, divisor: 2 ** levels };

  const [sx, , x0, , sy, y0] = matrix;
  const geoTransform = [x0, sx, 0, y0, 0, sy] as const;
  const extent: [number, number, number, number] = yUp
    ? [x0, y0 + sy * height, x0 + sx * width, y0]
    : [x0, y0, x0 + sx * width, y0 + sy * height];
  return { width, height, mapping, resample, background, levels, geoTransform, extent, clampEdges: edges === 'clamp' };
}

/** Halves the source `levels` times. */
export function shrink<T extends { data: Uint8ClampedArray; width: number; height: number }>(
  image: T,
  levels: number,
): { data: Uint8ClampedArray; width: number; height: number } {
  let out: { data: Uint8ClampedArray; width: number; height: number } = image;
  for (let i = 0; i < levels; i++) out = halve(out);
  return out;
}

/**
 * The part of the source that output rows `[y0, y1)` can read, as
 * `[left, top, right, bottom)` clipped to the source, or null if none.
 */
export function sourceBounds(
  mapping: Mapping,
  width: number,
  y0: number,
  y1: number,
  srcWidth: number,
  srcHeight: number,
  resample: Resample,
): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  if (mapping.kind === 'grid') {
    // Bilinear interpolation never leaves the box of the grid points around it.
    const { step, columns, points, divisor } = mapping;
    const j0 = Math.max(0, Math.floor((y0 + 0.5) / step));
    const j1 = Math.min(mapping.rows - 1, Math.ceil((y1 - 0.5) / step) + 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = 0; i < columns; i++) add(points[(j * columns + i) * 2] / divisor, points[(j * columns + i) * 2 + 1] / divisor);
    }
  } else {
    // Affine maps are exact at the strip corners; other transforms are sampled densely.
    const map = rowMapper(mapping);
    const row = new Float64Array(width * 2);
    const affine = mapping.inverse.type === 'affine';
    const every = affine ? Math.max(1, width - 1) : 1;
    const rowStep = affine ? Math.max(1, y1 - 1 - y0) : 4;
    for (let y = y0; ; y = Math.min(y + rowStep, y1 - 1)) {
      map(y, width, row);
      const dense = y === y0 || y === y1 - 1;
      for (let x = 0; x < width; x += dense ? every : Math.min(every * 4, width - 1 || 1)) add(row[x * 2], row[x * 2 + 1]);
      add(row[(width - 1) * 2], row[(width - 1) * 2 + 1]);
      if (y >= y1 - 1) break;
    }
  }
  if (minX > maxX) return null;
  // Room for the interpolation kernel, plus one pixel for positions between the samples above.
  const pad = KERNEL_MARGIN[resample] + (mapping.kind === 'transform' && mapping.inverse.type !== 'affine' ? 2 : 1);
  const left = Math.max(0, Math.floor(minX) - pad);
  const top = Math.max(0, Math.floor(minY) - pad);
  const right = Math.min(srcWidth, Math.ceil(maxX) + pad);
  const bottom = Math.min(srcHeight, Math.ceil(maxY) + pad);
  return left < right && top < bottom ? [left, top, right, bottom] : null;
}
