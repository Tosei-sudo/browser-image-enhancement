import { Point, Transform } from "./types.js";
//#region src/fit.d.ts
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