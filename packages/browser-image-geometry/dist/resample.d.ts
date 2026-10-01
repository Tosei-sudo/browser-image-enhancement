import { AffineMatrix, Transform } from "./types.js";
//#region src/resample.d.ts
/**
 * Where each output pixel comes from. Plain data, so it can be sent to workers.
 *
 * - `transform`: output pixel → target with the affine `output`, then target →
 *   source with `inverse`.
 * - `grid`: source positions precomputed every `step` output pixels and
 *   interpolated bilinearly in between (for coordinate transforms that cannot
 *   be sent to a worker, such as proj4).
 *
 * Source positions are divided by `divisor` (a power of two) when the source
 * was shrunk beforehand.
 */
export type Mapping = {
  kind: 'transform';
  inverse: Transform;
  output: AffineMatrix;
  divisor: number;
} | {
  kind: 'grid';
  step: number;
  columns: number;
  rows: number;
  points: Float64Array;
  divisor: number;
};
//#endregion
//# sourceMappingURL=resample.d.ts.map