/**
 * Change between two dates of one place: how a pixel's value after compares
 * with its value before (a difference, a ratio, a ratio in decibels for SAR,
 * a normalized difference), which pixels changed more than a threshold, and
 * the outlines of those pixels as polygons (mask-polygons.ts).
 */

/** How before (`A`) and after (`B`) are compared. */
export interface ChangeMethod {
  id: 'difference' | 'ratio' | 'logRatio' | 'normalized';
  label: string;
  /** Over the variables `A` (before) and `B` (after). */
  expression: string;
  /** The value of "no change". */
  center: number;
  /** The unit of thresholds, for messages. */
  unit: string;
}

export const CHANGE_METHODS: readonly ChangeMethod[] = [
  { id: 'difference', label: '差（後 − 前）', expression: 'B - A', center: 0, unit: '' },
  { id: 'logRatio', label: '対数比 dB（10·log10(後 ÷ 前)、SAR 向け）', expression: '10 * log10(B / A)', center: 0, unit: ' dB' },
  { id: 'ratio', label: '比（後 ÷ 前）', expression: 'B / A', center: 1, unit: '' },
  { id: 'normalized', label: '正規化差（(後 − 前) ÷ (後 + 前)）', expression: '(B - A) / (B + A)', center: 0, unit: '' },
];

/** Which way a change goes. */
export type ChangeDirection = 'both' | 'increase' | 'decrease';

/** Values at or below `low` decreased, at or above `high` increased. */
export interface ChangeThresholds {
  low: number;
  high: number;
}

/** Mean and standard deviation of the values that are numbers. */
export function meanAndDeviation(values: ArrayLike<number>): { mean: number; deviation: number; count: number } {
  let count = 0;
  let sum = 0;
  let squares = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== v) continue;
    count++;
    sum += v;
    squares += v * v;
  }
  if (!count) return { mean: NaN, deviation: NaN, count };
  const mean = sum / count;
  return { mean, deviation: Math.sqrt(Math.max(0, squares / count - mean * mean)), count };
}

/**
 * The thresholds: `center` ± `typed` when a value is typed, else the mean ±
 * `deviations` standard deviations (most pixels did not change, so the mean
 * also takes up a general difference of the two dates, such as brightness).
 */
export function thresholdsOf(values: ArrayLike<number>, center: number, typed: number | null, deviations = 2): ChangeThresholds {
  if (typed !== null && typed > 0) return { low: center - typed, high: center + typed };
  const { mean, deviation } = meanAndDeviation(values);
  if (!Number.isFinite(mean)) return { low: -Infinity, high: Infinity };
  // A flat result changed nowhere.
  const spread = Math.max(deviation * deviations, 1e-9);
  return { low: mean - spread, high: mean + spread };
}

/** The pixels that changed, one way: 1 where they did. */
export function changeMask(values: ArrayLike<number>, thresholds: ChangeThresholds, direction: Exclude<ChangeDirection, 'both'>): Uint8Array {
  const mask = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== v) continue;
    if (direction === 'increase' ? v >= thresholds.high : v <= thresholds.low) mask[i] = 1;
  }
  return mask;
}

/**
 * The value `p` of the way (0–1) up the distances of the values from `center`,
 * for showing a change image symmetrically: `center` ± that in the middle of
 * a diverging color scale.
 */
export function spreadOf(values: ArrayLike<number>, center: number, p = 0.98): number {
  const distances: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === v) distances.push(Math.abs(v - center));
  }
  if (!distances.length) return 1;
  distances.sort((a, b) => a - b);
  const d = distances[Math.min(distances.length - 1, Math.floor(p * distances.length))];
  return d > 0 ? d : (distances[distances.length - 1] || 1);
}
