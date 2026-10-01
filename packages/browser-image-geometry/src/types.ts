/** A 2D point or vector, `[x, y]`. */
export type Point = readonly [x: number, y: number];

/** `X = a·x + b·y + c`, `Y = d·x + e·y + f`, stored row-major as `[a, b, c, d, e, f]`. */
export type AffineMatrix = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

/** Row-major 3×3 homography. `X = (h0·x + h1·y + h2) / (h6·x + h7·y + h8)`, `Y = (h3·x + h4·y + h5) / (…)`. */
export type ProjectiveMatrix = readonly [number, number, number, number, number, number, number, number, number];

interface TransformBase {
  /**
   * True when the target axis points up (map coordinates such as longitude/latitude
   * or metres): the output image then has north at the top. False or absent for
   * image coordinates, where y points down.
   */
  readonly yUp?: boolean;
}

export interface AffineTransform extends TransformBase {
  readonly type: 'affine';
  readonly matrix: AffineMatrix;
}

export interface ProjectiveTransform extends TransformBase {
  readonly type: 'projective';
  readonly matrix: ProjectiveMatrix;
}

/**
 * One direction of a polynomial transform. The input is normalized first,
 * `u = (x - origin[0]) / scale`, `v = (y - origin[1]) / scale`, then
 * `X = Σ x[k]·term_k(u, v)` with terms `1, u, v, u², uv, v²` (order 2)
 * followed by `u³, u²v, uv², v³` (order 3).
 */
export interface PolynomialMap {
  readonly origin: Point;
  readonly scale: number;
  readonly x: readonly number[];
  readonly y: readonly number[];
}

/** Polynomials have no closed-form inverse, so both directions are stored (as GDAL does). */
export interface PolynomialTransform extends TransformBase {
  readonly type: 'polynomial';
  readonly order: 2 | 3;
  /** Source pixel → target. */
  readonly forward: PolynomialMap;
  /** Target → source pixel. */
  readonly inverse: PolynomialMap;
}

/**
 * Maps source image coordinates to target coordinates. Plain objects, so they
 * can be saved as JSON and sent to workers.
 *
 * Image coordinates are continuous: pixel `(i, j)` covers `[i, i+1) × [j, j+1)`
 * and its center is `(i + 0.5, j + 0.5)`.
 */
export type Transform = AffineTransform | ProjectiveTransform | PolynomialTransform;

/** How pixel values are interpolated. */
export type Resample = 'nearest' | 'bilinear' | 'bicubic';

/** A color, each channel 0-255. */
export type RGBA = readonly [r: number, g: number, b: number, a: number];

/**
 * Converts between the transform's target coordinates and the output's
 * coordinate system, e.g. `proj4('EPSG:4326', 'EPSG:3857')`.
 */
export interface CoordinateTransform {
  /** Transform target → output coordinates. */
  forward(point: [number, number]): number[];
  /** Output → transform target coordinates. */
  inverse(point: [number, number]): number[];
}
