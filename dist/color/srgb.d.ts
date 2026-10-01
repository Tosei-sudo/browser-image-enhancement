/**
 * sRGB <-> linear-light conversion.
 *
 * Decoding uses a 256-entry table (8-bit input only has 256 values).
 * Encoding back to 8 bits uses the 255 decision thresholds between adjacent
 * codes, so `quantize` returns exactly `round(encode(v) * 255)` without
 * evaluating `Math.pow` per pixel.
 */
/** Exact sRGB transfer function: encoded value in [0, 1] -> linear light. */
export declare function srgbToLinear(v: number): number;
/** Exact inverse sRGB transfer function: linear light -> encoded value. Negative input maps to 0. */
export declare function linearToSrgb(v: number): number;
/** Linear-light value of every 8-bit sRGB code. */
export declare const SRGB_TO_LINEAR: Float64Array;
/**
 * Linear light -> 8-bit sRGB code, rounding half up and clamping to [0, 255].
 * NaN and negative values map to 0.
 */
export declare function quantize(v: number): number;
/** Rec. 709 / sRGB luminance weights for linear RGB. */
export declare const LUMA_R = 0.2126;
export declare const LUMA_G = 0.7152;
export declare const LUMA_B = 0.0722;
//# sourceMappingURL=srgb.d.ts.map