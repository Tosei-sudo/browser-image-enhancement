/**
 * Moving targets from any layer of position reports (AIS, radar tracks,
 * patrol reports, a CSV of sightings…): the layer's attributes are mapped to
 * an id, a time, a course, a speed and a name, each target is taken from its
 * last report (its course and speed from the last two reports when it has
 * none), and where it will be is predicted as circles that grow with the time
 * since (see imaging-plan-moving.ts, which plans the shots).
 */
import { circleTarget, shipAt, uncertaintyAt, type ShipState, type UncertaintyModel } from './imaging-plan-moving.js';
import { detectFields, numberOf, timeOf, type FieldMap } from './moving.js';

/** The attributes of a layer that make a target. Without `time` every report is taken as made now. */
export interface TargetFields {
  id?: string;
  time?: string;
  course?: string;
  speed?: string;
  name?: string;
}

/** Units of the speed attribute. */
export type SpeedUnit = 'kn' | 'kmh' | 'ms';
export const speedUnits: Record<SpeedUnit, string> = { kn: 'ノット', kmh: 'km/h', ms: 'm/s' };
const TO_KNOTS: Record<SpeedUnit, number> = { kn: 1, kmh: 1 / 1.852, ms: 3600 / 1852 };

/** One report: a feature's attributes and its place. */
export interface Report {
  attributes: Record<string, unknown>;
  lonLat: [number, number];
}

/** The attributes found by name among `keys` (as the moving-object feeds find them). */
export function guessTargetFields(keys: Iterable<string>): TargetFields {
  const found: FieldMap = detectFields(keys);
  return { id: found.id, time: found.time, course: found.course ?? found.heading, speed: found.speed, name: found.name };
}

const R = 6371.0088;
const rad = Math.PI / 180;

/** The great-circle distance (km) and initial bearing (degrees) from `a` to `b`. */
function inverse([lon1, lat1]: [number, number], [lon2, lat2]: [number, number]): { km: number; bearing: number } {
  const [p1, p2, dl] = [lat1 * rad, lat2 * rad, (lon2 - lon1) * rad];
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const km = 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  const bearing = (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) / rad + 360) % 360;
  return { km, bearing };
}

/** An angle 0–360 from an attribute; null when it is not one (AIS's 511 and 360+ are "not available"). */
const angleOf = (v: unknown) => {
  const n = numberOf(v);
  return n === null || n < 0 || n >= 360 ? null : n;
};

/**
 * The targets of `reports` by `fields`: one per id, at its last report
 * (`now` for reports without a time). A target without a course or a speed
 * of its own takes them from its last two reports. Speeds are read in `unit`
 * and kept in knots. Reports without an id are left out.
 */
export function targetsOf(reports: readonly Report[], fields: TargetFields, unit: SpeedUnit, model: UncertaintyModel, now = Date.now()): ShipState[] {
  const byId = new Map<string, Array<{ t: number; report: Report }>>();
  for (const report of reports) {
    const raw = fields.id ? report.attributes[fields.id] : undefined;
    const id = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
    if (!id || !report.lonLat.every(Number.isFinite)) continue;
    const t = (fields.time ? timeOf(report.attributes[fields.time]) : null) ?? now;
    byId.set(id, [...(byId.get(id) ?? []), { t, report }]);
  }
  const targets: ShipState[] = [];
  for (const [id, list] of byId) {
    list.sort((a, b) => a.t - b.t);
    const { t, report } = list[list.length - 1];
    const attrs = report.attributes;
    let course = fields.course ? angleOf(attrs[fields.course]) : null;
    const given = fields.speed ? numberOf(attrs[fields.speed]) : null;
    let speed = given !== null && given >= 0 ? given * TO_KNOTS[unit] : null;
    // The last two reports far enough apart in time tell the way it went.
    const before = [...list].reverse().find((r) => r.t < t - 60000);
    if (before && (course === null || speed === null)) {
      const { km, bearing } = inverse(before.report.lonLat, report.lonLat);
      course ??= km > 0.01 ? bearing : null;
      speed ??= km / 1.852 / ((t - before.t) / 3600000);
    }
    const nameRaw = fields.name ? attrs[fields.name] : undefined;
    const name = typeof nameRaw === 'string' && nameRaw.trim() ? nameRaw.trim() : typeof nameRaw === 'number' ? String(nameRaw) : id;
    targets.push({ id, name, t, lon: report.lonLat[0], lat: report.lonLat[1], course, speed, model });
  }
  return targets;
}

/** A predicted place of a target: where it is guessed at `t` and the circle it may be off by. */
export interface PredictedPlace {
  target: ShipState;
  t: number;
  center: [number, number];
  /** The circle's radius, km. */
  radius: number;
  /** The circle, closed. */
  ring: Array<[number, number]>;
}

/**
 * The places of each target every `stepHours` from `start` (or its last
 * report, when later) to `horizon` hours after its report, the last one at
 * the horizon itself.
 */
export function predictedPlaces(targets: readonly ShipState[], start: number, horizon: number, stepHours: number): PredictedPlace[] {
  const step = Math.max(0.25, stepHours) * 3600000;
  const out: PredictedPlace[] = [];
  for (const target of targets) {
    const until = target.t + horizon * 3600000;
    const from = Math.max(start, target.t);
    for (let t = from; t <= until + 1; t += step) {
      const at = Math.min(t, until);
      const circle = circleTarget(target, at);
      out.push({ target, t: at, center: shipAt(target, at), radius: uncertaintyAt(target, at), ring: [...circle.points, circle.points[0]] });
      if (at === until) break;
    }
  }
  return out;
}

/** The predicted track of a target, from its report to the horizon, as points every hour. */
export function predictedTrack(target: ShipState, horizon: number): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let h = 0; h <= horizon; h += 1) points.push(shipAt(target, target.t + h * 3600000));
  return points;
}

