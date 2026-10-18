import { RasterHistogram } from "./raster.js";
import { ColorScale } from "./color-scale.js";
//#region src/color-classes.d.ts
/** One class: its bound or value, its color (`[r, g, b]` or `[r, g, b, a]`, 0-255), and a name for a legend. */
export interface ColorClass {
  /** `range`: the upper bound of the class (inclusive). `exact`: the value of the class. */
  value: number;
  /** The class's color, `[r, g, b]` or `[r, g, b, a]` in 0-255. */
  color: readonly number[];
  /** Its name in a legend ("100 – 200", "森林"). */
  label?: string;
}
/** Classes of values and their colors. */
export interface ColorClasses {
  /**
   * `range`: a value goes to the first class (by `value`) whose upper bound
   * it does not exceed, values above the last bound to the last class.
   * `exact`: a value goes to the class of that value; other values are
   * transparent.
   */
  kind: 'range' | 'exact';
  /** The classes, in any order. */
  classes: readonly ColorClass[];
  /** `range`: the lower bound of the first class (values below it still go to the first class). Default: shown from the first bound. */
  min?: number;
  /** How the classes were made, for an editor to offer the same again (`manual`: bounds set by hand). Not used to show them. */
  method?: ClassMethod | 'manual';
}
/** How {@link colorClasses} sorts values into classes. */
export type ClassMethod = 'equal' | 'quantile' | 'unique';
/** Options of {@link colorClasses}. */
export interface ColorClassesOptions {
  /** `equal` (default): classes of equal width between the smallest and the largest value. `quantile`: classes of about as many pixels each. `unique`: a class per value (see `maxValues`). */
  method?: ClassMethod;
  /** Number of classes (`equal`, `quantile`). Default 5. */
  count?: number;
  /** The scale the class colors are taken from, evenly from one end to the other. Default `turbo`. */
  scale?: ColorScale;
  /** Takes the colors from the other end of the scale. Default false. */
  reverse?: boolean;
  /** `unique`: at most this many values (more give null). Default 64. */
  maxValues?: number;
  /** The histogram's band the classes are made from. Default 0. */
  band?: number;
}
/**
 * The raw values that the 8-bit codes 0 and 255 should stand for to show
 * `classes` (an image stretched linearly from the first to the second):
 * integer values that span at most 255 one code each, else the classes'
 * whole range.
 */
export declare function classRange(classes: ColorClasses): [number, number];
/**
 * The classes as a 256-entry RGBA table (1024 bytes) for an image shown
 * linearly from `range[0]` (code 0) to `range[1]` (code 255): entry `v` is
 * the color of the class of the value code `v` stands for.
 */
export declare function classPalette(classes: ColorClasses, range?: readonly [number, number]): Uint8ClampedArray;
/** The smallest and largest value counted in `band` of `hist`; null when it counted nothing. */
export declare function histogramValueRange(hist: RasterHistogram, band?: number): [number, number] | null;
/** `count` upper bounds of classes of equal width from `min` to `max`. */
export declare function equalIntervalBreaks(min: number, max: number, count: number): number[];
/**
 * Upper bounds of classes of about as many pixels each (at most `count`;
 * fewer when many pixels share a value, as bounds that fall together are
 * merged).
 */
export declare function quantileBreaks(hist: RasterHistogram, count: number, band?: number): number[];
/** A value of an image and the number of its pixels (see {@link uniqueValues}). */
export interface UniqueValue {
  /** The value. */
  value: number;
  /** Pixels with it. */
  count: number;
}
/**
 * The values counted in `band` of `hist` and how many pixels have each,
 * smallest first; null when there are more than `max`. Values of a
 * histogram of integers (bins no wider than 1 over an integer range) are
 * rounded to integers.
 */
export declare function uniqueValues(hist: RasterHistogram, max?: number, band?: number): UniqueValue[] | null;
/** `count` colors taken evenly along `scale`, from its dark end to its bright end (the other way with `reverse`). */
export declare function classColors(scale: ColorScale, count: number, reverse?: boolean): number[][];
/** A value written with as many decimals as a class `width` needs (two digits finer than it, at most 6; trailing zeros dropped). */
export declare function formatClassValue(value: number, width: number): string;
/** Labels of range classes, "low – high" (the first from `min`). */
export declare function rangeLabels(min: number, bounds: readonly number[]): string[];
/**
 * Classes for the values counted in `hist` (from `rasterHistogram`, or the
 * value histogram of an image), colored along a scale. Null when there is
 * nothing to class, or more distinct values than `maxValues` for `unique`.
 */
export declare function colorClasses(hist: RasterHistogram, options?: ColorClassesOptions): ColorClasses | null;
/** The share of the pixels counted in `hist` that each class gets (0-1, in the order of `classes.classes`). */
export declare function classShares(hist: RasterHistogram, classes: ColorClasses, band?: number): number[];
//#endregion
//# sourceMappingURL=color-classes.d.ts.map