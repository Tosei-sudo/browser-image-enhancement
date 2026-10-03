import { OpName } from "../types.js";
//#region src/ops/info.d.ts
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
export declare const opInfo: { readonly [N in OpName]: OpInfo; };
//#endregion
//# sourceMappingURL=info.d.ts.map