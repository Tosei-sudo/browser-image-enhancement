/** Estimating a transform from control points by least squares. */
import { DegenerateError, leastSquares, multiply3 } from './linalg.js';
import { pointFunction, polynomialTerms } from './transform.js';
import type { AffineMatrix, Point, PolynomialMap, ProjectiveMatrix, Transform } from './types.js';

/** A control point: a position in the source image and where it belongs in the target. */
export interface ControlPoint {
  /** Source image coordinates (pixel `(i, j)` has its center at `(i + 0.5, j + 0.5)`). */
  readonly pixel: Point;
  /** Target coordinates (map coordinates, or pixels of the corrected image). */
  readonly world: Point;
}

export type TransformModel = 'affine' | 'projective' | 'polynomial2' | 'polynomial3';

export interface FitOptions {
  /** Default `affine`. */
  model?: TransformModel;
  /**
   * What `world` is. `map` (default): y points up (north), so the output image
   * has north at the top. `image`: pixel coordinates with y pointing down.
   */
  target?: 'map' | 'image';
}

export interface Residual {
  /** Fitted minus given target position. */
  readonly dx: number;
  readonly dy: number;
  readonly distance: number;
}

export interface FitResult {
  readonly transform: Transform;
  /** Root mean square of the residual distances, in target units. */
  readonly rms: number;
  /** One per control point, in the order given. */
  readonly residuals: readonly Residual[];
}

/** Fewest control points each model needs. */
export const MIN_POINTS: Readonly<Record<TransformModel, number>> = {
  affine: 3,
  projective: 4,
  polynomial2: 6,
  polynomial3: 10,
};

interface Normalization {
  origin: [number, number];
  scale: number;
}

/** Centroid and RMS radius, so fitted coordinates are around unit size. */
function normalization(points: readonly Point[]): Normalization {
  let mx = 0;
  let my = 0;
  for (const [x, y] of points) {
    mx += x;
    my += y;
  }
  mx /= points.length;
  my /= points.length;
  let r = 0;
  for (const [x, y] of points) r += (x - mx) ** 2 + (y - my) ** 2;
  const scale = Math.sqrt(r / points.length) || 1;
  return { origin: [mx, my], scale };
}

function fitAffine(src: readonly Point[], dst: readonly Point[]): AffineMatrix {
  const { origin, scale } = normalization(src);
  const n = src.length;
  const a = new Float64Array(n * 3);
  const bx = new Float64Array(n);
  const by = new Float64Array(n);
  src.forEach(([x, y], i) => {
    a.set([(x - origin[0]) / scale, (y - origin[1]) / scale, 1], i * 3);
    bx[i] = dst[i][0];
    by[i] = dst[i][1];
  });
  const [px, py] = leastSquares(a, n, 3, [bx, by]);
  // Undo the normalization: u = (x - ox) / s.
  const lift = (p: Float64Array): [number, number, number] => [
    p[0] / scale,
    p[1] / scale,
    p[2] - (p[0] * origin[0] + p[1] * origin[1]) / scale,
  ];
  return [...lift(px), ...lift(py)];
}

function fitProjective(src: readonly Point[], dst: readonly Point[]): ProjectiveMatrix {
  // Normalized direct linear transform with h8 = 1 (Hartley & Zisserman).
  const ns = normalization(src);
  const nd = normalization(dst);
  const n = src.length;
  const a = new Float64Array(2 * n * 8);
  const b = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const x = (src[i][0] - ns.origin[0]) / ns.scale;
    const y = (src[i][1] - ns.origin[1]) / ns.scale;
    const X = (dst[i][0] - nd.origin[0]) / nd.scale;
    const Y = (dst[i][1] - nd.origin[1]) / nd.scale;
    a.set([x, y, 1, 0, 0, 0, -X * x, -X * y], 2 * i * 8);
    a.set([0, 0, 0, x, y, 1, -Y * x, -Y * y], (2 * i + 1) * 8);
    b[2 * i] = X;
    b[2 * i + 1] = Y;
  }
  const [h] = leastSquares(a, 2 * n, 8, [b]);
  const hn = [...h, 1];
  const ts = [1 / ns.scale, 0, -ns.origin[0] / ns.scale, 0, 1 / ns.scale, -ns.origin[1] / ns.scale, 0, 0, 1];
  const tdInv = [nd.scale, 0, nd.origin[0], 0, nd.scale, nd.origin[1], 0, 0, 1];
  const m = multiply3(tdInv, multiply3(hn, ts));
  const s = m[8];
  if (!(Math.abs(s) > 0)) throw new DegenerateError('The control points are degenerate.');
  return m.map((v) => v / s) as unknown as ProjectiveMatrix;
}

function fitPolynomialMap(order: 2 | 3, src: readonly Point[], dst: readonly Point[]): PolynomialMap {
  const { origin, scale } = normalization(src);
  const n = src.length;
  const k = order === 2 ? 6 : 10;
  const a = new Float64Array(n * k);
  const row = new Float64Array(k);
  const bx = new Float64Array(n);
  const by = new Float64Array(n);
  src.forEach(([x, y], i) => {
    polynomialTerms(order, (x - origin[0]) / scale, (y - origin[1]) / scale, row);
    a.set(row, i * k);
    bx[i] = dst[i][0];
    by[i] = dst[i][1];
  });
  const [cx, cy] = leastSquares(a, n, k, [bx, by]);
  return { origin, scale, x: Array.from(cx), y: Array.from(cy) };
}

function checkPoints(points: readonly ControlPoint[]): void {
  if (!Array.isArray(points)) throw new TypeError('Expected an array of control points.');
  for (const p of points) {
    const ok = p && [p.pixel, p.world].every((q) => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite));
    if (!ok) throw new TypeError('Each control point needs `pixel: [x, y]` and `world: [x, y]` with finite numbers.');
  }
}

/**
 * Estimates the transform that maps each control point's `pixel` onto its `world`
 * position, by least squares. With more points than the minimum, `residuals`
 * show how well they agree. Throws DegenerateError when the points cannot
 * determine the model (too few, or for example all on one line).
 */
export function fitTransform(points: readonly ControlPoint[], options: FitOptions = {}): FitResult {
  checkPoints(points);
  const model = options.model ?? 'affine';
  const min = MIN_POINTS[model];
  if (min === undefined) throw new TypeError(`Unknown model: ${String(model)}`);
  if (points.length < min) {
    throw new DegenerateError(`The ${model} model needs at least ${min} control points (got ${points.length}).`);
  }
  const yUp = (options.target ?? 'map') === 'map' ? { yUp: true } : {};
  const src = points.map((p) => p.pixel);
  const dst = points.map((p) => p.world);

  let transform: Transform;
  if (model === 'affine') transform = { type: 'affine', matrix: fitAffine(src, dst), ...yUp };
  else if (model === 'projective') transform = { type: 'projective', matrix: fitProjective(src, dst), ...yUp };
  else {
    const order = model === 'polynomial2' ? 2 : 3;
    transform = {
      type: 'polynomial',
      order,
      forward: fitPolynomialMap(order, src, dst),
      inverse: fitPolynomialMap(order, dst, src),
      ...yUp,
    };
  }

  const apply = pointFunction(transform);
  const out = [0, 0];
  let sum = 0;
  const residuals = points.map(({ pixel, world }) => {
    apply(pixel[0], pixel[1], out);
    const dx = out[0] - world[0];
    const dy = out[1] - world[1];
    const distance = Math.hypot(dx, dy);
    sum += distance * distance;
    return { dx, dy, distance };
  });
  return { transform, rms: Math.sqrt(sum / points.length), residuals };
}
