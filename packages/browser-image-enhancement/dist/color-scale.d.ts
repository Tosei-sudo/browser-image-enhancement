/**
 * Color scales (pseudo-color): a gray value, 0 (black) to 255 (white), picks
 * a color along a ramp. A monochrome image (a SAR scene, one band of a
 * multispectral image) shown in a red scale, for example, goes from black to
 * red; two scenes in red and cyan, one screened over the other, show where
 * they differ.
 *
 * A scale is a named preset or a list of stops, each a position from 0 to 1
 * and a color, `[r, g, b]` or `[r, g, b, a]` in 0-255; colors in between are
 * interpolated linearly (on the 8-bit codes, as they are shown).
 * {@link colorScalePalette} turns a scale into a 256-entry RGBA table for
 * {@link GpuRenderer.render} and `GpuCorrectedTileLayer.setColorScale`.
 */
/** A point of a scale: its position (0 to 1) and its color, `[r, g, b]` or `[r, g, b, a]` in 0-255. */
export type ColorScaleStop = readonly [position: number, color: readonly number[]];
/** The names of the preset scales in {@link colorScales}. */
export type ColorScaleName = 'gray' | 'red' | 'green' | 'blue' | 'cyan' | 'magenta' | 'yellow' | 'orange' | 'inferno' | 'viridis' | 'turbo' | 'blueWhiteRed';
/** A color scale: a preset's name, or its stops. */
export type ColorScale = ColorScaleName | readonly ColorScaleStop[];
/** Options of {@link colorScalePalette}. */
export interface ColorScaleOptions {
  /** Runs the scale from white to black instead (dark pixels get the bright end). Default false. */
  reverse?: boolean;
  /**
   * Makes the dark end transparent, fading in along the scale: an image in
   * such a scale can be laid over another one and only its bright parts
   * show. Default false.
   */
  fade?: boolean;
}
/** The preset scales: black to a color, perceptual ramps (inferno, viridis), turbo, and a diverging blue-white-red. */
export declare const colorScales: Readonly<Record<ColorScaleName, readonly ColorScaleStop[]>>;
/** The stops of a scale, sorted, with positions clamped to 0-1. Throws for an unknown name or a scale without stops. */
export declare function colorScaleStops(scale: ColorScale): ColorScaleStop[];
/**
 * The scale as a 256-entry RGBA table (1024 bytes): entry `v` is the color
 * of gray value `v`.
 */
export declare function colorScalePalette(scale: ColorScale, options?: ColorScaleOptions): Uint8ClampedArray;
/**
 * Colors RGBA pixels in place with a palette from {@link colorScalePalette}:
 * each pixel by its gray value (its luminance when it is colored), its alpha
 * multiplied by the palette's.
 */
export declare function applyPalette(data: Uint8ClampedArray, palette: ArrayLike<number>): Uint8ClampedArray;
//# sourceMappingURL=color-scale.d.ts.map