/**
 * What each correction step takes: parameter ranges, defaults and slider
 * steps, in one table. Parameter normalization (ops/index.ts) reads its ranges
 * and defaults from here, so the table and the clamping always agree.
 */
import type { OpName } from '../types.js';

/** A number parameter. Values outside `min`..`max` are clamped (with a warning in development). */
export interface NumberParamInfo {
  /** Always `number`. */
  type: 'number';
  /** Smallest accepted value. */
  min: number;
  /** Largest accepted value. */
  max: number;
  /** Value used when the parameter is left out. */
  default: number;
  /** A suggested slider step. */
  step: number;
}

/** A parameter that takes one of a few strings. */
export interface EnumParamInfo {
  /** Always `enum`. */
  type: 'enum';
  /** The accepted values. */
  values: readonly string[];
  /** Value used when the parameter is left out. */
  default: string;
}

/** An on/off parameter. */
export interface BooleanParamInfo {
  /** Always `boolean`. */
  type: 'boolean';
  /** Value used when the parameter is left out. */
  default: boolean;
}

/**
 * Per-channel points: one number for all channels or `[R, G, B]`, each in
 * `min`..`max` (the slider range; larger values up to 1000 are accepted).
 */
export interface RgbParamInfo {
  /** Always `rgb`. */
  type: 'rgb';
  /** Smallest value of the slider range. */
  min: number;
  /** Largest value of the slider range. */
  max: number;
  /** Value used when the parameter is left out. */
  default: number;
  /** A suggested slider step. */
  step: number;
}

/** A tone curve: a list of `[input, output]` points (sRGB-encoded, 0-1). */
export interface CurveParamInfo {
  /** Always `curve`. */
  type: 'curve';
  /** Value used when the parameter is left out: the straight line from black to white. */
  default: ReadonlyArray<readonly [number, number]>;
}

/** Description of one parameter of a step. */
export type ParamInfo = NumberParamInfo | EnumParamInfo | BooleanParamInfo | RgbParamInfo | CurveParamInfo;

/** Description of one correction step, for building controls such as sliders. */
export interface OpInfo {
  /** The step's parameters by name, in a natural order for controls. */
  params: Readonly<Record<string, ParamInfo>>;
  /**
   * The parameter a single number sets in `pipeline.set(op, value)` (the
   * amount, EV or gamma), or null when the step only takes an object.
   */
  value: string | null;
  /** True when the step only changes colors, so it does nothing to a monochrome image. */
  colorOnly: boolean;
  /** True when the step reads neighbouring pixels (it needs `pipeline.margin` around tiles). */
  spatial: boolean;
  /** True when the step is computed from the image's own statistics. */
  auto: boolean;
}

const CURVE: CurveParamInfo = {
  type: 'curve',
  default: [
    [0, 0],
    [1, 1],
  ],
};

const amount = (step = 0.01): NumberParamInfo => ({ type: 'number', min: -1, max: 1, default: 0, step });

/**
 * Parameter ranges, defaults and suggested slider steps of every correction
 * step, plus what kind of step it is.
 *
 * @example
 * ```ts
 * const { min, max, step, default: value } = opInfo.contrast.params.amount as NumberParamInfo;
 * slider.min = String(min); slider.max = String(max); slider.step = String(step); slider.value = String(value);
 * slider.oninput = () => (p = p.set('contrast', Number(slider.value)));
 * ```
 */
export const opInfo: { readonly [N in OpName]: OpInfo } = {
  brightness: { params: { amount: amount() }, value: 'amount', colorOnly: false, spatial: false, auto: false },
  contrast: { params: { amount: amount() }, value: 'amount', colorOnly: false, spatial: false, auto: false },
  exposure: {
    params: { ev: { type: 'number', min: -10, max: 10, default: 0, step: 0.05 } },
    value: 'ev',
    colorOnly: false,
    spatial: false,
    auto: false,
  },
  gamma: {
    params: { gamma: { type: 'number', min: 0.1, max: 10, default: 1, step: 0.01 } },
    value: 'gamma',
    colorOnly: false,
    spatial: false,
    auto: false,
  },
  saturation: { params: { amount: amount() }, value: 'amount', colorOnly: true, spatial: false, auto: false },
  temperature: { params: { amount: amount() }, value: 'amount', colorOnly: true, spatial: false, auto: false },
  tint: { params: { amount: amount() }, value: 'amount', colorOnly: true, spatial: false, auto: false },
  whiteBalance: {
    params: {
      r: { type: 'number', min: 1 / 255, max: 1, default: 0.5, step: 1 / 255 },
      g: { type: 'number', min: 1 / 255, max: 1, default: 0.5, step: 1 / 255 },
      b: { type: 'number', min: 1 / 255, max: 1, default: 0.5, step: 1 / 255 },
    },
    value: null,
    colorOnly: true,
    spatial: false,
    auto: false,
  },
  shadows: { params: { amount: amount() }, value: 'amount', colorOnly: false, spatial: false, auto: false },
  highlights: { params: { amount: amount() }, value: 'amount', colorOnly: false, spatial: false, auto: false },
  curve: {
    params: { points: CURVE, red: CURVE, green: CURVE, blue: CURVE },
    value: null,
    colorOnly: false,
    spatial: false,
    auto: false,
  },
  levels: {
    params: {
      inBlack: { type: 'number', min: 0, max: 1, default: 0, step: 1 / 255 },
      inWhite: { type: 'number', min: 0, max: 1, default: 1, step: 1 / 255 },
      gamma: { type: 'number', min: 0.1, max: 10, default: 1, step: 0.01 },
      outBlack: { type: 'number', min: 0, max: 1, default: 0, step: 1 / 255 },
      outWhite: { type: 'number', min: 0, max: 1, default: 1, step: 1 / 255 },
    },
    value: null,
    colorOnly: false,
    spatial: false,
    auto: false,
  },
  stretch: {
    params: {
      black: { type: 'rgb', min: 0, max: 1, default: 0, step: 1 / 255 },
      white: { type: 'rgb', min: 0, max: 1, default: 1, step: 1 / 255 },
    },
    value: null,
    colorOnly: false,
    spatial: false,
    auto: false,
  },
  autoStretch: {
    params: {
      method: { type: 'enum', values: ['percentClip', 'minMax', 'standardDeviation'], default: 'percentClip' },
      lowPercent: { type: 'number', min: 0, max: 50, default: 0.5, step: 0.1 },
      highPercent: { type: 'number', min: 0, max: 50, default: 0.5, step: 0.1 },
      stdDevs: { type: 'number', min: 0.1, max: 10, default: 2, step: 0.1 },
      linked: { type: 'boolean', default: false },
    },
    value: null,
    colorOnly: false,
    spatial: false,
    auto: true,
  },
  sharpen: {
    params: {
      amount: { type: 'number', min: 0, max: 5, default: 0.5, step: 0.05 },
      radius: { type: 'number', min: 0.1, max: 50, default: 1, step: 0.1 },
      threshold: { type: 'number', min: 0, max: 1, default: 0, step: 1 / 255 },
    },
    value: 'amount',
    colorOnly: false,
    spatial: true,
    auto: false,
  },
};

/** The number parameter `param` of `op` (internal: the table is known to have it). */
export function numberParam(op: OpName, param: string): NumberParamInfo {
  return opInfo[op].params[param] as NumberParamInfo;
}
