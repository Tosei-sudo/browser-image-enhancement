/**
 * Imaging plans for ships followed by AIS (a moving-object feed): each ship
 * is carried on from its last report along its course at its speed (dead
 * reckoning), and a circle that grows with the time since that report says
 * how far off the guess may be. Passes over where the ship will be are
 * found in two steps: the guessed places every hour are planned as points
 * (in the worker), then each pass found is planned again for the circle
 * around where the ship is at that very moment, so the scene is aimed there
 * and its coverage of the circle tells how likely the ship is in the picture.
 */
import { planAccess, type Opportunity, type PlanOptions, type PlanResult, type PlanTarget, type SatelliteSpec } from './imaging-plan.js';
import type { Track } from './moving.js';

/** A ship's last report: where it was, which way and how fast it went. */
export interface ShipState {
  id: string;
  name: string;
  /** ms since 1970. */
  t: number;
  lon: number;
  lat: number;
  /** Degrees clockwise from north; null when unknown (the ship is taken as staying). */
  course: number | null;
  /** Knots; null when unknown. */
  speed: number | null;
  /** How the guess grows uncertain; {@link DEFAULT_UNCERTAINTY} when absent. */
  model?: UncertaintyModel;
}

/** How far off a guessed place may be: `base` km at the report, growing by `share` of the distance run and `perHour` km an hour. */
export interface UncertaintyModel {
  base: number;
  share: number;
  perHour: number;
}

export const DEFAULT_UNCERTAINTY: UncertaintyModel = { base: 0.5, share: 0.1, perHour: 0.5 };

/** How far ahead of a ship's last report it is guessed at most, hours. */
export const MAX_HORIZON = 72;
/** The most ships planned at once. */
export const MAX_SHIPS = 50;
/** Hours between the places planned in the first step. */
const SAMPLE_HOURS = 1;
/** The most passes planned again in the second step. */
const MAX_CANDIDATES = 400;
const KNOT_KMH = 1.852;
const R = 6371.0088;
const rad = Math.PI / 180;

/** A ship's last report from its track; null without one. */
export function shipOf(track: Track): ShipState | null {
  const fix = track.fixes[track.fixes.length - 1];
  if (!fix) return null;
  const course = track.course ?? track.heading ?? fix.dir;
  return { id: track.id, name: track.name ?? track.id, t: fix.t, lon: fix.lon, lat: fix.lat, course: course !== null && Number.isFinite(course) ? course : null, speed: fix.speed !== null && Number.isFinite(fix.speed) ? fix.speed : null };
}

/** The point `km` from `[lon, lat]` along the great circle at `bearing` degrees. */
export function destination([lon, lat]: [number, number], bearing: number, km: number): [number, number] {
  const d = km / R;
  const [p, l, b] = [lat * rad, lon * rad, bearing * rad];
  const p2 = Math.asin(Math.sin(p) * Math.cos(d) + Math.cos(p) * Math.sin(d) * Math.cos(b));
  const l2 = l + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p), Math.cos(d) - Math.sin(p) * Math.sin(p2));
  return [((((l2 / rad + 180) % 360) + 360) % 360) - 180, p2 / rad];
}

/** Where the ship is guessed to be at `t`: its last place carried on along its course at its speed. */
export function shipAt(ship: ShipState, t: number): [number, number] {
  const hours = (t - ship.t) / 3600000;
  if (ship.course === null || !ship.speed || hours <= 0) return [ship.lon, ship.lat];
  return destination([ship.lon, ship.lat], ship.course, ship.speed * KNOT_KMH * hours);
}

/**
 * How far off the guess at `t` may be, km: by default half a kilometre at
 * the report, growing by a tenth of the distance run (speed and course
 * drift) and half a kilometre an hour (turns, slowing down).
 */
export function uncertaintyAt(ship: ShipState, t: number): number {
  const { base, share, perHour } = ship.model ?? DEFAULT_UNCERTAINTY;
  const hours = Math.max(0, (t - ship.t) / 3600000);
  return base + hours * (share * (ship.speed ?? 0) * KNOT_KMH + perHour);
}

/** A circle target around where the ship is at `t`: its rim and points spread inside (for the coverage). */
export function circleTarget(ship: ShipState, t: number): PlanTarget {
  const center = shipAt(ship, t);
  const radius = uncertaintyAt(ship, t);
  const points = Array.from({ length: 24 }, (_, i) => destination(center, i * 15, radius));
  const cells: Array<[number, number]> = [center];
  for (const [ring, n] of [
    [0.3, 8],
    [0.55, 14],
    [0.8, 20],
    [0.97, 26],
  ] as const)
    for (let i = 0; i < n; i++) cells.push(destination(center, (i * 360) / n, radius * ring));
  return { label: ship.name, center, points, cells, uncertainty: radius, guessed: t - ship.t };
}

/** The window of `options` within the ships' reach: from the start to the last ship's report plus the horizon. */
export function shipWindow(ships: readonly ShipState[], options: Pick<PlanOptions, 'start' | 'end'>, horizon = MAX_HORIZON): { start: number; end: number } {
  const last = Math.max(...ships.map((s) => s.t));
  return { start: options.start, end: Math.min(options.end, last + horizon * 3600000) };
}

/** The places of the first step: each ship every hour over the window, with the time each stands for. */
export function sampleTargets(ships: readonly ShipState[], start: number, end: number, horizon = MAX_HORIZON): { targets: PlanTarget[]; samples: Array<{ ship: number; t: number }> } {
  const step = SAMPLE_HOURS * 3600000;
  const targets: PlanTarget[] = [];
  const samples: Array<{ ship: number; t: number }> = [];
  ships.forEach((ship, k) => {
    const until = Math.min(end, ship.t + horizon * 3600000);
    for (let t = start; t <= until + step / 2; t += step) {
      const at = Math.min(t, until);
      targets.push({ label: ship.name, center: shipAt(ship, at), points: [] });
      samples.push({ ship: k, t: at });
      if (at === until) break;
    }
  });
  return { targets, samples };
}

/** One shot of a ship: its pass and the circle it is aimed at. */
export interface ShipShot {
  ship: number;
  op: Opportunity;
  target: PlanTarget;
}

/**
 * The second step: the first step's passes whose moment falls in the hour a
 * place stands for, each planned again (twice, to follow the ship to the
 * moment of the pass) for the circle around where the ship is then. One shot
 * per satellite pass and ship, in time order.
 */
export function refineShots(first: PlanResult, samples: ReadonlyArray<{ ship: number; t: number }>, ships: readonly ShipState[], sats: readonly SatelliteSpec[], options: PlanOptions): ShipShot[] {
  const half = (SAMPLE_HOURS * 3600000) / 2;
  const candidates = first.opportunities.filter((op) => Math.abs(op.time - samples[op.target].t) <= half).slice(0, MAX_CANDIDATES);
  const shots: ShipShot[] = [];
  for (const candidate of candidates) {
    const k = samples[candidate.target].ship;
    const ship = ships[k];
    const sat = sats[candidate.satellite];
    let t = candidate.time;
    let found: { op: Opportunity; target: PlanTarget } | null = null;
    for (let i = 0; i < 2; i++) {
      const target = circleTarget(ship, t);
      const near = planAccess([sat], [target], { ...options, start: t - 20 * 60000, end: t + 20 * 60000, stations: [] }).opportunities;
      const op = near.sort((a, b) => Math.abs(a.time - t) - Math.abs(b.time - t))[0];
      if (!op) break;
      found = { op: { ...op, satellite: candidate.satellite, ...(candidate.downlink ? { downlink: candidate.downlink } : {}) }, target };
      if (Math.abs(op.time - t) < 1000) break;
      t = op.time;
    }
    if (!found) continue;
    if (shots.some((s) => s.ship === k && s.op.satellite === found.op.satellite && Math.abs(s.op.time - found.op.time) < 10 * 60000)) continue;
    shots.push({ ship: k, ...found });
  }
  return shots.sort((a, b) => a.op.time - b.op.time);
}

/** The shots as a plan: one target (the circle) per shot, the shots pointing at them. */
export function shipPlan(shots: readonly ShipShot[], first: PlanResult): PlanResult & { targets: PlanTarget[] } {
  return {
    targets: shots.map((s) => s.target),
    opportunities: shots.map((s, i) => ({ ...s.op, target: i })),
    problems: first.problems,
    tooSoon: first.tooSoon,
  };
}
