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
export type ColorScaleName =
  | 'gray'
  | 'red'
  | 'green'
  | 'blue'
  | 'cyan'
  | 'magenta'
  | 'yellow'
  | 'orange'
  | 'inferno'
  | 'viridis'
  | 'turbo'
  | 'blueWhiteRed';

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

/** Evenly spaced stops from hex colors. */
function even(...colors: string[]): ColorScaleStop[] {
  return colors.map((hex, i) => [i / (colors.length - 1), [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16))] as const);
}

/** Black to `color`. */
const from = (r: number, g: number, b: number): ColorScaleStop[] => [
  [0, [0, 0, 0]],
  [1, [r, g, b]],
];

/** The preset scales: black to a color, perceptual ramps (inferno, viridis), turbo, and a diverging blue-white-red. */
export const colorScales: Readonly<Record<ColorScaleName, readonly ColorScaleStop[]>> = {
  gray: from(255, 255, 255),
  red: from(255, 0, 0),
  green: from(0, 255, 0),
  blue: from(0, 0, 255),
  cyan: from(0, 255, 255),
  magenta: from(255, 0, 255),
  yellow: from(255, 255, 0),
  orange: from(255, 128, 0),
  inferno: even('#000004', '#320a5e', '#781c6d', '#bc3754', '#ed6925', '#fbb61a', '#fcffa4'),
  viridis: even('#440154', '#46327e', '#365c8d', '#277f8e', '#1fa187', '#4ac16d', '#a0da39', '#fde725'),
  turbo: even('#30123b', '#4662d7', '#36aaf9', '#1ae4b6', '#72fe5e', '#c8ef34', '#faba39', '#f66b19', '#ca2a04', '#7a0403'),
  blueWhiteRed: even('#2166ac', '#67a9cf', '#d1e5f0', '#f7f7f7', '#fddbc7', '#ef8a62', '#b2182b'),
};

/** The stops of a scale, sorted, with positions clamped to 0-1. Throws for an unknown name or a scale without stops. */
export function colorScaleStops(scale: ColorScale): ColorScaleStop[] {
  const stops = typeof scale === 'string' ? colorScales[scale] : scale;
  if (!stops) throw new RangeError(`Unknown color scale: ${String(scale)}`);
  if (!Array.isArray(stops) || stops.length === 0) throw new RangeError('A color scale needs at least one stop.');
  const channel = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(255, Math.max(0, v)) : fallback);
  return stops
    .map(([p, c]) => [Math.min(1, Math.max(0, Number(p) || 0)), [channel(c[0], 0), channel(c[1], 0), channel(c[2], 0), channel(c[3], 255)]] as const)
    .sort((a, b) => a[0] - b[0]);
}

/**
 * The scale as a 256-entry RGBA table (1024 bytes): entry `v` is the color
 * of gray value `v`.
 */
export function colorScalePalette(scale: ColorScale, options: ColorScaleOptions = {}): Uint8ClampedArray {
  const stops = colorScaleStops(scale);
  const out = new Uint8ClampedArray(256 * 4);
  let k = 0;
  for (let v = 0; v < 256; v++) {
    const t = (options.reverse ? 255 - v : v) / 255;
    while (k < stops.length - 1 && stops[k + 1][0] < t) k++;
    const [p0, c0] = stops[k];
    const [p1, c1] = stops[Math.min(k + 1, stops.length - 1)];
    const f = t <= p0 ? 0 : p1 > p0 ? Math.min(1, (t - p0) / (p1 - p0)) : 1;
    for (let c = 0; c < 4; c++) out[4 * v + c] = Math.round(c0[c] + (c1[c] - c0[c]) * f);
    if (options.fade) out[4 * v + 3] = Math.round((out[4 * v + 3] * v) / 255);
  }
  return out;
}

/**
 * Colors RGBA pixels in place with a palette from {@link colorScalePalette}:
 * each pixel by its gray value (its luminance when it is colored), its alpha
 * multiplied by the palette's.
 */
export function applyPalette(data: Uint8ClampedArray, palette: ArrayLike<number>): Uint8ClampedArray {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const v = r === g && g === b ? r : Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const p = 4 * v;
    data[i] = palette[p];
    data[i + 1] = palette[p + 1];
    data[i + 2] = palette[p + 2];
    data[i + 3] = Math.round((data[i + 3] * palette[p + 3]) / 255);
  }
  return data;
}
