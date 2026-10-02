/** How color is handled. `auto` detects monochrome (R = G = B everywhere) input. */
export type ColorMode = 'auto' | 'rgb' | 'gray';

export type { ImageDataLike } from '@browser-image/workers';

/**
 * Levels parameters. Points are sRGB-encoded values in [0, 1] (multiply by 255
 * for the familiar 0-255 scale); `gamma` is the midtone gamma (> 1 brightens).
 */
export interface LevelsOptions {
  /** Input black point, 0-1. Default 0. */
  inBlack?: number;
  /** Input white point, 0-1. Default 1. */
  inWhite?: number;
  /** Midtone gamma, 0.1-10. Default 1. */
  gamma?: number;
  /** Output black point, 0-1. Default 0. */
  outBlack?: number;
  /** Output white point, 0-1. Default 1. */
  outWhite?: number;
}

/** Three per-channel values: R, G, B. */
export type RGBValues = [number, number, number];

/**
 * Stretch parameters: the input range that is stretched to full black..white.
 * Points are sRGB-encoded values (0-1 for the image as decoded; values above 1
 * reach highlights pushed past white by earlier steps). Give one number for
 * all channels or `[R, G, B]`.
 */
export interface StretchOptions {
  /** Input value that becomes black. Default 0. */
  black?: number | readonly number[];
  /** Input value that becomes white. Default 1. */
  white?: number | readonly number[];
}

/** How `autoStretch` picks the range from the pixel distribution. */
export type StretchMethod = 'percentClip' | 'minMax' | 'standardDeviation';

/** Automatic stretch (dynamic range adjustment) parameters. */
export interface AutoStretchOptions {
  /** Default `percentClip`. */
  method?: StretchMethod;
  /** `percentClip`: percent of pixels clipped to black, 0-50. Default 0.5. */
  lowPercent?: number;
  /** `percentClip`: percent of pixels clipped to white, 0-50. Default 0.5. */
  highPercent?: number;
  /** `standardDeviation`: half-width of the range in standard deviations, 0.1-10. Default 2. */
  stdDevs?: number;
  /**
   * `false` (default) stretches R, G and B independently, which also removes
   * color casts. `true` uses one range from all three, keeping the color balance.
   */
  linked?: boolean;
}

/** A single correction step in serializable form. */
export type OpSpec =
  | {
      op: 'brightness';
      /** -1 to 1. */
      amount: number;
    }
  | {
      op: 'contrast';
      /** -1 to 1. */
      amount: number;
    }
  | {
      op: 'exposure';
      /** Exposure in EV stops, -10 to 10. */
      ev: number;
    }
  | {
      op: 'gamma';
      /** Gamma, 0.1 to 10. Above 1 brightens midtones. */
      gamma: number;
    }
  | {
      op: 'saturation';
      /** -1 (grayscale) to 1 (double). */
      amount: number;
    }
  | {
      op: 'temperature';
      /** -1 (cooler/bluer) to 1 (warmer/yellower). */
      amount: number;
    }
  | ({ op: 'levels' } & Required<LevelsOptions>)
  | {
      op: 'stretch';
      /** Per-channel input value that becomes black. */
      black: RGBValues;
      /** Per-channel input value that becomes white. */
      white: RGBValues;
    }
  /** Replaced by a `stretch` computed from the image's statistics before it runs. */
  | ({ op: 'autoStretch' } & Required<AutoStretchOptions>);

/** The name of a correction step. */
export type OpName = OpSpec['op'];

/** Options shared by every entry point. */
export interface ColorOptions {
  /** Default `auto`. */
  colorMode?: ColorMode;
}

/** A rectangle in pixels. */
export interface Rect {
  /** Left edge. */
  x: number;
  /** Top edge. */
  y: number;
  /** Width. */
  width: number;
  /** Height. */
  height: number;
}

/**
 * Pixel value counts. Transparent pixels (alpha 0) are not counted.
 * Histograms of parts of one picture (tiles, strips) can be added with `mergeHistograms`.
 */
export interface Histogram {
  /** `rgb`: one histogram per R, G, B. `gray`: one histogram of luminance. */
  mode: 'rgb' | 'gray';
  /** 256 counts per channel, indexed by 8-bit sRGB code. */
  bins: Float64Array[];
  /** Number of pixels counted. */
  count: number;
}
