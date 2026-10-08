/**
 * The pixel engine. DOM-free and synchronous, so the same code runs on the main
 * thread and inside Web Workers.
 *
 * Every chain of corrections runs in one pass: pixels are decoded to linear light,
 * all steps run in float64, and the result is rounded to 8 bits once.
 * Per-channel steps at the start of the chain are folded into 256-entry tables
 * (the input only has 256 possible values per channel); if the whole chain is
 * per-channel, the pass reduces to an 8-bit table lookup.
 *
 * A chain with `sharpen` (which reads neighbouring pixels) keeps the image in
 * float planes of sRGB-encoded values at each sharpen; the steps around it
 * still run per pixel, and the result is still rounded only once.
 */
import { LUMA_B, LUMA_G, LUMA_R, linearToSrgb, quantize, SRGB_TO_LINEAR, srgbToLinear } from '../color/srgb.js';
import { COLOR_ONLY_OPS, isIdentity, toStage, type PixelStage, type SpatialStage } from '../ops/index.js';
import { sharpenPlanes, sharpenRows } from './filter.js';
import { Quantizer } from './quantizer.js';
import { runWasm } from './wasm.js';
import type { ColorMode, OpSpec } from '../types.js';

/** How pixels are computed: three channels, or one luminance channel. */
export type ResolvedMode = 'rgb' | 'gray';

type ChannelStage = Extract<PixelStage, { kind: 'channel' }>;

export interface Program {
  readonly mode: ResolvedMode;
  /** Linear value of each 8-bit input code after the leading per-channel steps (one per channel; gray uses [0]). */
  readonly lutLinear: readonly Float64Array[];
  /** Steps between the leading and trailing per-channel runs; each pixel goes through them in turn. */
  readonly middle: readonly PixelStage[];
  /** Trailing per-channel steps folded into rounding, one per channel. */
  readonly tail: readonly Quantizer[];
  /** Direct 8-bit -> 8-bit tables when there are no middle steps. */
  readonly lut8: readonly Uint8Array[] | null;
  /** Gray mode only: every step folded into rounding, for colored pixels' luminance. */
  readonly grayFromColor: Quantizer | null;
  /** Gray mode: steps colored pixels run before `grayFromColor` (empty when they are folded into it). */
  readonly grayColorSteps: readonly PixelStage[];
  /**
   * Set when the chain has steps that read neighbouring pixels. The fields
   * above then describe only the steps before the first of them (`tail` and
   * `lut8` are unused).
   */
  readonly spatial: SpatialProgram | null;
}

/** The part of a program from the first spatial step on. */
export interface SpatialProgram {
  /** Leading per-channel steps, for colored pixels in gray mode (their luminance has no table entry). */
  readonly lead: (v: number) => number;
  /** `lutLinear` already sRGB-encoded, when there are no middle steps before the first spatial step. */
  readonly lutEncoded: readonly Float64Array[] | null;
  /** Each spatial step, followed by the per-pixel steps up to the next one (empty for the last). */
  readonly filters: ReadonlyArray<{ stage: SpatialStage; after: readonly PixelStage[] }>;
  /** Per-pixel steps after the last spatial step, before the trailing per-channel run. */
  readonly middle: readonly PixelStage[];
  /** Rounding with the trailing per-channel run folded in; takes encoded values when `middle` is empty and folding is on, else linear ones. */
  readonly tail: readonly Quantizer[];
  /** True when `tail` takes sRGB-encoded values. */
  readonly tailTakesEncoded: boolean;
  /**
   * True to stream rows through the one spatial step instead of holding the
   * image in float planes (same result, much less memory traffic). Off
   * without folding, so tests can compare the two.
   */
  readonly stream: boolean;
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

/** In gray mode there is one channel; a per-channel stretch uses the mean of its points and a curve only its curve for all channels. */
export function forGray(op: OpSpec): OpSpec {
  // One channel: only the curve for all channels applies.
  if (op.op === 'curve') return { ...op, red: [[0, 0], [1, 1]], green: [[0, 0], [1, 1]], blue: [[0, 0], [1, 1]] };
  if (op.op !== 'stretch') return op;
  const mean = (v: readonly number[]) => (v[0] + v[1] + v[2]) / 3;
  const b = mean(op.black);
  const w = mean(op.white);
  return { op: 'stretch', black: [b, b, b], white: [w, w, w] };
}

/** Whether a step can fold into a Quantizer (per channel and non-decreasing). */
function foldable(stage: PixelStage): boolean {
  return stage.kind === 'channel' && !stage.falls;
}

/** Splits per-pixel steps into the middle and the trailing per-channel run (all middle without folding). */
function splitTail(stages: readonly PixelStage[], fuse: boolean): [PixelStage[], ChannelStage[]] {
  let start = stages.length;
  if (fuse) while (start > 0 && foldable(stages[start - 1])) start--;
  return [stages.slice(0, start), stages.slice(start) as ChannelStage[]];
}

/**
 * Compiles normalized ops for one color mode. In gray mode color-only ops
 * (saturation, temperature) are dropped. `autoStretch` steps must already be
 * resolved (see core/histogram.ts).
 */
export function compile(ops: readonly OpSpec[], mode: ResolvedMode, options: CompileOptions = {}): Program {
  const fuse = options.fuse ?? true;
  const stages = ops
    .filter((op) => !isIdentity(op) && !(mode === 'gray' && COLOR_ONLY_OPS.has(op.op)))
    .map((op) => toStage(mode === 'gray' ? forGray(op) : op));
  const cut = stages.findIndex((s) => s.kind === 'sharpen');
  const all = (cut < 0 ? stages : stages.slice(0, cut)) as PixelStage[];

  let lead = 0;
  let tailStart = all.length;
  if (fuse) {
    while (lead < all.length && all[lead].kind === 'channel') lead++;
    while (tailStart > lead && foldable(all[tailStart - 1])) tailStart--;
  }
  if (cut >= 0) tailStart = all.length; // the trailing run is not the end of the chain
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

  if (cut >= 0) {
    return {
      mode,
      lutLinear,
      middle,
      tail: [],
      lut8: null,
      grayFromColor: null,
      grayColorSteps: [],
      spatial: compileSpatial(stages.slice(cut), lutLinear, leading, middle.length === 0 && fuse, fuse),
    };
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
  let grayColorSteps: readonly PixelStage[] = [];
  if (mode === 'gray') {
    const fold = fuse && all.every(foldable);
    grayFromColor = fold ? new Quantizer(chain(all as ChannelStage[], 0)) : new Quantizer();
    grayColorSteps = fold ? [] : all;
  }
  return { mode, lutLinear, middle, tail, lut8, grayFromColor, grayColorSteps, spatial: null };
}

/** `rest` starts with a spatial step. */
function compileSpatial(
  rest: readonly ReturnType<typeof toStage>[],
  lutLinear: readonly Float64Array[],
  leading: readonly ChannelStage[],
  encodeTable: boolean,
  fuse: boolean,
): SpatialProgram {
  const filters: Array<{ stage: SpatialStage; after: PixelStage[] }> = [];
  for (const s of rest) {
    if (s.kind === 'sharpen') filters.push({ stage: s, after: [] });
    else filters[filters.length - 1].after.push(s);
  }
  const last = filters[filters.length - 1];
  const [middle, trailing] = splitTail(last.after, fuse);
  last.after = [];
  // With nothing to run per pixel after the last spatial step, decoding folds into the rounding too.
  const tailTakesEncoded = fuse && middle.length === 0;
  const tail = lutLinear.map((_, c) => {
    const f = chain(trailing, c);
    if (tailTakesEncoded) return new Quantizer((e) => f(srgbToLinear(e)));
    return trailing.length > 0 ? new Quantizer(f) : new Quantizer();
  });
  const lutEncoded = encodeTable
    ? lutLinear.map((t) => {
        const e = new Float64Array(256);
        for (let i = 0; i < 256; i++) e[i] = linearToSrgb(t[i]);
        return e;
      })
    : null;
  const stream = fuse && filters.length === 1;
  return { lead: chain(leading, 0), lutEncoded, filters, middle, tail, tailTakesEncoded, stream };
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

function applyChannel(stages: readonly PixelStage[], v: number): number {
  for (let k = 0; k < stages.length; k++) v = (stages[k] as ChannelStage).fn(v, 0);
  return v;
}

/**
 * Applies a program to RGBA pixels. `src` and `dst` must have the same length
 * and may be the same array. Alpha is copied unchanged. `width` (pixels per
 * row) is needed when the program has spatial steps. Runs in WebAssembly
 * when it can (core/wasm.ts), with the same result.
 */
export function processPixels(src: Uint8ClampedArray, dst: Uint8ClampedArray, program: Program, width?: number): void {
  if (src.length !== dst.length) throw new RangeError('src and dst must have the same length');
  if (program.spatial) {
    const pixels = src.length >>> 2;
    if (width === undefined || !(width > 0) || pixels % width !== 0) {
      throw new RangeError(`A program with sharpen needs the image width (got ${String(width)} for ${pixels} pixels).`);
    }
    if (!runWasm(src, dst, program, width)) processSpatial(src, dst, program, program.spatial, width);
  } else if (runWasm(src, dst, program)) return;
  else if (program.mode === 'gray') processGray(src, dst, program);
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

/** Runs per-pixel steps on linear R, G, B in place in `v`. */
function runStages(stages: readonly PixelStage[], v: Float64Array): void {
  for (let k = 0; k < stages.length; k++) {
    const s = stages[k];
    if (s.kind === 'channel') {
      v[0] = s.fn(v[0], 0);
      v[1] = s.fn(v[1], 1);
      v[2] = s.fn(v[2], 2);
    } else {
      const y = LUMA_R * v[0] + LUMA_G * v[1] + LUMA_B * v[2];
      const f = s.factor;
      v[0] = y + (v[0] - y) * f;
      v[1] = y + (v[1] - y) * f;
      v[2] = y + (v[2] - y) * f;
    }
  }
}

function processSpatial(src: Uint8ClampedArray, dst: Uint8ClampedArray, p: Program, sp: SpatialProgram, width: number): void {
  const n = src.length >>> 2;
  const channels = p.mode === 'rgb' ? 3 : 1;
  if (sp.stream) {
    // One spatial step: stream rows through it, never holding the whole image in float.
    sharpenRows(src, width, channels, sp.filters[0].stage, (y, out, o) => head(src, p, sp, y * width, (y + 1) * width, out, o), (y, vals, o) =>
      finish(src, dst, sp, y * width, (y + 1) * width, vals, o),
    );
    return;
  }
  const planes = Array.from({ length: channels }, () => new Float32Array(n));
  head(src, p, sp, 0, n, planes, 0);
  const v = new Float64Array(3);
  const [p0, p1, p2] = planes;
  for (const { stage, after } of sp.filters) {
    sharpenPlanes(planes, src, width, stage);
    if (after.length === 0) continue;
    for (let j = 0; j < n; j++) {
      if (channels === 3) {
        v[0] = srgbToLinear(p0[j]);
        v[1] = srgbToLinear(p1[j]);
        v[2] = srgbToLinear(p2[j]);
        runStages(after, v);
        p0[j] = linearToSrgb(v[0]);
        p1[j] = linearToSrgb(v[1]);
        p2[j] = linearToSrgb(v[2]);
      } else {
        p0[j] = linearToSrgb(applyChannel(after, srgbToLinear(p0[j])));
      }
    }
  }
  finish(src, dst, sp, 0, n, planes, 0);
}

/**
 * Steps before the first spatial step for pixels j0..j1: input codes ->
 * encoded values, written to `out[c]` from index `o`.
 */
function head(src: Uint8ClampedArray, p: Program, sp: SpatialProgram, j0: number, j1: number, out: readonly Float32Array[], o: number): void {
  const [p0, p1, p2] = out;
  const enc = sp.lutEncoded;
  const lin = p.lutLinear;
  if (p.mode === 'rgb' && enc) {
    const [e0, e1, e2] = enc;
    for (let j = j0, i = j0 * 4, k = o; j < j1; j++, i += 4, k++) {
      p0[k] = e0[src[i]];
      p1[k] = e1[src[i + 1]];
      p2[k] = e2[src[i + 2]];
    }
  } else if (p.mode === 'rgb') {
    const [l0, l1, l2] = lin;
    const v = new Float64Array(3);
    for (let j = j0, i = j0 * 4, k = o; j < j1; j++, i += 4, k++) {
      v[0] = l0[src[i]];
      v[1] = l1[src[i + 1]];
      v[2] = l2[src[i + 2]];
      runStages(p.middle, v);
      p0[k] = linearToSrgb(v[0]);
      p1[k] = linearToSrgb(v[1]);
      p2[k] = linearToSrgb(v[2]);
    }
  } else {
    const e0 = enc ? enc[0] : null;
    const l0 = lin[0];
    for (let j = j0, i = j0 * 4, k = o; j < j1; j++, i += 4, k++) {
      const r = src[i];
      const g = src[i + 1];
      const b = src[i + 2];
      if (r === g && g === b) {
        p0[k] = e0 ? e0[r] : linearToSrgb(applyChannel(p.middle, l0[r]));
      } else {
        // Color pixel in forced gray mode: compute on its luminance.
        const y = LUMA_R * SRGB_TO_LINEAR[r] + LUMA_G * SRGB_TO_LINEAR[g] + LUMA_B * SRGB_TO_LINEAR[b];
        p0[k] = linearToSrgb(applyChannel(p.middle, sp.lead(y)));
      }
    }
  }
}

/** Steps after the last spatial step for pixels j0..j1 (values in `vals[c]` from index `o`), then rounding to 8 bits. */
function finish(src: Uint8ClampedArray, dst: Uint8ClampedArray, sp: SpatialProgram, j0: number, j1: number, vals: readonly Float32Array[], o: number): void {
  const { middle, tail, tailTakesEncoded } = sp;
  const [p0, p1, p2] = vals;
  if (vals.length === 3) {
    const [t0, t1, t2] = tail;
    const v = new Float64Array(3);
    for (let i = j0 * 4, k = o, end = j1 * 4; i < end; i += 4, k++) {
      if (tailTakesEncoded) {
        dst[i] = t0.quantize(p0[k]);
        dst[i + 1] = t1.quantize(p1[k]);
        dst[i + 2] = t2.quantize(p2[k]);
      } else {
        v[0] = srgbToLinear(p0[k]);
        v[1] = srgbToLinear(p1[k]);
        v[2] = srgbToLinear(p2[k]);
        runStages(middle, v);
        dst[i] = t0.quantize(v[0]);
        dst[i + 1] = t1.quantize(v[1]);
        dst[i + 2] = t2.quantize(v[2]);
      }
      dst[i + 3] = src[i + 3];
    }
  } else {
    const t0 = tail[0];
    for (let i = j0 * 4, k = o, end = j1 * 4; i < end; i += 4, k++) {
      const out = tailTakesEncoded ? t0.quantize(p0[k]) : t0.quantize(applyChannel(middle, srgbToLinear(p0[k])));
      dst[i] = out;
      dst[i + 1] = out;
      dst[i + 2] = out;
      dst[i + 3] = src[i + 3];
    }
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
  const colorSteps = p.grayColorSteps;
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
  const out = new Uint8ClampedArray(data.length >>> 2);
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
