import { type Stage } from '../ops/index.js';
import { Quantizer } from './quantizer.js';
import type { ColorMode, OpSpec } from '../types.js';
/** How pixels are computed: three channels, or one luminance channel. */
export type ResolvedMode = 'rgb' | 'gray';
export interface Program {
    readonly mode: ResolvedMode;
    /** Linear value of each 8-bit input code after the leading per-channel steps (one per channel; gray uses [0]). */
    readonly lutLinear: readonly Float64Array[];
    /** Steps between the leading and trailing per-channel runs; each pixel goes through them in turn. */
    readonly middle: readonly Stage[];
    /** Trailing per-channel steps folded into rounding, one per channel. */
    readonly tail: readonly Quantizer[];
    /** Direct 8-bit -> 8-bit tables when there are no middle steps. */
    readonly lut8: readonly Uint8Array[] | null;
    /** Gray mode only: every step folded into rounding, for colored pixels' luminance. */
    readonly grayFromColor: Quantizer | null;
}
export interface CompileOptions {
    /**
     * Fold steps into tables (default true). With `false` every step runs per
     * pixel; it exists to test that folding changes nothing.
     */
    fuse?: boolean;
}
/**
 * Compiles normalized ops for one color mode. In gray mode color-only ops
 * (saturation, temperature) are dropped.
 */
export declare function compile(ops: readonly OpSpec[], mode: ResolvedMode, options?: CompileOptions): Program;
/** True when every pixel has R = G = B. Stops at the first colored pixel. */
export declare function isMonochrome(data: Uint8ClampedArray): boolean;
/** Turns a requested color mode into the mode pixels are computed in. */
export declare function resolveMode(data: Uint8ClampedArray, colorMode?: ColorMode): ResolvedMode;
/**
 * Applies a program to RGBA pixels. `src` and `dst` must have the same length
 * and may be the same array. Alpha is copied unchanged.
 */
export declare function processPixels(src: Uint8ClampedArray, dst: Uint8ClampedArray, program: Program): void;
/**
 * Luminance of RGBA pixels as one 8-bit channel. Gray pixels (R = G = B) keep
 * their value; colored pixels use Rec. 709 luminance computed in linear light.
 */
export declare function extractGray(data: Uint8ClampedArray): Uint8ClampedArray;
//# sourceMappingURL=process.d.ts.map