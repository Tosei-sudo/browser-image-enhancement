import { ImageDataLike } from "./workers/src/image.js";
import { ColorOptions, LevelsOptions } from "./types.js";
//#region src/functional.d.ts
/** Brightness, -1 to 1. Positive moves toward white, negative toward black. */
export declare function brightness(image: ImageDataLike, amount: number, options?: ColorOptions): ImageData;
/** Contrast around mid-gray, -1 (flat gray) to 1 (threshold). */
export declare function contrast(image: ImageDataLike, amount: number, options?: ColorOptions): ImageData;
/** Exposure in EV stops, -10 to 10. +1 doubles the light. */
export declare function exposure(image: ImageDataLike, ev: number, options?: ColorOptions): ImageData;
/** Gamma, 0.1 to 10. Values above 1 brighten midtones. */
export declare function gamma(image: ImageDataLike, value: number, options?: ColorOptions): ImageData;
/** Saturation, -1 (grayscale) to 1 (double). No effect on monochrome images. */
export declare function saturation(image: ImageDataLike, amount: number, options?: ColorOptions): ImageData;
/** Color temperature, -1 (cooler/bluer) to 1 (warmer/yellower). No effect on monochrome images. */
export declare function temperature(image: ImageDataLike, amount: number, options?: ColorOptions): ImageData;
/** Levels: input/output black and white points (0-1, sRGB-encoded) and midtone gamma. */
export declare function levels(image: ImageDataLike, params: LevelsOptions, options?: ColorOptions): ImageData;
//#endregion
//# sourceMappingURL=functional.d.ts.map