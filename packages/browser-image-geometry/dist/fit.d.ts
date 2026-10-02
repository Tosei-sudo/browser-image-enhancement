import { Point, Transform } from "./types.js";
//#region src/fit.d.ts
/** A control point: a position in the source image and where it belongs in the target. */
export interface ControlPoint {
  /** Source image coordinates (pixel `(i, j)` has its center at `(i + 0.5, j + 0.5)`). */
  readonly pixel: Point;
  /** Target coordinates (map coordinates, or pixels of the corrected image). */
  readonly world: Point;
}
/**
 * Which transform {@link fitTransform} estimates: `affine` (shift, rotation,
 * scale, shear), `projective` (homography, for perspective), or a 2nd/3rd order
 * polynomial (for gently curved distortion). See {@link MIN_POINTS}.
 */
export type TransformModel = 'affine' | 'projective' | 'polynomial2' | 'polynomial3';
/** Options for {@link fitTransform}. */
export interface FitOptions {
  /** Default `affine`. */
  model?: TransformModel;
  /**
   * What `world` is. `map` (default): y points up (north), so the output image
   * has north at the top. `image`: pixel coordinates with y pointing down.
   */
  target?: 'map' | 'image';
}
/** How far the fitted transform misses one control point, in target units. */
export interface Residual {
  /** Fitted minus given target x. */
  readonly dx: number;
  /** Fitted minus given target y. */
  readonly dy: number;
  /** Length of `(dx, dy)`. */
  readonly distance: number;
}
/** What {@link fitTransform} returns. */
export interface FitResult {
  /** The fitted transform, ready for {@link warp} or {@link applyTransform}. */
  readonly transform: Transform;
  /** Root mean square of the residual distances, in target units. */
  readonly rms: number;
  /** One per control point, in the order given. */
  readonly residuals: readonly Residual[];
}
/** Fewest control points each model needs. */
export declare const MIN_POINTS: Readonly<Record<TransformModel, number>>;
/**
 * Estimates the transform that maps each control point's `pixel` onto its `world`
 * position, by least squares. With more points than the minimum, `residuals`
 * show how well they agree. Throws DegenerateError when the points cannot
 * determine the model (too few, or for example all on one line).
 */
export declare function fitTransform(points: readonly ControlPoint[], options?: FitOptions): FitResult;
//#endregion
//# sourceMappingURL=fit.d.ts.map