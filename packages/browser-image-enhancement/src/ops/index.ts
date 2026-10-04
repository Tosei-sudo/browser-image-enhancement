/**
 * Correction definitions: parameter normalization and the per-pixel math.
 *
 * All math runs on linear-light values (see color/srgb.ts). Values may leave
 * [0, 1] between steps; they are clamped only when quantized to 8 bits at the end.
 * `sharpen` is the one step that reads neighbouring pixels; core/filter.ts runs it.
 */
import { linearToSrgb, srgbToLinear, LUMA_B, LUMA_G, LUMA_R } from '../color/srgb.js';
import type {
  AutoStretchOptions,
  CurveOptions,
  LevelsOptions,
  OpName,
  OpSpec,
  RGBValues,
  SharpenOptions,
  StretchMethod,
  StretchOptions,
  WhiteBalanceOptions,
} from '../types.js';
import { warn } from '../warn.js';
import { curveFunction, isIdentityCurve, normalizeCurve } from './curve.js';
import { numberParam } from './info.js';

/** A per-channel transform. `c` is 0, 1, 2 for R, G, B (or 0 for a gray channel). */
export type ChannelFn = (v: number, c: number) => number;

/**
 * A step computed from each pixel alone. `channel` steps act on each channel
 * independently; `saturation` mixes channels. `falls` marks a channel step
 * that can decrease (an inverting curve or levels), which must not be folded
 * into the rounding (see core/quantizer.ts, which needs non-decreasing steps).
 */
export type PixelStage = { kind: 'channel'; fn: ChannelFn; falls?: boolean } | { kind: 'saturation'; factor: number };

/** A step that reads neighbouring pixels (see core/filter.ts). */
export type SpatialStage = { kind: 'sharpen' } & Required<SharpenOptions>;

/** One compiled step. */
export type Stage = PixelStage | SpatialStage;

/** Corrections that only make sense for color images; no-ops on monochrome input. */
export const COLOR_ONLY_OPS: ReadonlySet<OpName> = new Set<OpName>(['saturation', 'temperature', 'tint', 'whiteBalance']);

/** Contrast pivots around sRGB 50 % gray so mid-gray stays put. */
export const CONTRAST_PIVOT = srgbToLinear(0.5);

/** Strength of `temperature`: at +1 red gain is 1.4x and blue 0.6x before luminance normalization. */
export const TEMPERATURE_STRENGTH = 0.4;

/** Strength of `tint`: at +1 green gain is 0.7x and red and blue 1.15x before luminance normalization. */
export const TINT_STRENGTH = 0.3;

/**
 * Strength of `shadows` and `highlights`: the largest change, at 1/3 (shadows)
 * or 2/3 (highlights) of the sRGB scale, is 0.14. Below 1 / 6.75 so the curve
 * stays rising for every amount in -1..1.
 */
export const TONE_STRENGTH = 0.945;

/** Linear gains (R, G, B) that keep white's luminance. */
function balancedGains(r: number, g: number, b: number): [number, number, number] {
  const n = LUMA_R * r + LUMA_G * g + LUMA_B * b;
  return [r / n, g / n, b / n];
}

/** Gains of a `temperature` step. */
export function temperatureGains(amount: number): [number, number, number] {
  return balancedGains(1 + TEMPERATURE_STRENGTH * amount, 1, 1 - TEMPERATURE_STRENGTH * amount);
}

/** Gains of a `tint` step. */
export function tintGains(amount: number): [number, number, number] {
  const side = 1 + (TINT_STRENGTH * amount) / 2;
  return balancedGains(side, 1 - TINT_STRENGTH * amount, side);
}

/** Gains of a `whiteBalance` step: the gray point becomes neutral. */
export function whiteBalanceGains(op: Required<WhiteBalanceOptions>): [number, number, number] {
  return balancedGains(1 / srgbToLinear(op.r), 1 / srgbToLinear(op.g), 1 / srgbToLinear(op.b));
}

/**
 * The `shadows` (`high` false) or `highlights` (`high` true) change of the
 * sRGB-encoded value `x` in [0, 1]: a bump that is 0 at black and white.
 */
export function toneShift(x: number, amount: number, high: boolean): number {
  const k = TONE_STRENGTH * amount;
  return x + k * (high ? x * x * (1 - x) : x * (1 - x) * (1 - x));
}

/** Clamps the number parameter `param` of `op` to its range in the table (ops/info.ts), or gives its default. */
function param(op: OpName, name: string, value: unknown, label = `${op}.${name}`): number {
  const { min, max, default: fallback } = numberParam(op, name);
  return num(label, value, min, max, fallback);
}

function num(name: string, value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    if (value !== undefined) warn(`${name} must be a number, got ${String(value)}; using ${fallback}.`);
    return fallback;
  }
  if (value < min || value > max) {
    const clamped = Math.min(max, Math.max(min, value));
    warn(`${name} ${value} is out of range [${min}, ${max}]; clamped to ${clamped}.`);
    return clamped;
  }
  return value;
}

/** Validates and clamps a levels parameter object, filling defaults. */
export function normalizeLevels(o: LevelsOptions = {}): Required<LevelsOptions> {
  let inBlack = param('levels', 'inBlack', o.inBlack);
  let inWhite = param('levels', 'inWhite', o.inWhite);
  if (inWhite <= inBlack) {
    // Keep a one-code gap so the input range is never empty.
    const gap = 1 / 255;
    const before = `inBlack ${inBlack}, inWhite ${inWhite}`;
    if (inBlack + gap <= 1) inWhite = inBlack + gap;
    else [inBlack, inWhite] = [1 - gap, 1];
    warn(`levels.inWhite must be greater than inBlack (${before}); using inBlack ${inBlack}, inWhite ${inWhite}.`);
  }
  return {
    inBlack,
    inWhite,
    gamma: param('levels', 'gamma', o.gamma),
    outBlack: param('levels', 'outBlack', o.outBlack),
    outWhite: param('levels', 'outWhite', o.outWhite),
  };
}

/** Upper bound for stretch points: far above white, but finite. */
const STRETCH_MAX = 1000;

function rgb(name: string, value: unknown, fallback: number): RGBValues {
  if (Array.isArray(value)) {
    if (value.length !== 3) warn(`${name} must be one number or [R, G, B], got ${value.length} values.`);
    return [0, 1, 2].map((c) => num(`${name}[${c}]`, value[c], 0, STRETCH_MAX, fallback)) as RGBValues;
  }
  const v = num(name, value, 0, STRETCH_MAX, fallback);
  return [v, v, v];
}

/** Validates stretch points. A channel whose white is not above its black is left unchanged. */
export function normalizeStretch(o: StretchOptions = {}): { black: RGBValues; white: RGBValues } {
  const black = rgb('stretch.black', o.black, 0);
  const white = rgb('stretch.white', o.white, 1);
  for (let c = 0; c < 3; c++) {
    if (!(white[c] > black[c])) {
      warn(`stretch.white must be greater than black (channel ${c}: ${black[c]}, ${white[c]}); leaving the channel unchanged.`);
      black[c] = 0;
      white[c] = 1;
    }
  }
  return { black, white };
}

/** Validates white balance options, filling defaults. */
export function normalizeWhiteBalance(o: WhiteBalanceOptions = {}): Required<WhiteBalanceOptions> {
  return { r: param('whiteBalance', 'r', o.r), g: param('whiteBalance', 'g', o.g), b: param('whiteBalance', 'b', o.b) };
}

/** Validates curve options, filling in straight lines. */
export function normalizeCurveOptions(o: CurveOptions = {}): Omit<Extract<OpSpec, { op: 'curve' }>, 'op'> {
  return {
    points: normalizeCurve('curve.points', o.points),
    red: normalizeCurve('curve.red', o.red),
    green: normalizeCurve('curve.green', o.green),
    blue: normalizeCurve('curve.blue', o.blue),
  };
}

/** Validates sharpening options, filling defaults. */
export function normalizeSharpen(o: SharpenOptions = {}): Required<SharpenOptions> {
  return {
    amount: param('sharpen', 'amount', o.amount),
    radius: param('sharpen', 'radius', o.radius),
    threshold: param('sharpen', 'threshold', o.threshold),
  };
}

/** How far (in pixels) the blur of a sharpen step with this radius reaches. */
export function kernelRadius(radius: number): number {
  return Math.ceil(3 * radius);
}

/**
 * Pixels of context the steps need on each side: a pixel's result depends
 * only on input pixels at most this far away (0 when every step is per-pixel).
 * An image cut into tiles or strips gives exactly the same pixels as the
 * whole image when each part is processed with this much margin around it.
 */
export function marginOf(ops: readonly OpSpec[]): number {
  let m = 0;
  for (const op of ops) if (op.op === 'sharpen' && !isIdentity(op)) m += kernelRadius(op.radius);
  return m;
}

const STRETCH_METHODS: readonly StretchMethod[] = ['percentClip', 'minMax', 'standardDeviation'];

/** Validates automatic stretch options, filling defaults. */
export function normalizeAutoStretch(o: AutoStretchOptions = {}): Required<AutoStretchOptions> {
  let method: StretchMethod = 'percentClip';
  if (o.method !== undefined) {
    if (STRETCH_METHODS.includes(o.method)) method = o.method;
    else warn(`autoStretch.method must be one of ${STRETCH_METHODS.join(', ')}, got ${String(o.method)}; using percentClip.`);
  }
  return {
    method,
    lowPercent: param('autoStretch', 'lowPercent', o.lowPercent),
    highPercent: param('autoStretch', 'highPercent', o.highPercent),
    stdDevs: param('autoStretch', 'stdDevs', o.stdDevs),
    linked: o.linked === undefined ? false : Boolean(o.linked),
  };
}

/**
 * Validates an op (from code or from JSON) and clamps its parameters.
 * Throws only for an unknown op name, since that cannot be repaired.
 */
export function normalizeOp(raw: unknown): OpSpec {
  const o = (raw ?? {}) as Record<string, unknown>;
  switch (o.op) {
    case 'brightness':
    case 'contrast':
    case 'saturation':
    case 'temperature':
    case 'tint':
    case 'shadows':
    case 'highlights':
      return { op: o.op, amount: param(o.op, 'amount', o.amount, o.op) };
    case 'whiteBalance':
      return { op: 'whiteBalance', ...normalizeWhiteBalance(o as WhiteBalanceOptions) };
    case 'curve':
      return { op: 'curve', ...normalizeCurveOptions(o as CurveOptions) };
    case 'exposure':
      return { op: 'exposure', ev: param('exposure', 'ev', o.ev, 'exposure') };
    case 'gamma':
      return { op: 'gamma', gamma: param('gamma', 'gamma', o.gamma, 'gamma') };
    case 'levels':
      return { op: 'levels', ...normalizeLevels(o as LevelsOptions) };
    case 'stretch':
      return { op: 'stretch', ...normalizeStretch(o as StretchOptions) };
    case 'autoStretch':
      return { op: 'autoStretch', ...normalizeAutoStretch(o as AutoStretchOptions) };
    case 'sharpen':
      return { op: 'sharpen', ...normalizeSharpen(o as SharpenOptions) };
    default:
      throw new TypeError(`Unknown correction: ${String(o.op)}`);
  }
}

/** True when the op leaves every pixel unchanged, so it can be skipped. */
export function isIdentity(op: OpSpec): boolean {
  switch (op.op) {
    case 'brightness':
    case 'contrast':
    case 'saturation':
    case 'temperature':
    case 'tint':
    case 'shadows':
    case 'highlights':
      return op.amount === 0;
    case 'whiteBalance':
      return op.r === op.g && op.g === op.b;
    case 'curve':
      return isIdentityCurve(op.points) && isIdentityCurve(op.red) && isIdentityCurve(op.green) && isIdentityCurve(op.blue);
    case 'exposure':
      return op.ev === 0;
    case 'gamma':
      return op.gamma === 1;
    case 'levels':
      return op.inBlack === 0 && op.inWhite === 1 && op.gamma === 1 && op.outBlack === 0 && op.outWhite === 1;
    case 'stretch':
      return op.black.every((b, c) => b === 0 && op.white[c] === 1);
    case 'autoStretch':
      return false;
    case 'sharpen':
      return op.amount === 0;
  }
}

/** Builds the math for a normalized op. */
export function toStage(op: OpSpec): Stage {
  switch (op.op) {
    case 'brightness': {
      // Positive: move toward white by `amount`. Negative: scale toward black.
      // Written so no input (even Infinity) produces NaN; the extremes are constants.
      const b = op.amount;
      if (b === 1) return { kind: 'channel', fn: () => 1 };
      if (b === -1) return { kind: 'channel', fn: () => 0 };
      const s = 1 - Math.abs(b);
      const offset = b > 0 ? b : 0;
      return { kind: 'channel', fn: (v) => v * s + offset };
    }
    case 'contrast': {
      // Power curve around mid-gray: k > 1 steepens, k < 1 flattens, -1 gives flat gray.
      const c = op.amount;
      const k = c >= 0 ? 1 / Math.max(1 - c, 1 / 1024) : 1 + c;
      const p = CONTRAST_PIVOT;
      return { kind: 'channel', fn: (v) => (v > 0 ? p * Math.pow(v / p, k) : 0) };
    }
    case 'exposure': {
      const m = Math.pow(2, op.ev);
      return { kind: 'channel', fn: (v) => v * m };
    }
    case 'gamma': {
      const e = 1 / op.gamma;
      return { kind: 'channel', fn: (v) => (v > 0 ? Math.pow(v, e) : 0) };
    }
    case 'saturation':
      return { kind: 'saturation', factor: 1 + op.amount };
    case 'temperature':
    case 'tint':
    case 'whiteBalance': {
      // White-balance style gains, normalized so white keeps its luminance.
      const gains = op.op === 'temperature' ? temperatureGains(op.amount) : op.op === 'tint' ? tintGains(op.amount) : whiteBalanceGains(op);
      return { kind: 'channel', fn: (v, c) => v * gains[c] };
    }
    case 'shadows':
    case 'highlights': {
      // On sRGB-encoded values, like levels; values outside 0..1 are left alone.
      const amount = op.amount;
      const high = op.op === 'highlights';
      return {
        kind: 'channel',
        fn: (v) => {
          if (!(v > 0) || v >= 1) return v;
          return srgbToLinear(toneShift(linearToSrgb(v), amount, high));
        },
      };
    }
    case 'curve': {
      // On sRGB-encoded values: the curve for all channels, then the channel's own.
      const all = curveFunction(op.points);
      const own = [op.red, op.green, op.blue].map(curveFunction);
      const falls = [op.points, op.red, op.green, op.blue].some((points) => points.some((p, i) => i > 0 && p[1] < points[i - 1][1]));
      return { kind: 'channel', fn: (v, c) => srgbToLinear(own[c](all(linearToSrgb(v)))), falls };
    }
    case 'levels': {
      // Levels act on sRGB-encoded values, as on a histogram, but without 8-bit rounding.
      const { inBlack, inWhite, outBlack, outWhite } = op;
      const inRange = inWhite - inBlack;
      const outRange = outWhite - outBlack;
      const e = 1 / op.gamma;
      return {
        kind: 'channel',
        falls: outRange < 0,
        fn: (v) => {
          let x = (linearToSrgb(v) - inBlack) / inRange;
          x = x <= 0 ? 0 : x >= 1 ? 1 : Math.pow(x, e);
          return srgbToLinear(outBlack + x * outRange);
        },
      };
    }
    case 'stretch': {
      // Like levels, on sRGB-encoded values; values outside the range are clipped.
      const black = op.black;
      const scale = op.black.map((b, c) => 1 / (op.white[c] - b));
      return {
        kind: 'channel',
        fn: (v, c) => {
          const x = (linearToSrgb(v) - black[c]) * scale[c];
          return x <= 0 ? 0 : x >= 1 ? 1 : srgbToLinear(x);
        },
      };
    }
    case 'sharpen':
      return { kind: 'sharpen', amount: op.amount, radius: op.radius, threshold: op.threshold };
    case 'autoStretch':
      throw new Error('autoStretch has no fixed math; resolve it with image statistics first.');
  }
}
