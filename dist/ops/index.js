/**
 * Correction definitions: parameter normalization and the per-pixel math.
 *
 * All math runs on linear-light values (see color/srgb.ts). Values may leave
 * [0, 1] between steps; they are clamped only when quantized to 8 bits at the end.
 */
import { linearToSrgb, srgbToLinear, LUMA_B, LUMA_G, LUMA_R } from '../color/srgb.js';
import { warn } from '../warn.js';
/** Corrections that only make sense for color images; no-ops on monochrome input. */
export const COLOR_ONLY_OPS = new Set(['saturation', 'temperature']);
/** Contrast pivots around sRGB 50 % gray so mid-gray stays put. */
const CONTRAST_PIVOT = srgbToLinear(0.5);
/** Strength of `temperature`: at +1 red gain is 1.4x and blue 0.6x before luminance normalization. */
const TEMPERATURE_STRENGTH = 0.4;
function num(name, value, min, max, fallback) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        if (value !== undefined)
            warn(`${name} must be a number, got ${String(value)}; using ${fallback}.`);
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
export function normalizeLevels(o = {}) {
    let inBlack = num('levels.inBlack', o.inBlack, 0, 1, 0);
    let inWhite = num('levels.inWhite', o.inWhite, 0, 1, 1);
    if (inWhite <= inBlack) {
        // Keep a one-code gap so the input range is never empty.
        const gap = 1 / 255;
        const before = `inBlack ${inBlack}, inWhite ${inWhite}`;
        if (inBlack + gap <= 1)
            inWhite = inBlack + gap;
        else
            [inBlack, inWhite] = [1 - gap, 1];
        warn(`levels.inWhite must be greater than inBlack (${before}); using inBlack ${inBlack}, inWhite ${inWhite}.`);
    }
    return {
        inBlack,
        inWhite,
        gamma: num('levels.gamma', o.gamma, 0.1, 10, 1),
        outBlack: num('levels.outBlack', o.outBlack, 0, 1, 0),
        outWhite: num('levels.outWhite', o.outWhite, 0, 1, 1),
    };
}
/**
 * Validates an op (from code or from JSON) and clamps its parameters.
 * Throws only for an unknown op name, since that cannot be repaired.
 */
export function normalizeOp(raw) {
    const o = (raw ?? {});
    switch (o.op) {
        case 'brightness':
        case 'contrast':
        case 'saturation':
        case 'temperature':
            return { op: o.op, amount: num(`${o.op}`, o.amount, -1, 1, 0) };
        case 'exposure':
            return { op: 'exposure', ev: num('exposure', o.ev, -10, 10, 0) };
        case 'gamma':
            return { op: 'gamma', gamma: num('gamma', o.gamma, 0.1, 10, 1) };
        case 'levels':
            return { op: 'levels', ...normalizeLevels(o) };
        default:
            throw new TypeError(`Unknown correction: ${String(o.op)}`);
    }
}
/** True when the op leaves every pixel unchanged, so it can be skipped. */
export function isIdentity(op) {
    switch (op.op) {
        case 'brightness':
        case 'contrast':
        case 'saturation':
        case 'temperature':
            return op.amount === 0;
        case 'exposure':
            return op.ev === 0;
        case 'gamma':
            return op.gamma === 1;
        case 'levels':
            return op.inBlack === 0 && op.inWhite === 1 && op.gamma === 1 && op.outBlack === 0 && op.outWhite === 1;
    }
}
/** Builds the per-pixel math for a normalized op. */
export function toStage(op) {
    switch (op.op) {
        case 'brightness': {
            // Positive: move toward white by `amount`. Negative: scale toward black.
            // Written so no input (even Infinity) produces NaN; the extremes are constants.
            const b = op.amount;
            if (b === 1)
                return { kind: 'channel', fn: () => 1 };
            if (b === -1)
                return { kind: 'channel', fn: () => 0 };
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
        case 'temperature': {
            // White-balance style gains, normalized so white keeps its luminance.
            const r = 1 + TEMPERATURE_STRENGTH * op.amount;
            const b = 1 - TEMPERATURE_STRENGTH * op.amount;
            const n = LUMA_R * r + LUMA_G + LUMA_B * b;
            const gains = [r / n, 1 / n, b / n];
            return { kind: 'channel', fn: (v, c) => v * gains[c] };
        }
        case 'levels': {
            // Levels act on sRGB-encoded values, as on a histogram, but without 8-bit rounding.
            const { inBlack, inWhite, outBlack, outWhite } = op;
            const inRange = inWhite - inBlack;
            const outRange = outWhite - outBlack;
            const e = 1 / op.gamma;
            return {
                kind: 'channel',
                fn: (v) => {
                    let x = (linearToSrgb(v) - inBlack) / inRange;
                    x = x <= 0 ? 0 : x >= 1 ? 1 : Math.pow(x, e);
                    return srgbToLinear(outBlack + x * outRange);
                },
            };
        }
    }
}
//# sourceMappingURL=index.js.map