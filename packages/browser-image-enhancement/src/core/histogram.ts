/**
 * Image statistics and automatic stretching (dynamic range adjustment).
 *
 * Statistics are 256-bin histograms of 8-bit sRGB codes, so they can be taken
 * per tile or strip and added up. `autoStretch` steps are turned into plain
 * `stretch` steps from a histogram before an image is processed; every pixel of
 * every tile then gets the same range.
 */
import { LUMA_B, LUMA_G, LUMA_R, linearToSrgb, quantize, SRGB_TO_LINEAR } from '../color/srgb.js';
import { COLOR_ONLY_OPS, isIdentity, normalizeAutoStretch, toStage, type ChannelFn } from '../ops/index.js';
import type { AutoStretchOptions, Histogram, OpSpec, Rect, RGBValues } from '../types.js';
import { warn } from '../warn.js';
import { forGray, type ResolvedMode } from './process.js';

/** A histogram with nothing counted. */
export function emptyHistogram(mode: ResolvedMode): Histogram {
  const channels = mode === 'rgb' ? 3 : 1;
  return { mode, bins: Array.from({ length: channels }, () => new Float64Array(256)), count: 0 };
}

/** The pixel rectangle `rect` clipped to the image; null when nothing is left. */
function clipRect(rect: Rect | undefined, width: number, height: number): [number, number, number, number] | null {
  if (!rect) return [0, 0, width, height];
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
  if (!(x1 > x0 && y1 > y0)) return null;
  return [x0, y0, x1, y1];
}

/**
 * Counts the pixels of RGBA `data` (`width` pixels per row), optionally only
 * inside `rect`. Pixels with alpha 0 are skipped. In gray mode colored pixels
 * count by their luminance, exactly as gray mode processes them.
 */
export function countPixels(data: Uint8ClampedArray, width: number, mode: ResolvedMode, rect?: Rect): Histogram {
  const h = emptyHistogram(mode);
  const height = width > 0 ? data.length / 4 / width : 0;
  const area = clipRect(rect, width, height);
  if (!area) return h;
  const [x0, y0, x1, y1] = area;
  let count = 0;
  if (mode === 'rgb') {
    const [hr, hg, hb] = h.bins;
    for (let y = y0; y < y1; y++) {
      const end = (y * width + x1) * 4;
      for (let i = (y * width + x0) * 4; i < end; i += 4) {
        if (data[i + 3] === 0) continue;
        hr[data[i]]++;
        hg[data[i + 1]]++;
        hb[data[i + 2]]++;
        count++;
      }
    }
  } else {
    const hy = h.bins[0];
    for (let y = y0; y < y1; y++) {
      const end = (y * width + x1) * 4;
      for (let i = (y * width + x0) * 4; i < end; i += 4) {
        if (data[i + 3] === 0) continue;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        hy[r === g && g === b ? r : quantize(LUMA_R * SRGB_TO_LINEAR[r] + LUMA_G * SRGB_TO_LINEAR[g] + LUMA_B * SRGB_TO_LINEAR[b])]++;
        count++;
      }
    }
  }
  h.count = count;
  return h;
}

/** A gray histogram as three identical channels, so it can be added to color ones. */
function asRgb(h: Histogram): Histogram {
  return h.mode === 'rgb' ? h : { mode: 'rgb', bins: [h.bins[0], h.bins[0], h.bins[0]], count: h.count };
}

/**
 * Adds histograms (of tiles, strips, ...) into one. Mixing gray and color
 * histograms gives a color one, with gray counted on every channel.
 */
export function mergeHistograms(histograms: readonly Histogram[]): Histogram {
  const mode: ResolvedMode = histograms.length > 0 && histograms.every((h) => h.mode === 'gray') ? 'gray' : 'rgb';
  const out = emptyHistogram(mode);
  for (const h of histograms) {
    const src = mode === 'rgb' ? asRgb(h) : h;
    for (let c = 0; c < out.bins.length; c++) {
      const o = out.bins[c];
      const s = src.bins[c];
      for (let k = 0; k < 256; k++) o[k] += s[k];
    }
    out.count += h.count;
  }
  return out;
}

/** The histogram as gray mode uses it. Only meaningful for monochrome pixels (R = G = B). */
export function grayFromRgb(h: Histogram): Histogram {
  return h.mode === 'gray' ? h : { mode: 'gray', bins: [h.bins[0]], count: h.count };
}

/** A (value, count) list sorted by value. */
type Distribution = Array<{ value: number; count: number }>;

function distribution(bins: readonly Float64Array[], values: ReadonlyArray<(k: number) => number>): Distribution {
  const d: Distribution = [];
  bins.forEach((b, c) => {
    for (let k = 0; k < 256; k++) if (b[k] > 0) d.push({ value: values[c](k), count: b[k] });
  });
  return d.sort((a, b) => a.value - b.value);
}

/** [black, white] for one distribution, or null when nothing can be stretched. */
function rangeOf(d: Distribution, o: Required<AutoStretchOptions>): [number, number] | null {
  let total = 0;
  for (const e of d) total += e.count;
  if (total === 0) return null;
  const min = d[0].value;
  const max = d[d.length - 1].value;
  let black: number;
  let white: number;
  if (o.method === 'standardDeviation') {
    let sum = 0;
    for (const e of d) sum += e.value * e.count;
    const mean = sum / total;
    let sq = 0;
    for (const e of d) sq += (e.value - mean) ** 2 * e.count;
    const sd = Math.sqrt(sq / total);
    black = Math.max(min, mean - o.stdDevs * sd);
    white = Math.min(max, mean + o.stdDevs * sd);
  } else {
    // Clip `low` of the pixels below black and `high` above white; minMax clips none.
    const low = o.method === 'minMax' ? 0 : (total * o.lowPercent) / 100;
    const high = o.method === 'minMax' ? 0 : (total * o.highPercent) / 100;
    let i = 0;
    for (let cum = d[0].count; cum <= low && i < d.length - 1; ) cum += d[++i].count;
    black = d[i].value;
    let j = d.length - 1;
    for (let cum = d[j].count; cum <= high && j > 0; ) cum += d[--j].count;
    white = d[j].value;
  }
  return white > black ? [black, white] : null;
}

const codeValue = (k: number) => k / 255;

/**
 * Black and white points (sRGB-encoded, per channel) for a histogram.
 * `values[c](k)` is the value pixels of code `k` on channel `c` have when they
 * reach the stretch; by default the code itself (k / 255).
 * Channels with nothing to stretch get black 0, white 1 (unchanged).
 */
export function stretchRange(
  h: Histogram,
  options: AutoStretchOptions = {},
  values?: ReadonlyArray<(k: number) => number>,
): { black: RGBValues; white: RGBValues } {
  const o = normalizeAutoStretch(options);
  const fns = values ?? h.bins.map(() => codeValue);
  const black: RGBValues = [0, 0, 0];
  const white: RGBValues = [1, 1, 1];
  if (o.linked || h.mode === 'gray') {
    const r = rangeOf(distribution(h.bins, fns), o);
    if (r) for (let c = 0; c < 3; c++) [black[c], white[c]] = r;
  } else {
    for (let c = 0; c < 3; c++) {
      const r = rangeOf(distribution([h.bins[c]], [fns[c]]), o);
      if (r) [black[c], white[c]] = r;
    }
  }
  return { black, white };
}

/** True when the steps contain an `autoStretch` that needs image statistics. */
export function needsStats(ops: readonly OpSpec[]): boolean {
  return ops.some((op) => op.op === 'autoStretch');
}

/**
 * Replaces every `autoStretch` with a `stretch` computed from `stats`, the
 * histogram of the image the steps will run on. Each one uses the distribution
 * of values as they reach it: steps before it are applied to the histogram's
 * values (exact, since every per-channel step keeps values in order).
 * Saturation mixes channels and cannot be followed this way; it is ignored,
 * with a warning. With `stats` null, `autoStretch` steps are dropped.
 */
export function resolveOps(ops: readonly OpSpec[], stats: Histogram | null): OpSpec[] {
  const out: OpSpec[] = [];
  for (const op of ops) {
    if (op.op !== 'autoStretch') {
      out.push(op);
      continue;
    }
    if (!stats) continue;
    const before = out.filter((p) => !isIdentity(p) && !(stats.mode === 'gray' && COLOR_ONLY_OPS.has(p.op)));
    if (before.some((p) => p.op === 'saturation')) {
      warn('autoStretch after saturation uses statistics without the saturation change. Put autoStretch first to avoid this.');
    }
    const fns = before.flatMap((p) => {
      const s = toStage(stats.mode === 'gray' ? forGray(p) : p);
      return s.kind === 'channel' ? [s.fn] : [];
    });
    const values = stats.bins.map((_, c) => valueAfter(fns, c));
    out.push({ op: 'stretch', ...stretchRange(stats, op, fns.length > 0 ? values : undefined) });
  }
  return out;
}

function valueAfter(fns: readonly ChannelFn[], c: number): (k: number) => number {
  return (k) => {
    let v = SRGB_TO_LINEAR[k];
    for (const fn of fns) v = fn(v, c);
    return linearToSrgb(v);
  };
}

/** Resolves `autoStretch` steps from the pixels themselves (the whole buffer). */
export function resolveForPixels(ops: readonly OpSpec[], data: Uint8ClampedArray, mode: ResolvedMode): OpSpec[] {
  if (!needsStats(ops)) return [...ops];
  return resolveOps(ops, countPixels(data, Math.max(1, data.length >> 2), mode));
}
