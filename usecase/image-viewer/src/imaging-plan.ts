/**
 * Imaging plans: when can the satellites of a catalog next take a picture of
 * a place? The catalog is an Esri feature layer (or table) of satellites
 * with their two-line elements (TLE) and specifications (how far off nadir
 * they can look, how wide a scene is, which side they look to); its layout is
 * not known in advance, so `config.json` maps its attribute names to roles
 * ({@link SatelliteFields}), as for image catalogs (catalog.ts).
 *
 * The orbits are propagated with SGP4 (satellite.js). For each pass over a
 * target the moment of closest approach (the smallest off-nadir angle) is
 * found, and the pass is an opportunity when that angle is within what the
 * satellite can do, on a side it can look to, and (for optical satellites)
 * in daylight. An area (a polygon) is sampled by points inside it: each pass
 * takes the scenes it can (`scenesPerPass` side by side) where they cover the
 * most of what it can reach, and {@link coverPlan} strings passes of several
 * satellites together, earliest first, until the area is covered.
 *
 * Everything here is plain computation, run in a worker (imaging-plan-worker.ts);
 * the panel is imaging-plan-panel.ts.
 */
import { eciToEcf, eciToGeodetic, geodeticToEcf, gstime, sgp4, sunPos, twoline2satrec, type SatRec } from 'satellite.js';

/** Attribute names of the satellite catalog, by role. The TLE (`tle`, or `tle1` and `tle2`) is required. */
export interface SatelliteFields {
  /** The satellite's name, shown in the results. */
  name?: string;
  /** Another id (NORAD number, an internal code); the name is used when absent. */
  id?: string;
  /** Both lines of the TLE in one field (a name line before them is allowed). */
  tle?: string;
  /** Line 1 of the TLE. */
  tle1?: string;
  /** Line 2 of the TLE. */
  tle2?: string;
  /** Largest off-nadir angle the satellite can look at, in degrees. */
  maxOffNadir?: string;
  /** Smallest off-nadir angle (SAR satellites cannot look straight down), in degrees. */
  minOffNadir?: string;
  /** Width of a scene across the track (km, or m with `swathUnit: "m"`). */
  swath?: string;
  /** Length of a scene along the track, in the same unit; the width when absent. */
  length?: string;
  /** Which side it looks to: `right` / `left` / `both` (also `R`, `L`, `右`, `左`). */
  lookSide?: string;
  /** The kind of sensor; values matching `sarPattern` are SAR (they image at night too). */
  kind?: string;
  /** How many scenes side by side one pass can take (an agile satellite turning between strips). */
  scenesPerPass?: string;
  /** Minutes the satellite needs after one shot before the next (turning, cooling, downlink); 0 or empty for none. */
  minInterval?: string;
  /** Most shots it can take in 24 hours (power, memory); 0 or empty for no limit. */
  maxPerDay?: string;
}

/** Specifications used when the catalog leaves a field empty. */
export interface SatelliteDefaults {
  maxOffNadir: number;
  minOffNadir: number;
  /** km. */
  swath: number;
  /** Scenes side by side in one pass. */
  scenesPerPass: number;
  /** Minutes between shots (0: none). */
  minInterval: number;
  /** Shots in 24 hours (0: no limit). */
  maxPerDay: number;
}

/** One catalog from `config.json`'s `satelliteCatalogs`. */
export interface SatelliteCatalogConfig {
  /** Name in the panel. */
  label: string;
  /** The feature layer or table (`…/FeatureServer/0`). */
  url: string;
  /** An ArcGIS token sent with every request (as a POST). */
  token?: string;
  fields: SatelliteFields;
  /** A condition every query adds (SQL, such as `STATUS = 'ACTIVE'`). */
  where?: string;
  /** The unit of `swath` and `length` in the catalog. */
  swathUnit: 'km' | 'm';
  defaults: SatelliteDefaults;
  /** Values of `kind` that mean SAR. */
  sarPattern: RegExp;
}

/** Specifications used when neither the catalog nor `config.json` gives them. */
export const builtInDefaults: SatelliteDefaults = { maxOffNadir: 30, minOffNadir: 0, swath: 10, scenesPerPass: 1, minInterval: 0, maxPerDay: 0 };
const defaultSar = /SAR|radar|レーダ/i;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isName = (value: unknown): value is string => typeof value === 'string' && /^[\w.]+$/.test(value);
const isUrl = (url: unknown): url is string => typeof url === 'string' && /^(https?:)?\/\/|^\.{0,2}\//.test(url);
const roles = ['name', 'id', 'tle', 'tle1', 'tle2', 'maxOffNadir', 'minOffNadir', 'swath', 'length', 'lookSide', 'kind', 'scenesPerPass', 'minInterval', 'maxPerDay'] as const;

/** The catalog of one `satelliteCatalogs` entry; null (with the reason in `problems`) when it cannot be used. */
export function satelliteCatalogOf(value: unknown, problems: string[], index: number): SatelliteCatalogConfig | null {
  const at = `satelliteCatalogs[${index}]`;
  if (!isRecord(value)) return (problems.push(`${at} がオブジェクトではありません`), null);
  const { label, url, token, fields, where, swathUnit, defaults, sarPattern } = value;
  if (!isUrl(url) || !/\/(FeatureServer|MapServer)\/\d+\/?$/i.test(url.split('?', 1)[0])) {
    return (problems.push(`${at} の url は …/FeatureServer/0 のようなレイヤー（テーブル）の URL にしてください`), null);
  }
  if (!isRecord(fields)) return (problems.push(`${at} に fields（属性名の対応）がありません`), null);
  const mapped: SatelliteFields = {};
  for (const role of roles) {
    const name = fields[role];
    if (name === undefined || name === '') continue;
    if (isName(name)) mapped[role] = name;
    else problems.push(`${at} の fields.${role} は属性名（英数字と _）にしてください`);
  }
  if (!mapped.tle && !(mapped.tle1 && mapped.tle2)) return (problems.push(`${at} に fields.tle（または tle1 と tle2）がありません`), null);

  const given: Partial<SatelliteDefaults> = {};
  if (isRecord(defaults)) {
    for (const key of ['maxOffNadir', 'minOffNadir', 'swath', 'scenesPerPass', 'minInterval', 'maxPerDay'] as const) {
      const v = defaults[key];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) given[key] = v;
      else if (v !== undefined) problems.push(`${at} の defaults.${key} は 0 以上の数にしてください`);
    }
  }
  let sar = defaultSar;
  if (typeof sarPattern === 'string' && sarPattern) {
    try {
      sar = new RegExp(sarPattern, 'i');
    } catch {
      problems.push(`${at} の sarPattern は正規表現として読めません`);
    }
  }
  return {
    label: typeof label === 'string' && label ? label : `衛星カタログ ${index + 1}`,
    url: url.split('?', 1)[0].replace(/\/+$/, ''),
    ...(typeof token === 'string' && token ? { token } : {}),
    fields: mapped,
    ...(typeof where === 'string' && where.trim() ? { where: where.trim() } : {}),
    swathUnit: swathUnit === 'm' ? 'm' : 'km',
    defaults: { ...builtInDefaults, ...given },
    sarPattern: sar,
  };
}

/** Which side a satellite can look to. */
export type LookSide = 'both' | 'left' | 'right';

/** One satellite, ready for planning. */
export interface SatelliteSpec {
  name: string;
  id: string;
  tle1: string;
  tle2: string;
  /** Degrees. */
  maxOffNadir: number;
  minOffNadir: number;
  /** km. */
  swath: number;
  /** km. */
  length: number;
  /** Scenes side by side in one pass (1 or more). */
  scenesPerPass: number;
  /** Minutes it needs between shots (0: none). */
  minInterval: number;
  /** Most shots in 24 hours (0: no limit). */
  maxPerDay: number;
  lookSide: LookSide;
  sar: boolean;
  /** Where it came from (the catalog's label, or 「貼り付け」). */
  source: string;
}

export function lookSideOf(value: unknown): LookSide {
  const text = typeof value === 'string' ? value.trim() : '';
  if (/^(r|right|右)/i.test(text)) return 'right';
  if (/^(l|left|左)/i.test(text)) return 'left';
  return 'both';
}

/** The two TLE lines (and a name line before them, when there is one) in a text. */
export function tleLines(text: string): { name: string; tle1: string; tle2: string } | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const i = lines.findIndex((l, k) => /^1 /.test(l) && /^2 /.test(lines[k + 1] ?? ''));
  if (i < 0) return null;
  const name = i > 0 ? lines[i - 1].replace(/^0 /, '') : '';
  return { name, tle1: lines[i], tle2: lines[i + 1] };
}

const numberOf = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** The satellite of a catalog feature's attributes; a problem (text) when its TLE cannot be read. */
export function satelliteOf(attributes: Record<string, unknown>, catalog: SatelliteCatalogConfig): SatelliteSpec | string {
  const { fields, defaults } = catalog;
  const get = (name?: string) => (name ? attributes[name] : undefined);
  const text = fields.tle ? String(get(fields.tle) ?? '') : `${String(get(fields.tle1) ?? '')}\n${String(get(fields.tle2) ?? '')}`;
  const tle = tleLines(text);
  const name = String(get(fields.name) ?? tle?.name ?? '').trim() || (tle ? `NORAD ${tle.tle1.slice(2, 7).trim()}` : '');
  if (!tle) return `${name || '名前のない衛星'}: TLE がありません`;
  const scale = catalog.swathUnit === 'm' ? 0.001 : 1;
  const swath = (numberOf(get(fields.swath)) ?? defaults.swath / scale) * scale;
  const length = numberOf(get(fields.length));
  const kind = get(fields.kind);
  return {
    name,
    id: String(get(fields.id) ?? '').trim() || name,
    tle1: tle.tle1,
    tle2: tle.tle2,
    maxOffNadir: numberOf(get(fields.maxOffNadir)) ?? defaults.maxOffNadir,
    minOffNadir: numberOf(get(fields.minOffNadir)) ?? defaults.minOffNadir,
    swath,
    length: length === null ? swath : length * scale,
    scenesPerPass: Math.max(1, Math.round(numberOf(get(fields.scenesPerPass)) ?? defaults.scenesPerPass)),
    minInterval: Math.max(0, numberOf(get(fields.minInterval)) ?? defaults.minInterval),
    maxPerDay: Math.max(0, Math.round(numberOf(get(fields.maxPerDay)) ?? defaults.maxPerDay)),
    lookSide: lookSideOf(get(fields.lookSide)),
    sar: typeof kind === 'string' && catalog.sarPattern.test(kind),
    source: catalog.label,
  };
}

/**
 * Satellites from pasted TLE text (two lines each, or three with a name
 * line), all with the same specifications.
 */
export function satellitesFromText(
  text: string,
  spec: Pick<SatelliteDefaults, 'maxOffNadir' | 'minOffNadir' | 'swath'> & Partial<SatelliteDefaults> & { lookSide?: LookSide; sar?: boolean },
): SatelliteSpec[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const found: SatelliteSpec[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!/^1 /.test(lines[i]) || !/^2 /.test(lines[i + 1])) continue;
    const before = i > 0 && !/^[12] /.test(lines[i - 1]) ? lines[i - 1].replace(/^0 /, '') : '';
    const name = before || `NORAD ${lines[i].slice(2, 7).trim()}`;
    found.push({
      name,
      id: lines[i].slice(2, 7).trim(),
      tle1: lines[i],
      tle2: lines[i + 1],
      maxOffNadir: spec.maxOffNadir,
      minOffNadir: spec.minOffNadir,
      swath: spec.swath,
      length: spec.swath,
      scenesPerPass: Math.max(1, Math.round(spec.scenesPerPass ?? 1)),
      minInterval: Math.max(0, spec.minInterval ?? 0),
      maxPerDay: Math.max(0, Math.round(spec.maxPerDay ?? 0)),
      lookSide: spec.lookSide ?? 'both',
      sar: spec.sar ?? false,
      source: '貼り付け',
    });
    i++;
  }
  return found;
}

/** What samples are called in `source`, so the list can tell them apart. */
export const SAMPLE_SOURCE = 'サンプル';

/**
 * Two made-up satellites for trying the panel when `config.json` has no
 * satellite catalog: a sun-synchronous optical one like Sentinel-2 (about
 * 786 km, 10:30 descending, 290 km reach) and a right-looking SAR one like
 * Sentinel-1 (about 693 km, 18:00 ascending). Their elements are fixed, not
 * real TLEs, so they only show how planning works.
 */
export function sampleSatellites(): SatelliteSpec[] {
  const base = { minOffNadir: 0, minInterval: 0, maxPerDay: 0, source: SAMPLE_SOURCE };
  return [
    {
      ...base,
      name: 'サンプル光学衛星',
      id: 'SAMPLE-OPT',
      tle1: '1 90001U 26901A   26280.50000000  .00000100  00000-0  40000-4 0  9990',
      tle2: '2 90001  98.5700 350.5000 0001100  90.0000 270.0000 14.30820000    13',
      maxOffNadir: 20,
      swath: 30,
      length: 30,
      scenesPerPass: 1,
      lookSide: 'both',
      sar: false,
    },
    {
      ...base,
      name: 'サンプルSAR衛星',
      id: 'SAMPLE-SAR',
      tle1: '1 90002U 26902A   26280.50000000  .00000100  00000-0  40000-4 0  9992',
      tle2: '2 90002  98.1800 283.0000 0001300  90.0000 270.0000 14.59200000    16',
      maxOffNadir: 45,
      minOffNadir: 20,
      swath: 50,
      length: 50,
      scenesPerPass: 1,
      lookSide: 'right',
      sar: true,
    },
  ];
}

// --- Geometry -------------------------------------------------------------------------------------------------

type Vec = [number, number, number];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec): Vec => {
  const n = norm(a);
  return [a[0] / n, a[1] / n, a[2] / n];
};
const deg = 180 / Math.PI;
const rad = Math.PI / 180;
/** Mean Earth radius, km. */
const R = 6371.0088;
const omega = 7.2921159e-5;
const e2 = 0.00669437999014;

/** Julian date of a time in milliseconds. */
const julian = (ms: number) => ms / 86400000 + 2440587.5;
/** Milliseconds of a Julian date. */
const msOf = (jd: number) => (jd - 2440587.5) * 86400000;

/** A place on the WGS 84 ellipsoid as an ECEF vector (km). */
function ecefOf([lon, lat]: [number, number]): Vec {
  const p = geodeticToEcf({ longitude: lon * rad, latitude: lat * rad, height: 0 });
  return [p.x, p.y, p.z];
}

/** The geodetic up direction at a place. */
function upOf([lon, lat]: [number, number]): Vec {
  return [Math.cos(lat * rad) * Math.cos(lon * rad), Math.cos(lat * rad) * Math.sin(lon * rad), Math.sin(lat * rad)];
}

/** Longitude and geodetic latitude of a direction from the Earth's centre (a point on the ellipsoid's surface). */
function lonLatOf(p: Vec): [number, number] {
  const lon = Math.atan2(p[1], p[0]) * deg;
  const geocentric = Math.atan2(p[2], Math.hypot(p[0], p[1]));
  return [lon, Math.atan(Math.tan(geocentric) / (1 - e2)) * deg];
}

/** Position and velocity of a satellite in ECEF (km, km/s) at a time, with whether it moves north; null when SGP4 fails. */
function stateAt(satrec: SatRec, ms: number): { r: Vec; v: Vec; north: boolean; gmst: number; eci: Vec } | null {
  const jd = julian(ms);
  const pv = sgp4(satrec, (jd - satrec.jdsatepoch) * 1440);
  if (!pv || typeof pv.position !== 'object' || !Number.isFinite(pv.position.x)) return null;
  const gmst = gstime(jd);
  const p = eciToEcf(pv.position, gmst);
  const vr = eciToEcf(pv.velocity, gmst);
  const r: Vec = [p.x, p.y, p.z];
  // The Earth turns under the satellite: v_ecef = R·v_eci − ω × r.
  const v: Vec = [vr.x + omega * r[1], vr.y - omega * r[0], vr.z];
  return { r, v, north: pv.velocity.z > 0, gmst, eci: [pv.position.x, pv.position.y, pv.position.z] };
}

/** Elevation of the Sun at a place, in degrees. */
export function sunElevation(lonLat: [number, number], ms: number): number {
  const jd = julian(ms);
  const s = sunPos(jd).rsun;
  const e = eciToEcf(s, gstime(jd));
  return Math.asin(dot(unit([e.x, e.y, e.z]), upOf(lonLat))) * deg;
}

/** Off-nadir angle (degrees) of a point `centralAngle` radians away from the sub-satellite point, from `distance` km from the centre. */
function offNadirFor(centralAngle: number, distance: number): number {
  return Math.atan2(R * Math.sin(centralAngle), distance - R * Math.cos(centralAngle)) * deg;
}

/** Ground distance (km) from the sub-satellite point at which a satellite `distance` km from the centre looks `offNadir` degrees off nadir (the horizon when it cannot). */
export function groundRange(offNadir: number, distance: number): number {
  const s = (distance / R) * Math.sin(offNadir * rad);
  const lambda = s >= 1 ? Math.acos(R / distance) : Math.asin(s) - offNadir * rad;
  return R * lambda;
}

// --- Planning -------------------------------------------------------------------------------------------------

/** A place or area to plan for. Coordinates are longitude, latitude (WGS 84). */
export interface PlanTarget {
  label: string;
  /** Where the satellite is aimed: a point, or the middle of an area. */
  center: [number, number];
  /** Points spread over the area (its vertices), for how wide it is across the track; empty for a point. */
  points: Array<[number, number]>;
  /**
   * Points spread evenly inside the area (a grid in a polygon), each
   * standing for an equal share of it: what passes cover is counted in
   * them. Absent or empty for a point, which is covered whole or not at all.
   */
  cells?: Array<[number, number]>;
}

export interface PlanOptions {
  /** Milliseconds since the epoch. */
  start: number;
  end: number;
  /** A tighter limit on the off-nadir angle than the satellites' own (for better pictures); null for none. */
  maxOffNadir: number | null;
  /** `optical`: satellites that are not SAR only in daylight. `none`: day and night. */
  daylight: 'optical' | 'none';
  /** The lowest Sun elevation that counts as daylight, degrees. */
  minSunElevation: number;
  /** Seconds between the coarse samples of each orbit (60 by default). */
  step?: number;
}

/** One chance to take a picture. */
export interface Opportunity {
  /** Index into the satellites planned. */
  satellite: number;
  /** Index into the targets. */
  target: number;
  /** The moment of closest approach, ms since the epoch. */
  time: number;
  /** Off-nadir angle the satellite looks at (the middle of its scenes for an area), degrees. */
  offNadir: number;
  /** Angle between the line of sight and the vertical on the ground, degrees. */
  incidence: number;
  /** Elevation of the satellite seen from the ground, degrees. */
  elevation: number;
  side: 'left' | 'right';
  /** Whether the satellite moves north (an ascending pass). */
  ascending: boolean;
  /** At the target's middle, degrees. */
  sunElevation: number;
  /** Distance from the satellite to where it looks, km. */
  range: number;
  /** How wide the area is across the track, km (0 for a point). */
  width: number;
  /** Scenes side by side needed to cover it all from this pass. */
  strips: number;
  /** Share of the area (0–1) the scenes this pass takes cover; 1 for a point. */
  coverage: number;
  /** Where the scenes are across the track: from and to, radians in the orbit's frame (left positive). */
  window: [number, number];
  /**
   * For an area: how far across the track each of its cells is (radians,
   * left positive), NaN where the satellite cannot look; for choosing
   * scenes again when passes are combined.
   */
  cells?: Float32Array;
  /** In a combination ({@link coverPlan}): share newly covered by this pass, and covered so far. */
  gain?: number;
  cumulative?: number;
  /** Days between the TLE's epoch and this moment. */
  tleAge: number;
  /** The satellite's distance from the Earth's centre, km (for looking elsewhere across the track). */
  orbitRadius: number;
}

export interface PlanResult {
  opportunities: Opportunity[];
  /** Satellites that could not be planned, and why. */
  problems: string[];
}

/** The satrec of a satellite; a problem when its TLE does not read. */
export function satrecOf(sat: SatelliteSpec): SatRec | string {
  try {
    const satrec = twoline2satrec(sat.tle1, sat.tle2);
    if (satrec.error || !Number.isFinite(satrec.no) || satrec.no <= 0) return `${sat.name}: TLE を読めません`;
    return satrec;
  } catch {
    return `${sat.name}: TLE を読めません`;
  }
}

/** The epoch of a satellite's TLE, ms since the epoch; NaN when the TLE does not read. */
export function tleEpoch(sat: SatelliteSpec): number {
  const satrec = satrecOf(sat);
  return typeof satrec === 'string' ? Number.NaN : msOf(satrec.jdsatepoch);
}

/** A target ready for the inner loop. */
interface Prepared {
  r: Vec;
  up: Vec;
  /** Unit vectors of the area's points. */
  points: Vec[];
  /** Unit vectors of the area's cells (empty for a point). */
  cells: Vec[];
  /** The largest angle (radians) between the middle and the area's points: how far it reaches from its middle. */
  radius: number;
}

function prepare(t: PlanTarget): Prepared {
  const r = ecefOf(t.center);
  const middle = unit(r);
  const points = t.points.map((p) => unit(ecefOf(p)));
  const cells = (t.cells ?? []).map((p) => unit(ecefOf(p)));
  let radius = 0;
  for (const p of [...points, ...cells]) radius = Math.max(radius, Math.acos(Math.min(1, dot(p, middle))));
  return { r, up: upOf(t.center), points, cells, radius };
}

/** How an orbit sees a target at one moment. */
function look(state: { r: Vec; v: Vec }, t: Prepared) {
  const d = sub(t.r, state.r);
  const range = norm(d);
  const nadir = unit([-state.r[0], -state.r[1], -state.r[2]]);
  const cosOff = dot(nadir, d) / range;
  const elevation = Math.asin(-dot(d, t.up) / range) * deg;
  return { cosOff, elevation, range, d };
}

/**
 * Every opportunity of the satellites over the targets between
 * `options.start` and `options.end`, in time order. `onProgress` is told the
 * share done (0–1) after each satellite.
 */
export function planAccess(sats: SatelliteSpec[], targets: PlanTarget[], options: PlanOptions, onProgress?: (done: number) => void): PlanResult {
  const problems: string[] = [];
  const opportunities: Opportunity[] = [];
  const step = (options.step ?? 60) * 1000;
  const count = Math.max(2, Math.ceil((options.end - options.start) / step) + 1);
  const prepared = targets.map(prepare);
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const zs = new Float64Array(count);
  const ns = new Float64Array(count * 3);

  sats.forEach((sat, s) => {
    const satrec = satrecOf(sat);
    if (typeof satrec === 'string') {
      problems.push(satrec);
      onProgress?.((s + 1) / sats.length);
      return;
    }
    const limit = Math.min(sat.maxOffNadir, options.maxOffNadir ?? Infinity);
    if (limit < sat.minOffNadir) {
      onProgress?.((s + 1) / sats.length);
      return;
    }
    const epoch = msOf(satrec.jdsatepoch);
    let failed = 0;
    for (let k = 0; k < count; k++) {
      const st = stateAt(satrec, options.start + k * step);
      if (!st) {
        xs[k] = Number.NaN;
        failed++;
        continue;
      }
      [xs[k], ys[k], zs[k]] = st.r;
      const n = unit(cross(st.r, st.v));
      ns.set(n, k * 3);
    }
    if (failed === count) {
      problems.push(`${sat.name}: 軌道を計算できません（TLE が古すぎるか、落下済みの可能性があります）`);
      onProgress?.((s + 1) / sats.length);
      return;
    }

    prepared.forEach((t, ti) => {
      // cos of the off-nadir angle at each sample, or −2 where the target is below the horizon.
      const c = (k: number) => {
        if (k < 0 || k >= count || Number.isNaN(xs[k])) return -2;
        const r: Vec = [xs[k], ys[k], zs[k]];
        const v = look({ r, v: [0, 0, 0] }, t);
        return v.elevation > 0 ? v.cosOff : -2;
      };
      let prev = -2;
      let here = c(0);
      for (let k = 0; k < count; k++) {
        const next = c(k + 1);
        if (here > -2 && here >= prev && here > next) {
          // Cheap test before refining: the target's distance from the orbit's plane (less how far
          // the area reaches) bounds the smallest angle of the pass.
          const r: Vec = [xs[k], ys[k], zs[k]];
          const n: Vec = [ns[k * 3], ns[k * 3 + 1], ns[k * 3 + 2]];
          const across = Math.abs(Math.asin(Math.max(-1, Math.min(1, dot(unit(t.r), n)))));
          if (offNadirFor(Math.max(0, across - t.radius), norm(r)) <= limit + 1) {
            const found = refine(satrec, t, options.start + (k - 1) * step, options.start + (k + 1) * step);
            if (found) {
              const op = judge(sat, s, ti, t, found, limit, options, epoch);
              if (op) opportunities.push(op);
            }
          }
        }
        prev = here;
        here = next;
      }
    });
    onProgress?.((s + 1) / sats.length);
  });
  opportunities.sort((a, b) => a.time - b.time);
  return { opportunities, problems };
}

/** The moment between `a` and `b` with the smallest off-nadir angle to the target (golden-section search). */
function refine(satrec: SatRec, t: Prepared, a: number, b: number): number | null {
  const g = (Math.sqrt(5) - 1) / 2;
  const f = (ms: number) => {
    const st = stateAt(satrec, ms);
    return st ? look(st, t).cosOff : -2;
  };
  let x1 = b - g * (b - a);
  let x2 = a + g * (b - a);
  let f1 = f(x1);
  let f2 = f(x2);
  while (b - a > 50) {
    if (f1 > f2) {
      b = x2;
      x2 = x1;
      f2 = f1;
      x1 = b - g * (b - a);
      f1 = f(x1);
    } else {
      a = x1;
      x1 = x2;
      f1 = f2;
      x2 = a + g * (b - a);
      f2 = f(x2);
    }
  }
  const best = Math.round((a + b) / 2);
  return f(best) > -2 ? best : null;
}

/**
 * Where to put `width` radians of scenes across the track so they take the
 * most cells: `across` holds each cell's angle (NaN where it cannot be seen)
 * and `open` says which still count. The scenes are centred on the cells they take.
 */
export function bestWindow(across: ArrayLike<number>, width: number, open?: (i: number) => boolean): { count: number; window: [number, number] } | null {
  const xs: number[] = [];
  for (let i = 0; i < across.length; i++) if (!Number.isNaN(across[i]) && (!open || open(i))) xs.push(across[i]);
  if (!xs.length) return null;
  xs.sort((a, b) => a - b);
  let best = 0;
  let from = 0;
  for (let i = 0, j = 0; i < xs.length; i++) {
    while (xs[i] - xs[j] > width) j++;
    if (i - j + 1 > best) {
      best = i - j + 1;
      from = j;
    }
  }
  const mid = (xs[from] + xs[from + best - 1]) / 2;
  return { count: best, window: [mid - width / 2, mid + width / 2] };
}

/** Looking `x` radians across the track from `distance` km: the off-nadir angle, incidence, elevation (degrees) and range (km). */
function lookAt(x: number, distance: number) {
  const lambda = Math.abs(x);
  const offNadir = offNadirFor(lambda, distance);
  const incidence = offNadir + lambda * deg;
  const range = Math.hypot(R * Math.sin(lambda), distance - R * Math.cos(lambda));
  return { offNadir, incidence, elevation: 90 - incidence, range };
}

/** The opportunity at `time`, or null when the satellite cannot take it. */
function judge(sat: SatelliteSpec, s: number, ti: number, t: Prepared, time: number, limit: number, options: PlanOptions, epoch: number): Opportunity | null {
  const satrec = satrecOf(sat) as SatRec;
  const st = stateAt(satrec, time)!;
  const center = lonLatOf(t.r);
  const sun = sunElevation(center, time);
  if (options.daylight === 'optical' && !sat.sar && sun < options.minSunElevation) return null;
  const f = frameOf(st);
  const distance = norm(st.r);
  const { width } = spread(st, t);
  const sw = (sat.swath / R) * sat.scenesPerPass;
  const common = {
    satellite: s,
    target: ti,
    time,
    ascending: st.north,
    sunElevation: sun,
    width,
    strips: width > 0 ? Math.max(1, Math.ceil(width / sat.swath - 1e-9)) : 1,
    tleAge: (time - epoch) / 86400000,
    orbitRadius: distance,
  };

  if (!t.cells.length) {
    // A point: the angle to it at closest approach.
    const { cosOff, elevation, range, d } = look(st, t);
    if (elevation <= 0) return null;
    const offNadir = Math.acos(Math.min(1, cosOff)) * deg;
    if (offNadir > limit || offNadir < sat.minOffNadir) return null;
    const side = dot(d, f.n) > 0 ? 'left' : 'right';
    if (sat.lookSide !== 'both' && sat.lookSide !== side) return null;
    const x = trackAngles(unit(t.r), f)[0];
    return { ...common, offNadir, incidence: 90 - elevation, elevation, side, range, coverage: 1, window: [x - sw / 2, x + sw / 2] };
  }

  // An area: the cells within reach (on a side it looks to, between its smallest and largest angles), and the
  // scenes placed over as many of them as they can take.
  const near = sat.minOffNadir > 0 ? groundRange(sat.minOffNadir, distance) / R : 0;
  const far = groundRange(limit, distance) / R;
  const across = new Float32Array(t.cells.length);
  t.cells.forEach((p, i) => {
    const x = trackAngles(p, f)[0];
    const ok = Math.abs(x) >= near && Math.abs(x) <= far && (sat.lookSide === 'both' || (x > 0) === (sat.lookSide === 'left'));
    across[i] = ok ? x : Number.NaN;
  });
  const best = bestWindow(across, sw);
  if (!best) return null;
  const mid = (best.window[0] + best.window[1]) / 2;
  return {
    ...common,
    ...lookAt(mid, distance),
    side: mid > 0 ? 'left' : 'right',
    coverage: best.count / t.cells.length,
    window: best.window,
    cells: across,
  };
}

/** One target's combination of passes. */
export interface CoverPlan {
  target: number;
  /** The passes taken, in time order, with what each adds (`gain`) and the total so far (`cumulative`). */
  steps: Opportunity[];
  /** Share covered in the end (0–1). */
  coverage: number;
  /** When the goal is reached; null when the passes found do not reach it. */
  done: number | null;
  /** Passes that would have helped but were skipped because the satellite was still busy (its interval or daily limit). */
  blocked: number;
}

/**
 * Strings passes (of any satellite) together to cover the targets, earliest
 * first: going through the opportunities in time order, a pass is taken when
 * its scenes, placed over what is still uncovered, add at least `minGain` of
 * an area, until `goal` of it is covered; a point needs just one pass. The
 * targets share the satellites, so a shot is only taken when its satellite
 * is free: `minInterval` minutes after its last shot (of any target), and
 * fewer than `maxPerDay` shots in the 24 hours before.
 */
export function coverPlan(opportunities: Opportunity[], targets: PlanTarget[], sats: SatelliteSpec[], goal = 0.95, minGain = 0.02): CoverPlan[] {
  const plans: CoverPlan[] = targets.map((_, ti) => ({ target: ti, steps: [], coverage: 0, done: null, blocked: 0 }));
  const covered = targets.map((t) => new Uint8Array(t.cells?.length ?? 0));
  const totals = targets.map(() => 0);
  const shots = sats.map(() => [] as number[]);
  const busy = (s: number, time: number) => {
    const sat = sats[s];
    const taken = shots[s];
    const last = taken[taken.length - 1];
    if (last !== undefined && sat.minInterval > 0 && time - last < sat.minInterval * 60000) return true;
    return sat.maxPerDay > 0 && taken.filter((t) => time - t < 86400000).length >= sat.maxPerDay;
  };
  for (const op of [...opportunities].sort((a, b) => a.time - b.time)) {
    const plan = plans[op.target];
    if (!plan || plan.done !== null) continue;
    const n = covered[op.target].length;
    const sat = sats[op.satellite];
    if (!n) {
      if (busy(op.satellite, op.time)) {
        plan.blocked++;
        continue;
      }
      shots[op.satellite].push(op.time);
      plan.steps.push({ ...op, gain: 1, cumulative: 1 });
      plan.coverage = 1;
      plan.done = op.time;
      continue;
    }
    if (!op.cells || !sat) continue;
    const cov = covered[op.target];
    const best = bestWindow(op.cells, (sat.swath / R) * sat.scenesPerPass, (i) => !cov[i]);
    if (!best || best.count / n < Math.min(minGain, goal - totals[op.target] / n - 1e-9)) continue;
    if (busy(op.satellite, op.time)) {
      plan.blocked++;
      continue;
    }
    const [a, b] = best.window;
    let gain = 0;
    op.cells.forEach((x, i) => {
      if (!cov[i] && x >= a && x <= b) {
        cov[i] = 1;
        gain++;
      }
    });
    shots[op.satellite].push(op.time);
    totals[op.target] += gain;
    const total = totals[op.target] / n;
    const mid = (a + b) / 2;
    plan.steps.push({ ...op, window: best.window, ...lookAt(mid, op.orbitRadius), side: mid > 0 ? 'left' : 'right', gain: gain / n, cumulative: total });
    plan.coverage = total;
    if (total >= goal) plan.done = op.time;
  }
  return plans;
}

/** The orbit's frame at a moment: the normal of its plane, along the track, and up. */
function frameOf(st: { r: Vec; v: Vec }) {
  const n = unit(cross(st.r, st.v));
  const a = unit(cross(n, st.r));
  const w = cross(a, n);
  return { n, a, w };
}

/** The angles (radians) of a point across the track (left positive) and along it. */
function trackAngles(p: Vec, f: { n: Vec; a: Vec; w: Vec }): [number, number] {
  return [Math.asin(Math.max(-1, Math.min(1, dot(p, f.n)))), Math.atan2(dot(p, f.a), dot(p, f.w))];
}

/** How far an area reaches across and along the track (angles, radians, and width in km). */
function spread(st: { r: Vec; v: Vec }, t: Prepared) {
  const f = frameOf(st);
  const all = [unit(t.r), ...t.points, ...t.cells].map((p) => trackAngles(p, f));
  const across = all.map((x) => x[0]);
  const along = all.map((x) => x[1]);
  const [x0, x1] = [Math.min(...across), Math.max(...across)];
  const [y0, y1] = [Math.min(...along), Math.max(...along)];
  return { frame: f, x0, x1, y0, y1, width: (x1 - x0) * R };
}

/** What a pass looks like on the ground. Coordinates are longitude, latitude. */
export interface PassShapes {
  /** The sub-satellite track around the moment. */
  track: Array<[number, number]>;
  /** The edges of what the satellite can reach (its largest off-nadir angle), one line per side it can look to. */
  reach: Array<Array<[number, number]>>;
  /** The scenes the pass takes, side by side. */
  scenes: Array<Array<[number, number]>>;
  /** Where the satellite is at the moment. */
  position: [number, number];
}

/** The ground track, reach and scenes of an opportunity (`minutes` before and after it). */
export function passShapes(sat: SatelliteSpec, target: PlanTarget, op: Opportunity, minutes = 5): PassShapes | null {
  const satrec = satrecOf(sat);
  if (typeof satrec === 'string') return null;
  const t = prepare(target);
  const track: Array<[number, number]> = [];
  const sides = (sat.lookSide === 'both' ? ['left', 'right'] : [sat.lookSide]) as Array<'left' | 'right'>;
  const reach: Array<Array<[number, number]>> = sides.map(() => []);
  for (let s = -minutes * 60; s <= minutes * 60; s += 10) {
    const st = stateAt(satrec, op.time + s * 1000);
    if (!st) continue;
    const g = eciToGeodetic({ x: st.eci[0], y: st.eci[1], z: st.eci[2] }, st.gmst);
    track.push([g.longitude * deg, g.latitude * deg]);
    // The reach lines: turned about the track, as far across as the largest angle reaches.
    const f = frameOf(st);
    const lambda = groundRange(sat.maxOffNadir, norm(st.r)) / R;
    sides.forEach((side, i) => {
      const x = side === 'left' ? lambda : -lambda;
      reach[i].push(lonLatOf(pointAt(f, x, 0)));
    });
  }
  const st = stateAt(satrec, op.time)!;
  const g = eciToGeodetic({ x: st.eci[0], y: st.eci[1], z: st.eci[2] }, st.gmst);
  const { frame, y0, y1 } = spread(st, t);
  const sw = sat.swath / R;
  const [start, end] = op.window;
  const count = Math.max(1, Math.round((end - start) / sw));
  const half = Math.max(sat.length / R, y1 - y0) / 2;
  const mid = (y0 + y1) / 2;
  const scenes: Array<Array<[number, number]>> = [];
  for (let j = 0; j < count; j++) {
    const a = start + j * sw;
    const b = a + sw;
    const ring: Array<[number, number]> = [];
    // Each edge in a few pieces, so long scenes follow the curve of the track.
    const edge = (x: number, from: number, to: number) => {
      for (let i = 0; i <= 4; i++) ring.push(lonLatOf(pointAt(frame, x, from + ((to - from) * i) / 4)));
    };
    edge(a, mid - half, mid + half);
    edge(b, mid + half, mid - half);
    ring.push(ring[0]);
    scenes.push(ring);
  }
  return { track, reach, scenes, position: [g.longitude * deg, g.latitude * deg] };
}

/** The point `x` radians across the track and `y` along it, in an orbit's frame. */
function pointAt(f: { n: Vec; a: Vec; w: Vec }, x: number, y: number): Vec {
  const c = Math.cos(x);
  return [
    Math.sin(x) * f.n[0] + c * (Math.cos(y) * f.w[0] + Math.sin(y) * f.a[0]),
    Math.sin(x) * f.n[1] + c * (Math.cos(y) * f.w[1] + Math.sin(y) * f.a[1]),
    Math.sin(x) * f.n[2] + c * (Math.cos(y) * f.w[2] + Math.sin(y) * f.a[2]),
  ];
}

/** Where a satellite is at a moment (longitude, latitude), for tests and the map. */
export function subSatellitePoint(sat: SatelliteSpec, ms: number): [number, number] | null {
  const satrec = satrecOf(sat);
  if (typeof satrec === 'string') return null;
  const st = stateAt(satrec, ms);
  if (!st) return null;
  const g = eciToGeodetic({ x: st.eci[0], y: st.eci[1], z: st.eci[2] }, st.gmst);
  return [g.longitude * deg, g.latitude * deg];
}
