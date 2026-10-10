/**
 * An imaging opportunity (imaging-plan.ts) as the 3D view draws it: the
 * orbit at its height around the moment, where the satellite is and which way
 * it moves, and where its sensor looks (the middle of the scenes it takes).
 * Positions are Earth-fixed (ECEF, metres), as CesiumJS's Cartesian3.
 *
 * Only the display is worked out here; the plan itself is imaging-plan.ts's.
 */
import { eciToEcf, eciToGeodetic, geodeticToEcf, gstime, sgp4, type SatRec } from 'satellite.js';
import { passShapes, satrecOf, type Opportunity, type PlanTarget, type SatelliteSpec } from './imaging-plan.js';

export type Xyz = [number, number, number];

/** One pass of a satellite, for the 3D view. */
export interface SatellitePass3d {
  name: string;
  /** The moment of the shot, ms since the epoch. */
  time: number;
  /** Whether it is the opportunity chosen in the list (the others are the rest of a combination). */
  chosen: boolean;
  /** The orbit around the moment, ECEF metres, and the height of each point above the ellipsoid (m). */
  orbit: Xyz[];
  heights: number[];
  /** Where the satellite is at the moment, and its velocity over the ground (ECEF, m/s). */
  position: Xyz;
  velocity: Xyz;
  /** Where the sensor looks: the middle of the scenes, on the ellipsoid (ECEF metres). */
  aim: Xyz;
  /** The scenes on the ground (longitude, latitude rings). */
  scenes: Array<Array<[number, number]>>;
  offNadir: number;
  side: 'left' | 'right';
}

const julian = (ms: number) => ms / 86400000 + 2440587.5;
const rad = Math.PI / 180;
/** The Earth's turn, rad/s. */
const omega = 7.2921159e-5;

/** The satellite's ECEF position (m), velocity (m/s) and height (m) at a moment; null when SGP4 fails. */
function stateAt(satrec: SatRec, ms: number): { r: Xyz; v: Xyz; height: number } | null {
  const jd = julian(ms);
  const pv = sgp4(satrec, (jd - satrec.jdsatepoch) * 1440);
  if (!pv || typeof pv.position !== 'object' || !Number.isFinite(pv.position.x) || typeof pv.velocity !== 'object') return null;
  const gmst = gstime(jd);
  const p = eciToEcf(pv.position, gmst);
  const vr = eciToEcf(pv.velocity, gmst);
  const r: Xyz = [p.x * 1000, p.y * 1000, p.z * 1000];
  const v: Xyz = [(vr.x + omega * p.y) * 1000, (vr.y - omega * p.x) * 1000, vr.z * 1000];
  return { r, v, height: eciToGeodetic(pv.position, gmst).height * 1000 };
}

/** ECEF metres of a point on the ellipsoid. */
export function ecefOf(lon: number, lat: number, height = 0): Xyz {
  const e = geodeticToEcf({ longitude: lon * rad, latitude: lat * rad, height: height / 1000 });
  return [e.x * 1000, e.y * 1000, e.z * 1000];
}

/**
 * The pass of `op` for the 3D view: the orbit `minutes` before and after the
 * moment (a point every `step` seconds), the satellite and where it looks.
 */
export function satellitePass3d(sat: SatelliteSpec, target: PlanTarget, op: Opportunity, chosen: boolean, minutes = 12, step = 20): SatellitePass3d | null {
  const satrec = satrecOf(sat);
  if (typeof satrec === 'string') return null;
  const now = stateAt(satrec, op.time);
  if (!now) return null;
  const orbit: Xyz[] = [];
  const heights: number[] = [];
  for (let s = -minutes * 60; s <= minutes * 60; s += step) {
    const st = stateAt(satrec, op.time + s * 1000);
    if (!st) continue;
    orbit.push(st.r);
    heights.push(st.height);
  }
  const shapes = passShapes(sat, target, op);
  const scenes = shapes?.scenes ?? [];
  // The middle of the scenes (their corners averaged on the sphere), else the target's.
  const corners = scenes.flatMap((ring) => ring.slice(0, -1)).map(([lon, lat]) => ecefOf(lon, lat));
  let aim = ecefOf(target.center[0], target.center[1]);
  if (corners.length) {
    const sum = corners.reduce<Xyz>((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0]);
    const n = Math.hypot(...sum);
    const lon = Math.atan2(sum[1], sum[0]) / rad;
    const lat = Math.asin(sum[2] / n) / rad;
    aim = ecefOf(lon, lat);
  }
  return { name: sat.name, time: op.time, chosen, orbit, heights, position: now.r, velocity: now.v, aim, scenes, offNadir: op.offNadir, side: op.side };
}

/**
 * The satellite's attitude as three unit axes (ECEF): `x` along its track,
 * `z` away from where it looks (so the sensor, on −z, faces the aim) and `y`
 * completing them.
 */
export function attitude(pass: Pick<SatellitePass3d, 'position' | 'velocity' | 'aim'>): { x: Xyz; y: Xyz; z: Xyz } {
  const sub = (a: Xyz, b: Xyz): Xyz => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a: Xyz, b: Xyz) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: Xyz, b: Xyz): Xyz => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a: Xyz): Xyz => {
    const n = Math.hypot(...a) || 1;
    return [a[0] / n, a[1] / n, a[2] / n];
  };
  const z = unit(sub(pass.position, pass.aim));
  // The track, without its part along z.
  const v = pass.velocity;
  const along = sub(v, z.map((c) => c * dot(v, z)) as Xyz);
  const x = unit(Math.hypot(...along) > 1e-6 ? along : cross([0, 0, 1], z));
  const y = cross(z, x);
  return { x, y, z };
}
