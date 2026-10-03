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

/**
 * Sharpening (unsharp mask) parameters. Edges are found on the luminance of
 * sRGB-encoded values and the same change is added to R, G and B, so colors
 * do not fringe; monochrome images are sharpened on their one channel.
 */
export interface SharpenOptions {
  /** Strength, 0-5: how much of the difference from the blurred image is added. Default 0.5. */
  amount?: number;
  /**
   * Radius of the Gaussian blur (its standard deviation) in pixels, 0.1-50.
   * Default 1. Each pixel looks about `ceil(3 * radius)` pixels away, so time
   * grows with the radius.
   */
  radius?: number;
  /**
   * Differences smaller than this (sRGB-encoded, 0-1; multiply by 255 for
   * levels) are left alone, which keeps smooth areas and noise from being
   * sharpened. Default 0.
   */
  threshold?: number;
}

/** A curve point: `[input, output]`, both sRGB-encoded values in [0, 1]. */
export type CurvePoint = readonly [number, number];

/**
 * Tone curve parameters. Each curve is a list of points joined by a smooth
 * curve that never overshoots between them (monotone cubic interpolation).
 * Points are sorted by input; a curve that does not start at input 0 or end
 * at input 1 gets the point (0, 0) or (1, 1) added.
 */
export interface CurveOptions {
  /** Curve for all channels. Default: the straight line (no change). */
  points?: readonly CurvePoint[];
  /** Extra curve for red, applied after `points`. No effect on monochrome images. */
  red?: readonly CurvePoint[];
  /** Extra curve for green, applied after `points`. */
  green?: readonly CurvePoint[];
  /** Extra curve for blue, applied after `points`. */
  blue?: readonly CurvePoint[];
}

/**
 * White balance from a gray point: the color (sRGB-encoded, 0-1) of something
 * in the picture that should be neutral gray. Pixels of that color become gray
 * and white keeps its brightness. Take it from the image with `sampleColor`.
 */
export interface WhiteBalanceOptions {
  /** Red of the gray point. Default 0.5. */
  r?: number;
  /** Green of the gray point. Default 0.5. */
  g?: number;
  /** Blue of the gray point. Default 0.5. */
  b?: number;
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
  | {
      op: 'tint';
      /** -1 (greener) to 1 (more magenta). */
      amount: number;
    }
  | ({ op: 'whiteBalance' } & Required<WhiteBalanceOptions>)
  | {
      op: 'shadows';
      /** -1 (darker shadows) to 1 (lifted shadows). */
      amount: number;
    }
  | {
      op: 'highlights';
      /** -1 (recovered, darker highlights) to 1 (brighter highlights). */
      amount: number;
    }
  | {
      op: 'curve';
      /** Curve for all channels, sorted, from input 0 to 1. */
      points: CurvePoint[];
      /** Red curve, applied after `points`. */
      red: CurvePoint[];
      /** Green curve, applied after `points`. */
      green: CurvePoint[];
      /** Blue curve, applied after `points`. */
      blue: CurvePoint[];
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
  | ({ op: 'autoStretch' } & Required<AutoStretchOptions>)
  /** Unsharp mask. Unlike the other steps it looks at neighbouring pixels. */
  | ({ op: 'sharpen' } & Required<SharpenOptions>);

/** The name of a correction step. */
export type OpName = OpSpec['op'];

/** The options each step takes, by step name (what {@link Pipeline.set} accepts besides a number). */
export interface StepOptions {
  /** Brightness. */
  brightness: {
    /** -1 to 1. */
    amount?: number;
  };
  /** Contrast. */
  contrast: {
    /** -1 to 1. */
    amount?: number;
  };
  /** Exposure in EV. */
  exposure: {
    /** EV stops, -10 to 10. */
    ev?: number;
  };
  /** Gamma. */
  gamma: {
    /** 0.1 to 10. */
    gamma?: number;
  };
  /** Saturation. */
  saturation: {
    /** -1 to 1. */
    amount?: number;
  };
  /** Color temperature. */
  temperature: {
    /** -1 to 1. */
    amount?: number;
  };
  /** Tint. */
  tint: {
    /** -1 to 1. */
    amount?: number;
  };
  /** White balance from a gray point. */
  whiteBalance: WhiteBalanceOptions;
  /** Shadows. */
  shadows: {
    /** -1 to 1. */
    amount?: number;
  };
  /** Highlights. */
  highlights: {
    /** -1 to 1. */
    amount?: number;
  };
  /** Tone curve. */
  curve: CurveOptions;
  /** Levels. */
  levels: LevelsOptions;
  /** Fixed stretch. */
  stretch: StretchOptions;
  /** Automatic stretch. */
  autoStretch: AutoStretchOptions;
  /** Unsharp mask. */
  sharpen: SharpenOptions;
}

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
