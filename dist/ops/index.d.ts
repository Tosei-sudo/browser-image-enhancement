import type { LevelsOptions, OpName, OpSpec } from '../types.js';
/** A per-channel transform. `c` is 0, 1, 2 for R, G, B (or 0 for a gray channel). */
export type ChannelFn = (v: number, c: number) => number;
/** One compiled step. `channel` steps act on each channel independently; `saturation` mixes channels. */
export type Stage = {
    kind: 'channel';
    fn: ChannelFn;
} | {
    kind: 'saturation';
    factor: number;
};
/** Corrections that only make sense for color images; no-ops on monochrome input. */
export declare const COLOR_ONLY_OPS: ReadonlySet<OpName>;
/** Validates and clamps a levels parameter object, filling defaults. */
export declare function normalizeLevels(o?: LevelsOptions): Required<LevelsOptions>;
/**
 * Validates an op (from code or from JSON) and clamps its parameters.
 * Throws only for an unknown op name, since that cannot be repaired.
 */
export declare function normalizeOp(raw: unknown): OpSpec;
/** True when the op leaves every pixel unchanged, so it can be skipped. */
export declare function isIdentity(op: OpSpec): boolean;
/** Builds the per-pixel math for a normalized op. */
export declare function toStage(op: OpSpec): Stage;
//# sourceMappingURL=index.d.ts.map