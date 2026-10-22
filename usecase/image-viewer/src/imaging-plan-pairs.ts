/**
 * Pairs of shots of one target for the imaging plan: stereo pairs (two
 * looks from directions far enough apart to measure heights, for a DSM or
 * building heights) and repeat pairs for SAR interferometry (the same
 * satellite or series coming back on the same orbit track, looking the same
 * way at the same angle, with a short perpendicular baseline).
 */
import { ecefAt, type Opportunity, type PlanTarget, type SatelliteSpec } from './imaging-plan.js';

/** Two shots of one target, in time order, and how they relate. */
export interface PlanPair {
  a: Opportunity;
  b: Opportunity;
  /** Angle between the two lines of sight at the target, degrees. */
  convergence: number;
  /** Base-to-height ratio of the two looks (2 tan(γ/2)). */
  bh: number;
  /** Days between them. */
  days: number;
  /** Baseline across the line of sight, metres. */
  baseline: number;
}

export interface StereoOptions {
  /** Convergence angle, degrees (15–45 by default: about B/H 0.26–0.83). */
  minAngle: number;
  maxAngle: number;
  /** The most days between the two shots. */
  maxDays: number;
  /** Only satellites of the same series (the same kind of sensor) together. */
  sameSeries: boolean;
}

export interface RepeatOptions {
  /** The largest difference of incidence angle, degrees. */
  maxIncidence: number;
  /** The largest difference of look azimuth, degrees. */
  maxAzimuth: number;
  /** The longest perpendicular baseline, metres; null for any. */
  maxBaseline: number | null;
  /** Satellites of the same series count as one (a constellation on one orbit); otherwise only the same satellite. */
  sameSeries: boolean;
}

export const defaultStereo: StereoOptions = { minAngle: 15, maxAngle: 45, maxDays: 7, sameSeries: true };
export const defaultRepeat: RepeatOptions = { maxIncidence: 1, maxAzimuth: 2, maxBaseline: null, sameSeries: false };
/** The most pairs one target gives. */
const MAX_PER_TARGET = 200;

type Vec = [number, number, number];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec) => Math.sqrt(dot(a, a));
const unit = (a: Vec): Vec => {
  const n = norm(a);
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** How two shots of `target` relate: their convergence angle, B/H, days apart and perpendicular baseline. */
export function relate(a: Opportunity, b: Opportunity, target: PlanTarget): PlanPair {
  const t = ecefAt(target.center);
  const ua = unit(sub(a.satEcef, t));
  const ub = unit(sub(b.satEcef, t));
  const convergence = (Math.acos(Math.max(-1, Math.min(1, dot(ua, ub)))) * 180) / Math.PI;
  const d = sub(b.satEcef, a.satEcef);
  const along = dot(d, ua);
  const across = norm([d[0] - along * ua[0], d[1] - along * ua[1], d[2] - along * ua[2]]);
  const [first, second] = a.time <= b.time ? [a, b] : [b, a];
  return { a: first, b: second, convergence, bh: 2 * Math.tan(((convergence / 2) * Math.PI) / 180), days: Math.abs(b.time - a.time) / 86400000, baseline: across * 1000 };
}

const groupKey = (sat: SatelliteSpec, sameSeries: boolean) => (sameSeries ? `s:${sat.series}` : `n:${sat.source}\n${sat.id}`);

/**
 * Stereo pairs: two shots of the same target from directions `minAngle`–
 * `maxAngle` apart within `maxDays`, both of the same kind of sensor (and
 * series when asked). Earliest second shot first.
 */
export function stereoPairs(ops: readonly Opportunity[], sats: readonly SatelliteSpec[], targets: readonly PlanTarget[], options: StereoOptions = defaultStereo): PlanPair[] {
  const byTarget = new Map<number, Opportunity[]>();
  for (const op of ops) byTarget.set(op.target, [...(byTarget.get(op.target) ?? []), op]);
  const pairs: PlanPair[] = [];
  for (const [target, list] of byTarget) {
    list.sort((x, y) => x.time - y.time);
    const found: PlanPair[] = [];
    for (let i = 0; i < list.length && found.length < MAX_PER_TARGET; i++) {
      for (let j = i + 1; j < list.length && found.length < MAX_PER_TARGET; j++) {
        const [a, b] = [list[i], list[j]];
        if (b.time - a.time > options.maxDays * 86400000) break;
        const [sa, sb] = [sats[a.satellite], sats[b.satellite]];
        if (sa.sar !== sb.sar) continue;
        if (options.sameSeries && sa.series !== sb.series) continue;
        const pair = relate(a, b, targets[target]);
        if (pair.convergence >= options.minAngle && pair.convergence <= options.maxAngle) found.push(pair);
      }
    }
    pairs.push(...found);
  }
  return pairs.sort((x, y) => x.b.time - y.b.time || x.a.time - y.a.time);
}

/** The difference of two azimuths, degrees (0–180). */
const azimuthGap = (x: number, y: number) => {
  const d = Math.abs(x - y) % 360;
  return d > 180 ? 360 - d : d;
};

/**
 * Repeat pairs for SAR interferometry: for each SAR shot, the next shot of
 * the same target by the same satellite (or series) on a pass going the same
 * way, looking to the same side at an incidence within `maxIncidence` and an
 * azimuth within `maxAzimuth` (the same orbit track), with a perpendicular
 * baseline no longer than `maxBaseline`. In time order: a chain of
 * acquisitions for a time series.
 */
export function repeatPairs(ops: readonly Opportunity[], sats: readonly SatelliteSpec[], targets: readonly PlanTarget[], options: RepeatOptions = defaultRepeat): PlanPair[] {
  const groups = new Map<string, Opportunity[]>();
  for (const op of ops) {
    const sat = sats[op.satellite];
    if (!sat.sar) continue;
    const key = `${groupKey(sat, options.sameSeries)}|${op.target}|${op.ascending}|${op.side}`;
    groups.set(key, [...(groups.get(key) ?? []), op]);
  }
  const pairs: PlanPair[] = [];
  for (const list of groups.values()) {
    list.sort((x, y) => x.time - y.time);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (Math.abs(b.incidence - a.incidence) > options.maxIncidence || azimuthGap(a.azimuth, b.azimuth) > options.maxAzimuth) continue;
        const pair = relate(a, b, targets[a.target]);
        if (options.maxBaseline !== null && pair.baseline > options.maxBaseline) continue;
        pairs.push(pair);
        break;
      }
    }
  }
  return pairs.sort((x, y) => x.a.time - y.a.time || x.b.time - y.b.time);
}
