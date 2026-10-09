//#region src/openlayers/reproject-kernel.d.ts
/**
 * Draws the triangles of a reprojected tile: every target pixel inside a
 * triangle is sampled from the stitched source tiles through that triangle's
 * affine map, bilinear or nearest, clamped at the edges, as OpenLayers' WebGL
 * reprojection does. Free of OpenLayers and the DOM, so a worker can run it
 * (see cpu-reproject.ts, which prepares the job).
 */
export type Pixels = Float32Array | Uint8ClampedArray;
/** One tile's reprojection, in pixels. */
export interface ReprojectJob {
  /** The source tiles stitched together: `bands` values per pixel, `sw` × `sh` pixels. */
  stitch: Pixels;
  sw: number;
  sh: number;
  bands: number;
  /** Size of the target tile in pixels. */
  width: number;
  height: number;
  /** 12 numbers per triangle: its corners in target pixels (u0, v0, u1, v1, u2, v2), then in stitch pixels (s0, t0, ...). */
  corners: Float64Array;
  /** Where the source tiles are in the stitch: x from, x to, y from, y to. */
  bounds: number[];
  /** Bilinear sampling, else nearest. */
  linear: boolean;
}
//#endregion
//# sourceMappingURL=reproject-kernel.d.ts.map