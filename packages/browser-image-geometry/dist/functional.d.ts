import { RGBA, Resample, Transform } from "./types.js";
import { ImageDataLike } from "./workers/src/image.js";
import { OutputOptions, WarpInfo } from "./plan.js";
//#region src/functional.d.ts
/** A warped image and where it sits in output coordinates. */
export interface WarpResult<I = ImageData> extends WarpInfo {
  readonly image: I;
  readonly width: number;
  readonly height: number;
}
/** Applies `transform` to `image` on the calling thread. */
export declare function warpImageData(image: ImageDataLike, transform: Transform, options?: OutputOptions): WarpResult;
export interface RotateOptions {
  /** Default `bilinear`. Quarter turns are exact whatever the method. */
  resample?: Resample;
  /** Grow the canvas to fit the rotated image (default true), or keep the input size. */
  expand?: boolean;
  /** Fill for the corners. Default transparent. */
  background?: RGBA;
}
/** Rotates by `degrees`, clockwise, about the image center. */
export declare function rotate(image: ImageDataLike, degrees: number, options?: RotateOptions): ImageData;
export type FlipDirection = 'horizontal' | 'vertical' | 'both';
/** Mirrors the image. Exact: pixels are moved, not resampled. */
export declare function flip(image: ImageDataLike, direction?: FlipDirection): ImageData;
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** Cuts out a rectangle (whole pixels, inside the image). Exact. */
export declare function crop(image: ImageDataLike, rect: CropRect): ImageData;
export interface ResizeOptions {
  /** Default `bilinear`. Shrinking by more than 2× halves the image first to avoid aliasing. */
  resample?: Resample;
}
/** Scales to exactly `width` × `height` pixels. */
export declare function resize(image: ImageDataLike, width: number, height: number, options?: ResizeOptions): ImageData;
//#endregion
//# sourceMappingURL=functional.d.ts.map