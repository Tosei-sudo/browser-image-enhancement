/**
 * The pixel engine. DOM-free and synchronous, so the same code runs on the main
 * thread and inside Web Workers.
 *
 * Every chain of corrections runs in one pass: pixels are decoded to linear light,
 * all steps run in float64, and the result is rounded to 8 bits once.
 * Per-channel steps at the start of the chain are folded into 256-entry tables
 * (the input only has 256 possible values per channel); if the whole chain is
 * per-channel, the pass reduces to an 8-bit table lookup.
 */
import { LUMA_B, LUMA_G, LUMA_R, quantize, SRGB_TO_LINEAR } from '../color/srgb.js';
import { COLOR_ONLY_OPS, isIdentity, toStage, type Stage } from '../ops/index.js';
import { Quantizer } from './quantizer.js';
import type { ColorMode, OpSpec } from '../types.js';

/** How pixels are computed: three channels, or one luminance channel. */
export type ResolvedMode = 'rgb' | 'gray';

type ChannelStage = Extract<Stage, { kind: 'channel' }>;

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

function chain(stages: readonly ChannelStage[], c: number): (v: number) => number {
  return (v) => {
    for (const s of stages) v = s.fn(v, c);
    return v;
  };
}

/**
 * Compiles normalized ops for one color mode. In gray mode color-only ops
 * (saturation, temperature) are dropped.
 */
export function compile(ops: readonly OpSpec[], mode: ResolvedMode, options: CompileOptions = {}): Program {
  const fuse = options.fuse ?? true;
  const all = ops
    .filter((op) => !isIdentity(op) && !(mode === 'gray' && COLOR_ONLY_OPS.has(op.op)))
    .map(toStage);

  let lead = 0;
  let tailStart = all.length;
  if (fuse) {
    while (lead < all.length && all[lead].kind === 'channel') lead++;
    while (tailStart > lead && all[tailStart - 1].kind === 'channel') tailStart--;
  }
  const leading = all.slice(0, lead) as ChannelStage[];
  const middle = all.slice(lead, tailStart);
  const trailing = all.slice(tailStart) as ChannelStage[];

  const channels = mode === 'rgb' ? 3 : 1;
  const lutLinear: Float64Array[] = [];
  const tail: Quantizer[] = [];
  for (let c = 0; c < channels; c++) {
    const t = new Float64Array(256);
    const f = chain(leading, c);
    for (let i = 0; i < 256; i++) t[i] = f(SRGB_TO_LINEAR[i]);
    lutLinear.push(t);
    tail.push(trailing.length > 0 ? new Quantizer(chain(trailing, c)) : new Quantizer());
  }

  let lut8: Uint8Array[] | null = null;
  if (middle.length === 0 && fuse) {
    lut8 = lutLinear.map((t) => {
      const q = new Uint8Array(256);
      for (let i = 0; i < 256; i++) q[i] = quantize(t[i]);
      return q;
    });
  }

  let grayFromColor: Quantizer | null = null;
  if (mode === 'gray') {
    grayFromColor = fuse ? new Quantizer(chain(all as ChannelStage[], 0)) : new Quantizer();
  }
  return { mode, lutLinear, middle, tail, lut8, grayFromColor };
}

/** True when every pixel has R = G = B. Stops at the first colored pixel. */
export function isMonochrome(data: Uint8ClampedArray): boolean {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    if (data[i + 1] !== r || data[i + 2] !== r) return false;
  }
  return true;
}

/** Turns a requested color mode into the mode pixels are computed in. */
export function resolveMode(data: Uint8ClampedArray, colorMode: ColorMode = 'auto'): ResolvedMode {
  if (colorMode === 'auto') return isMonochrome(data) ? 'gray' : 'rgb';
  return colorMode;
}

function applyChannel(stages: readonly Stage[], v: number): number {
  for (let k = 0; k < stages.length; k++) v = (stages[k] as ChannelStage).fn(v, 0);
  return v;
}

/**
 * Applies a program to RGBA pixels. `src` and `dst` must have the same length
 * and may be the same array. Alpha is copied unchanged.
 */
export function processPixels(src: Uint8ClampedArray, dst: Uint8ClampedArray, program: Program): void {
  if (src.length !== dst.length) throw new RangeError('src and dst must have the same length');
  if (program.mode === 'gray') processGray(src, dst, program);
  else processRgb(src, dst, program);
}

function processRgb(src: Uint8ClampedArray, dst: Uint8ClampedArray, p: Program): void {
  const n = src.length;
  if (p.lut8) {
    const [qr, qg, qb] = p.lut8;
    for (let i = 0; i < n; i += 4) {
      dst[i] = qr[src[i]];
      dst[i + 1] = qg[src[i + 1]];
      dst[i + 2] = qb[src[i + 2]];
      dst[i + 3] = src[i + 3];
    }
    return;
  }
  const [lr, lg, lb] = p.lutLinear;
  const [tr, tg, tb] = p.tail;
  const middle = p.middle;
  const steps = middle.length;
  for (let i = 0; i < n; i += 4) {
    let r = lr[src[i]];
    let g = lg[src[i + 1]];
    let b = lb[src[i + 2]];
    for (let k = 0; k < steps; k++) {
      const s = middle[k];
      if (s.kind === 'channel') {
        const fn = s.fn;
        r = fn(r, 0);
        g = fn(g, 1);
        b = fn(b, 2);
      } else {
        const y = LUMA_R * r + LUMA_G * g + LUMA_B * b;
        const f = s.factor;
        r = y + (r - y) * f;
        g = y + (g - y) * f;
        b = y + (b - y) * f;
      }
    }
    dst[i] = tr.quantize(r);
    dst[i + 1] = tg.quantize(g);
    dst[i + 2] = tb.quantize(b);
    dst[i + 3] = src[i + 3];
  }
}

function processGray(src: Uint8ClampedArray, dst: Uint8ClampedArray, p: Program): void {
  const n = src.length;
  const q = p.lut8 ? p.lut8[0] : null;
  const lin = p.lutLinear[0];
  const tail = p.tail[0];
  const middle = p.middle;
  const fromColor = p.grayFromColor as Quantizer;
  // Without folding, colored pixels run every step; with folding they are all inside `fromColor`.
  const colorSteps = q ? [] : middle;
  for (let i = 0; i < n; i += 4) {
    const r = src[i];
    const g = src[i + 1];
    const b = src[i + 2];
    let out: number;
    if (r === g && g === b) {
      out = q ? q[r] : tail.quantize(applyChannel(middle, lin[r]));
    } else {
      // Color pixel in forced gray mode: compute on its luminance.
      const y = LUMA_R * SRGB_TO_LINEAR[r] + LUMA_G * SRGB_TO_LINEAR[g] + LUMA_B * SRGB_TO_LINEAR[b];
      out = fromColor.quantize(applyChannel(colorSteps, y));
    }
    dst[i] = out;
    dst[i + 1] = out;
    dst[i + 2] = out;
    dst[i + 3] = src[i + 3];
  }
}

/**
 * Luminance of RGBA pixels as one 8-bit channel. Gray pixels (R = G = B) keep
 * their value; colored pixels use Rec. 709 luminance computed in linear light.
 */
export function extractGray(data: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length >> 2);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    out[j] =
      r === g && g === b
        ? r
        : quantize(LUMA_R * SRGB_TO_LINEAR[r] + LUMA_G * SRGB_TO_LINEAR[g] + LUMA_B * SRGB_TO_LINEAR[b]);
  }
  return out;
}
