import { ImageDataLike } from "./workers/src/image.js";
import { AutoStretchOptions, ColorOptions, CurveOptions, LevelsOptions, SharpenOptions, StretchOptions, WhiteBalanceOptions } from "./types.js";
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
/** Tint, -1 (green) to 1 (magenta). No effect on monochrome images. */
export declare function tint(image: ImageDataLike, amount: number, options?: ColorOptions): ImageData;
/** White balance from a gray point (the sRGB 0-1 color of something that should be neutral, see `sampleColor`). */
export declare function whiteBalance(image: ImageDataLike, gray: WhiteBalanceOptions, options?: ColorOptions): ImageData;
/** Shadows, -1 (darker) to 1 (lifted). */
export declare function shadows(image: ImageDataLike, amount: number, options?: ColorOptions): ImageData;
/** Highlights, -1 (recovered, darker) to 1 (brighter). */
export declare function highlights(image: ImageDataLike, amount: number, options?: ColorOptions): ImageData;
/** Tone curve: `[input, output]` points (sRGB 0-1) for all channels and per channel. */
export declare function curve(image: ImageDataLike, params: CurveOptions, options?: ColorOptions): ImageData;
/** Levels: input/output black and white points (0-1, sRGB-encoded) and midtone gamma. */
export declare function levels(image: ImageDataLike, params: LevelsOptions, options?: ColorOptions): ImageData;
/**
 * Stretches the range black..white (sRGB-encoded, one number or [R, G, B]) to
 * full black..white, clipping values outside it.
 */
export declare function stretch(image: ImageDataLike, params: StretchOptions, options?: ColorOptions): ImageData;
/**
 * Automatic stretch (dynamic range adjustment): picks the range from the
 * image's own pixel distribution, ignoring transparent pixels.
 */
export declare function autoStretch(image: ImageDataLike, params?: AutoStretchOptions, options?: ColorOptions): ImageData;
/**
 * Sharpens with an unsharp mask: adds `amount` times the difference between
 * the image and a Gaussian blur of `radius` pixels, where that difference is
 * at least `threshold`. Works on luminance, so colors do not fringe.
 * Transparent pixels are left as they are and do not darken or lighten their
 * neighbours.
 */
export declare function sharpen(image: ImageDataLike, params?: SharpenOptions, options?: ColorOptions): ImageData;
//#endregion
//# sourceMappingURL=functional.d.ts.map