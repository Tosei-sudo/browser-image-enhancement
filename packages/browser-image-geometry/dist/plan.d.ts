import { CoordinateTransform, RGBA, Resample } from "./types.js";
//#region src/plan.d.ts
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
}
export interface WarpInfo {
  /** Output pixel → output coordinates, GDAL order: `[x0, pixelWidth, rowRotation, y0, columnRotation, pixelHeight]`. */
  readonly geoTransform: readonly [number, number, number, number, number, number];
  /** Area covered by the output image, `[minX, minY, maxX, maxY]` (for OpenLayers' `ImageStatic`). */
  readonly extent: readonly [number, number, number, number];
}
//#endregion
//# sourceMappingURL=plan.d.ts.map