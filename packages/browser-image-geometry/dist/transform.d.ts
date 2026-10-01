import { AffineMatrix, AffineTransform, Point, ProjectiveMatrix, ProjectiveTransform, Transform } from "./types.js";
import { DegenerateError } from "./linalg.js";
//#region src/transform.d.ts
/** An affine transform from `[a, b, c, d, e, f]` (`X = a·x + b·y + c`, `Y = d·x + e·y + f`). */
export declare function affine(matrix: AffineMatrix, options?: {
  yUp?: boolean;
}): AffineTransform;
/** A projective transform (homography) from a row-major 3×3 matrix. */
export declare function projective(matrix: ProjectiveMatrix, options?: {
  yUp?: boolean;
}): ProjectiveTransform;
/** The identity transform. */
export declare function identity(): AffineTransform;
/** Rotation by `degrees` (clockwise on screen, where y points down) about `center`. */
export declare function rotation(degrees: number, center?: Point): AffineTransform;
/** Scaling by `sx`, `sy` about the origin. */
export declare function scaling(sx: number, sy?: number): AffineTransform;
/** Translation by `tx`, `ty`. */
export declare function translation(tx: number, ty: number): AffineTransform;
/** Applies `t` to one point (source → target). */
export declare function applyTransform(t: Transform, point: Point): [number, number];
/** The transform from target back to source. */
export declare function invertTransform<T extends Transform>(t: T): T;
/**
 * `second ∘ first`: apply `first`, then `second`. Both must be affine or projective;
 * the result is affine when both are. Keeps `second`'s `yUp`.
 */
export declare function composeTransforms(first: Transform, second: Transform): AffineTransform | ProjectiveTransform;
//#endregion
//# sourceMappingURL=transform.d.ts.map