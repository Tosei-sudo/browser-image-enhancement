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
 * takes the scenes it can (`scenesPerPass` one after another along the pass) where they cover the
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
  /** How many scenes one after another along the pass one pass can take (consecutive shots). */
  scenesPerPass?: string;
  /** Minutes the satellite needs after one shot before the next (turning, cooling, downlink); 0 or empty for none. */
  minInterval?: string;
  /** Most shots it can take in 24 hours (power, memory); 0 or empty for no limit. */
  maxPerDay?: string;
  /** The series (a family of satellites, like SkySat or ICEYE) for grouping; read from the name when absent. */
  series?: string;
  /** Hours ahead an order must be placed: shots sooner than that cannot be ordered; 0 or empty for none. */
  leadTime?: string;
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
  /** Hours ahead an order must be placed (0: none). */
  leadTime: number;
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
export const builtInDefaults: SatelliteDefaults = { maxOffNadir: 30, minOffNadir: 0, swath: 10, scenesPerPass: 1, minInterval: 0, maxPerDay: 0, leadTime: 0 };
const defaultSar = /SAR|radar|レーダ/i;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isName = (value: unknown): value is string => typeof value === 'string' && /^[\w.]+$/.test(value);
const isUrl = (url: unknown): url is string => typeof url === 'string' && /^(https?:)?\/\/|^\.{0,2}\//.test(url);
const roles = ['name', 'id', 'tle', 'tle1', 'tle2', 'maxOffNadir', 'minOffNadir', 'swath', 'length', 'lookSide', 'kind', 'scenesPerPass', 'minInterval', 'maxPerDay', 'series', 'leadTime'] as const;

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
    for (const key of ['maxOffNadir', 'minOffNadir', 'swath', 'scenesPerPass', 'minInterval', 'maxPerDay', 'leadTime'] as const) {
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
  /** Hours ahead an order must be placed (0: none). */
  leadTime: number;
  /** The family it belongs to, for grouping (SkySat, ICEYE …). */
  series: string;
  lookSide: LookSide;
  sar: boolean;
  /** Where it came from (the catalog's label, or 「貼り付け」). */
  source: string;
}

/**
 * The series a satellite's name suggests: the name without its number at
 * the end (`SkySat-C12` → `SkySat`, `ICEYE-X27` → `ICEYE`, `WorldView-3` →
 * `WorldView`); the whole name when nothing is left.
 */
export function seriesOf(name: string): string {
  const base = name
    .replace(/\s*\(.*\)\s*$/, '')
    .replace(/[\s\-_]*[A-Za-z]?\d+[A-Za-z]?$/, '')
    .replace(/[\s\-_]+$/, '')
    .trim();
  return base || name.trim() || '—';
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
    leadTime: Math.max(0, numberOf(get(fields.leadTime)) ?? defaults.leadTime),
    series: String(get(fields.series) ?? '').trim() || seriesOf(name),
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
      leadTime: Math.max(0, spec.leadTime ?? 0),
      series: seriesOf(name),
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
  const base = { minOffNadir: 0, minInterval: 0, maxPerDay: 0, leadTime: 0, series: 'サンプル', source: SAMPLE_SOURCE };
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
// Not Math.hypot: it is several times slower, and the plan computes millions of these.
const norm = (a: Vec) => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
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
  return sunAngles(lonLat, ms).elevation;
}

/** Where the Sun is seen from a place: elevation above the horizon and azimuth clockwise from north, in degrees. */
export function sunAngles([lon, lat]: [number, number], ms: number): { elevation: number; azimuth: number } {
  const jd = julian(ms);
  const s = sunPos(jd).rsun;
  const e = eciToEcf(s, gstime(jd));
  const toSun = unit([e.x, e.y, e.z]);
  const east: Vec = [-Math.sin(lon * rad), Math.cos(lon * rad), 0];
  const north: Vec = [-Math.sin(lat * rad) * Math.cos(lon * rad), -Math.sin(lat * rad) * Math.sin(lon * rad), Math.cos(lat * rad)];
  const elevation = Math.asin(dot(toSun, upOf([lon, lat]))) * deg;
  const azimuth = (Math.atan2(dot(toSun, east), dot(toSun, north)) * deg + 360) % 360;
  return { elevation, azimuth };
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
  /**
   * How much the target matters (larger first; from an attribute of its
   * feature). In a combination, more important targets get the satellites'
   * shots first; absent counts as the least important.
   */
  priority?: number;
  /** How the priority reads (the attribute's value), for lists. */
  priorityText?: string;
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
  /**
   * The moment the plan is made (ms since the epoch): a shot of a satellite
   * with a `leadTime` is only an opportunity when it can still be ordered,
   * that many hours after this. Absent: lead times are not checked.
   */
  now?: number;
  /** The smallest and largest incidence angle (degrees) a shot may have; absent or null for no limit. */
  minIncidence?: number | null;
  maxIncidence?: number | null;
  /** Only passes going this way (`ascending`: north); absent or null for both. */
  pass?: 'ascending' | 'descending' | null;
  /** Only shots looking to this side of the track; absent or null for both. */
  side?: 'left' | 'right' | null;
  /** Ground stations: each opportunity is told when the satellite next comes over one of them (to send its pictures down). */
  stations?: GroundStation[];
}

/** A ground station of config.json's `groundStations`: where the satellites send their pictures down. */
export interface GroundStation {
  name: string;
  lon: number;
  lat: number;
  /** The lowest elevation (degrees) at which it can receive; 5 when absent. */
  minElevation: number;
}

/** The ground stations of `config.json`'s `groundStations`, each checked on its own (problems say what was left out). */
export function groundStationsOf(value: unknown, problems: string[]): GroundStation[] {
  if (!Array.isArray(value)) return (problems.push('groundStations が配列ではありません'), []);
  return value.flatMap((v, i) => {
    const at = `groundStations[${i}]`;
    if (!isRecord(v)) return (problems.push(`${at} がオブジェクトではありません`), []);
    const { name, lon, lat, minElevation } = v;
    if (typeof lon !== 'number' || typeof lat !== 'number' || Math.abs(lat) > 90 || Math.abs(lon) > 180) return (problems.push(`${at} の lon・lat は経度・緯度の数にしてください`), []);
    const min = typeof minElevation === 'number' && minElevation >= 0 && minElevation < 90 ? minElevation : 5;
    if (minElevation !== undefined && min !== minElevation) problems.push(`${at} の minElevation は 0〜90 の数にしてください`);
    return [{ name: typeof name === 'string' && name ? name : `地上局 ${i + 1}`, lon, lat, minElevation: min }];
  });
}

/** The side a satellite may look to under `options`: its own sides narrowed to the one asked for; null when none is left. */
export function sideFor(sat: SatelliteSpec, options: Pick<PlanOptions, 'side'>): LookSide | null {
  if (!options.side) return sat.lookSide;
  return sat.lookSide === 'both' || sat.lookSide === options.side ? options.side : null;
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
  /** How long the area is along the track, km (0 for a point). */
  length: number;
  /** Scenes one after another along the track (each the satellite's scene length) needed to cover that length. */
  frames: number;
  /** Share of the area (0–1) the scenes this pass takes cover; 1 for a point. */
  coverage: number;
  /** Where the scenes are across the track: from and to, radians in the orbit's frame (left positive). */
  window: [number, number];
  /**
   * Where the scenes are along the track: from and to, radians in the orbit's
   * frame at `time` (forward positive); a whole number of scene lengths, at
   * most `scenesPerPass` of them.
   */
  along: [number, number];
  /** For an area: how far along the track each of its cells is (radians, as `along`). */
  cellsAlong?: Float32Array;
  /**
   * For an area: how far across the track each of its cells is (radians,
   * left positive), NaN where the satellite cannot look; for choosing
   * scenes again when passes are combined.
   */
  cells?: Float32Array;
  /** In a combination ({@link coverPlan}): share newly covered by this pass, and covered so far. */
  gain?: number;
  cumulative?: number;
  /**
   * In a combination: the shot this belongs to (numbered from 1 in time
   * order); points that one scene takes together share it.
   */
  shot?: number;
  /** The points one shared scene takes (1 when the scene is this target's alone). */
  shotTargets?: number;
  /** For a scene shared by several points: from and to along the track, as the moments the satellite passes them (ms). */
  scene?: [number, number];
  /** Days between the TLE's epoch and this moment. */
  tleAge: number;
  /** Whether its scenes were moved by hand ({@link shiftScene}). */
  adjusted?: boolean;
  /**
   * With ground stations: when the satellite next comes over one of them
   * after the shot (at once when it is over one already), and which; absent
   * when none comes within a day.
   */
  downlink?: { time: number; station: number };
  /** The cloud cover forecast for the shot, percent (filled in by the panel for optical satellites). */
  cloud?: number;
  /** The satellite's distance from the Earth's centre, km (for looking elsewhere across the track). */
  orbitRadius: number;
}

export interface PlanResult {
  opportunities: Opportunity[];
  /** Satellites that could not be planned, and why. */
  problems: string[];
  /** Opportunities left out because they are too soon to order (within their satellite's lead time). */
  tooSoon: number;
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

/** The Earth's polar radius (km): no place on the ellipsoid is nearer the centre, so none sees further to the horizon. */
const POLAR_RADIUS = 6356.752;
/** Slack (radians) on the horizon test of a group of targets, for the up direction leaning off the radius (≤ 0.2°). */
const HORIZON_MARGIN = 0.5 * (Math.PI / 180);
/** Size (degrees of latitude and longitude) of the cells that group targets for the horizon test. */
const GROUP_CELL = 4;

/**
 * Groups targets that lie close together: each group's middle direction and
 * the angle (radians) it reaches from there, with the area of its targets.
 */
function groupTargets(prepared: Prepared[]): { groups: Array<{ direction: Vec; radius: number }>; groupOf: Int32Array } {
  const keys = new Map<string, number[]>();
  prepared.forEach((t, i) => {
    const [lon, lat] = lonLatOf(t.r);
    const key = `${Math.floor(lat / GROUP_CELL)},${Math.floor(lon / GROUP_CELL)}`;
    const list = keys.get(key);
    if (list) list.push(i);
    else keys.set(key, [i]);
  });
  const groupOf = new Int32Array(prepared.length);
  const groups = [...keys.values()].map((members, g) => {
    const sum: Vec = [0, 0, 0];
    for (const i of members) {
      const u = unit(prepared[i].r);
      for (let j = 0; j < 3; j++) sum[j] += u[j];
      groupOf[i] = g;
    }
    const direction = norm(sum) > 0 ? unit(sum) : unit(prepared[members[0]].r);
    let radius = 0;
    for (const i of members) radius = Math.max(radius, Math.acos(Math.max(-1, Math.min(1, dot(unit(prepared[i].r), direction)))) + prepared[i].radius);
    return { direction, radius };
  });
  return { groups, groupOf };
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
  let tooSoon = 0;
  const opportunities: Opportunity[] = [];
  const step = (options.step ?? 60) * 1000;
  const count = Math.max(2, Math.ceil((options.end - options.start) / step) + 1);
  const prepared = targets.map(prepare);
  const { groups, groupOf } = groupTargets(prepared);
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const zs = new Float64Array(count);
  const rs = new Float64Array(count);
  const ns = new Float64Array(count * 3);
  const vs = new Float64Array(count * 3);
  // Between samples the orbit is a cubic (Hermite) curve through their positions and velocities: within a metre of
  // SGP4 for a step of a minute or so, and much cheaper, so the search for each pass's closest moment uses it.
  const smooth = step <= 120000;
  const between = (ms: number): Vec | null => {
    const u = (ms - options.start) / step;
    const k = Math.min(count - 2, Math.max(0, Math.floor(u)));
    if (Number.isNaN(xs[k]) || Number.isNaN(xs[k + 1])) return null;
    const f = u - k;
    const h = step / 1000;
    const h00 = (1 + 2 * f) * (1 - f) * (1 - f);
    const h10 = f * (1 - f) * (1 - f) * h;
    const h01 = f * f * (3 - 2 * f);
    const h11 = f * f * (f - 1) * h;
    const v = k * 3;
    return [
      h00 * xs[k] + h10 * vs[v] + h01 * xs[k + 1] + h11 * vs[v + 3],
      h00 * ys[k] + h10 * vs[v + 1] + h01 * ys[k + 1] + h11 * vs[v + 4],
      h00 * zs[k] + h10 * vs[v + 2] + h01 * zs[k + 1] + h11 * vs[v + 5],
    ];
  };

  sats.forEach((sat, s) => {
    const satrec = satrecOf(sat);
    if (typeof satrec === 'string') {
      problems.push(satrec);
      onProgress?.((s + 1) / sats.length);
      return;
    }
    const limit = Math.min(sat.maxOffNadir, options.maxOffNadir ?? Infinity);
    if (limit < sat.minOffNadir || !sideFor(sat, options)) {
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
      rs[k] = norm(st.r);
      vs.set(st.v, k * 3);
      const n = unit(cross(st.r, st.v));
      ns.set(n, k * 3);
    }
    if (failed === count) {
      problems.push(`${sat.name}: 軌道を計算できません（TLE が古すぎるか、落下済みの可能性があります）`);
      onProgress?.((s + 1) / sats.length);
      return;
    }

    // The samples at which each group of targets may be above the horizon (with the samples either side), so
    // that each target only looks at those: a satellite is over a region for a few minutes of each orbit.
    let reach = 0;
    for (let k = 0; k < count; k++) if (rs[k] > POLAR_RADIUS) reach = Math.max(reach, Math.acos(POLAR_RADIUS / rs[k]));
    const ranges = groups.map((g) => {
      const cosine = Math.cos(Math.min(Math.PI, reach + g.radius + HORIZON_MARGIN));
      const [gx, gy, gz] = g.direction;
      const out: number[] = [];
      for (let k = 0; k < count; k++) {
        if (!(xs[k] * gx + ys[k] * gy + zs[k] * gz > cosine * rs[k])) continue;
        const from = Math.max(0, k - 1);
        let to = k + 1;
        while (to < count && xs[to] * gx + ys[to] * gy + zs[to] * gz > cosine * rs[to]) to++;
        const last = Math.min(count - 1, to);
        if (out.length && out[out.length - 1] >= from - 1) out[out.length - 1] = last;
        else out.push(from, last);
        k = to;
      }
      return out;
    });

    prepared.forEach((t, ti) => {
      // cos of the off-nadir angle at each sample, or −2 where the target is below the horizon (as look(), inline:
      // this runs for many samples of every satellite and target, so it allocates nothing and skips the square
      // root and division while the satellite is below the target's horizon).
      const [tx, ty, tz] = t.r;
      const [ux, uy, uz] = t.up;
      const level = tx * ux + ty * uy + tz * uz;
      const c = (k: number) => {
        if (k < 0 || k >= count) return -2;
        const x = xs[k];
        const y = ys[k];
        const z = zs[k];
        // Above the horizon: the satellite is higher than the target along its up direction (NaN fails too).
        if (!(x * ux + y * uy + z * uz > level)) return -2;
        const dx = tx - x;
        const dy = ty - y;
        const dz = tz - z;
        return -(x * dx + y * dy + z * dz) / (rs[k] * Math.sqrt(dx * dx + dy * dy + dz * dz));
      };
      const span = ranges[groupOf[ti]];
      for (let i = 0; i < span.length; i += 2) {
        let prev = c(span[i] - 1);
        let here = c(span[i]);
        for (let k = span[i]; k <= span[i + 1]; k++) {
          const next = c(k + 1);
          if (here > -2 && here >= prev && here > next) {
            // Cheap test before refining: the target's distance from the orbit's plane (less how far
            // the area reaches) bounds the smallest angle of the pass.
            const r: Vec = [xs[k], ys[k], zs[k]];
            const n: Vec = [ns[k * 3], ns[k * 3 + 1], ns[k * 3 + 2]];
            const across = Math.abs(Math.asin(Math.max(-1, Math.min(1, dot(unit(t.r), n)))));
            if (offNadirFor(Math.max(0, across - t.radius), norm(r)) <= limit + 1) {
              const a = options.start + (k - 1) * step;
              const b = options.start + (k + 1) * step;
              const position = smooth && k > 0 && k < count - 1 && !Number.isNaN(xs[k - 1]) && !Number.isNaN(xs[k + 1]) ? between : (ms: number) => stateAt(satrec, ms)?.r ?? null;
              const found = refine(position, t, a, b);
              if (found) {
                const op = judge(sat, satrec, s, ti, t, found, limit, options, epoch);
                if (op && sat.leadTime > 0 && options.now !== undefined && op.time - sat.leadTime * 3600000 < options.now) tooSoon++;
                else if (op) opportunities.push(op);
              }
            }
          }
          prev = here;
          here = next;
        }
      }
    });
    if (options.stations?.length) {
      const mine = opportunities.filter((op) => op.satellite === s);
      if (mine.length) addDownlinks(satrec, mine, options.stations);
    }
    onProgress?.((s + 1) / sats.length);
  });
  opportunities.sort((a, b) => a.time - b.time);
  return { opportunities, problems, tooSoon };
}

/** How long after a shot to look for a ground station. */
const DOWNLINK_WINDOW = 86400000;
/** Seconds between the samples of the search for ground stations. */
const DOWNLINK_STEP = 30;

/**
 * Tells each of a satellite's opportunities (`ops`, its own) when it next
 * comes over one of `stations`, high enough above its horizon: the moment it
 * rises there (to within a second), or the shot itself when it is over one
 * already.
 */
export function addDownlinks(satrec: SatRec, ops: Opportunity[], stations: readonly GroundStation[]): void {
  const sites = stations.map((g) => ({ r: ecefOf([g.lon, g.lat]), up: upOf([g.lon, g.lat]), sin: Math.sin(g.minElevation * rad) }));
  /** The first station in view at `ms`, or -1. */
  const inView = (ms: number): number => {
    const st = stateAt(satrec, ms);
    if (!st) return -1;
    for (let i = 0; i < sites.length; i++) {
      const d = sub(st.r, sites[i].r);
      if (dot(d, sites[i].up) / norm(d) >= sites[i].sin) return i;
    }
    return -1;
  };
  const sorted = [...ops].sort((a, b) => a.time - b.time);
  const step = DOWNLINK_STEP * 1000;
  // One sweep: the samples of the shots' windows, shared where shots are close together.
  const seen = new Map<number, number>();
  const sample = (ms: number) => {
    let v = seen.get(ms);
    if (v === undefined) seen.set(ms, (v = inView(ms)));
    return v;
  };
  for (const op of sorted) {
    if (sample(op.time) >= 0) {
      op.downlink = { time: op.time, station: sample(op.time) };
      continue;
    }
    const first = Math.ceil(op.time / step) * step;
    for (let t = first; t <= op.time + DOWNLINK_WINDOW; t += step) {
      const station = sample(t);
      if (station < 0) continue;
      // Rising between the sample before and this one.
      let a = Math.max(op.time, t - step);
      let b = t;
      while (b - a > 1000) {
        const m = Math.round((a + b) / 2);
        if (inView(m) >= 0) b = m;
        else a = m;
      }
      op.downlink = { time: b, station: inView(b) >= 0 ? inView(b) : station };
      break;
    }
  }
}

/** The moment between `a` and `b` with the smallest off-nadir angle to the target (golden-section search). */
function refine(position: (ms: number) => Vec | null, t: Prepared, a: number, b: number): number | null {
  const g = (Math.sqrt(5) - 1) / 2;
  const f = (ms: number) => {
    const r = position(ms);
    return r ? look({ r, v: [0, 0, 0] }, t).cosOff : -2;
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

/**
 * `count` scene lengths (`length`, radians) along the track over `from`–`to`:
 * as many as it takes to cover it, at most `most`, centred on it.
 */
function framed(from: number, to: number, length: number, most: number): [number, number] {
  const k = Math.min(most, Math.max(1, Math.ceil((to - from) / length - 1e-6)));
  const mid = (from + to) / 2;
  return [mid - (k * length) / 2, mid + (k * length) / 2];
}

/**
 * Where to put one pass's scenes, `width` across the track and up to `most`
 * scenes of `length` one after another along it, so they take the most
 * cells: `across` and `along` hold each cell's angles (across NaN where it
 * cannot be seen), `open` says which still count. The scenes are centred on
 * the cells they take.
 */
export function bestScene(
  across: ArrayLike<number>,
  along: ArrayLike<number>,
  width: number,
  length: number,
  most: number,
  open?: (i: number) => boolean,
): { count: number; window: [number, number]; along: [number, number]; members: number[] } | null {
  const idx: number[] = [];
  for (let i = 0; i < across.length; i++) if (!Number.isNaN(across[i]) && (!open || open(i))) idx.push(i);
  if (!idx.length) return null;
  idx.sort((a, b) => across[a] - across[b]);
  const reach = length * most;
  let best: number[] = [];
  for (let j = 0; j < idx.length; j++) {
    if (j > 0 && across[idx[j]] === across[idx[j - 1]]) continue;
    // The cells within the width from this one across, by their place along the track.
    const inside: number[] = [];
    for (let k = j; k < idx.length && across[idx[k]] - across[idx[j]] <= width; k++) inside.push(idx[k]);
    if (inside.length <= best.length) continue;
    inside.sort((a, b) => along[a] - along[b]);
    for (let p = 0, q = 0; q < inside.length; q++) {
      while (along[inside[q]] - along[inside[p]] > reach) p++;
      if (q - p + 1 > best.length) best = inside.slice(p, q + 1);
    }
  }
  const xs = best.map((i) => across[i]);
  const ys = best.map((i) => along[i]);
  const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
  return { count: best.length, window: [mid - width / 2, mid + width / 2], along: framed(Math.min(...ys), Math.max(...ys), length, most), members: best };
}

/** Looking `x` radians across the track from `distance` km: the off-nadir angle, incidence, elevation (degrees) and range (km). */
function lookAt(x: number, distance: number) {
  const lambda = Math.abs(x);
  const offNadir = offNadirFor(lambda, distance);
  const incidence = offNadir + lambda * deg;
  const range = Math.hypot(R * Math.sin(lambda), distance - R * Math.cos(lambda));
  return { offNadir, incidence, elevation: 90 - incidence, range };
}

/** Ground angle (radians from the sub-satellite point) at which the line of sight meets the ground at `incidence` degrees, from `distance` km. */
function centralAngleFor(incidence: number, distance: number): number {
  const offNadir = Math.asin(Math.min(1, (R / distance) * Math.sin(incidence * rad)));
  return Math.max(0, incidence * rad - offNadir);
}

/**
 * How far across the track (radians from the sub-satellite point, either
 * side) the satellite can look from `distance` km: from its smallest
 * off-nadir angle (and the smallest incidence asked for) to `limit` (and the
 * largest incidence).
 */
function reachOf(sat: SatelliteSpec, limit: number, distance: number, options: Pick<PlanOptions, 'minIncidence' | 'maxIncidence'>): [number, number] {
  let near = sat.minOffNadir > 0 ? groundRange(sat.minOffNadir, distance) / R : 0;
  let far = groundRange(limit, distance) / R;
  if (options.minIncidence != null) near = Math.max(near, centralAngleFor(options.minIncidence, distance));
  if (options.maxIncidence != null) far = Math.min(far, centralAngleFor(options.maxIncidence, distance));
  return [near, far];
}

/** The opportunity at `time`, or null when the satellite cannot take it. */
function judge(sat: SatelliteSpec, satrec: SatRec, s: number, ti: number, t: Prepared, time: number, limit: number, options: PlanOptions, epoch: number): Opportunity | null {
  const st = stateAt(satrec, time)!;
  if (options.pass && st.north !== (options.pass === 'ascending')) return null;
  const lookSide = sideFor(sat, options);
  if (!lookSide) return null;
  const center = lonLatOf(t.r);
  const sun = sunElevation(center, time);
  if (options.daylight === 'optical' && !sat.sar && sun < options.minSunElevation) return null;
  const minIncidence = options.minIncidence ?? null;
  const maxIncidence = options.maxIncidence ?? null;
  const f = frameOf(st);
  const distance = norm(st.r);
  const { width, y0, y1 } = spread(st, t);
  const along = (y1 - y0) * R;
  const sw = sat.swath / R;
  const sl = sat.length / R;
  const common = {
    satellite: s,
    target: ti,
    time,
    ascending: st.north,
    sunElevation: sun,
    width,
    strips: width > 0 ? Math.max(1, Math.ceil(width / sat.swath - 1e-9)) : 1,
    length: along,
    frames: framesFor(along, sat.length),
    tleAge: (time - epoch) / 86400000,
    orbitRadius: distance,
  };

  if (!t.cells.length) {
    // A point: the angle to it at closest approach.
    const { cosOff, elevation, range, d } = look(st, t);
    if (elevation <= 0) return null;
    const offNadir = Math.acos(Math.min(1, cosOff)) * deg;
    if (offNadir > limit || offNadir < sat.minOffNadir) return null;
    const incidence = 90 - elevation;
    if ((minIncidence !== null && incidence < minIncidence) || (maxIncidence !== null && incidence > maxIncidence)) return null;
    const side = dot(d, f.n) > 0 ? 'left' : 'right';
    if (lookSide !== 'both' && lookSide !== side) return null;
    const x = trackAngles(unit(t.r), f)[0];
    return { ...common, offNadir, incidence: 90 - elevation, elevation, side, range, coverage: 1, window: [x - sw / 2, x + sw / 2], along: framed(y0, y1, sl, sat.scenesPerPass) };
  }

  // An area: the cells within reach (on a side it looks to, between its smallest and largest angles), and the
  // scenes placed over as many of them as they can take.
  const [near, far] = reachOf(sat, limit, distance, options);
  const across = new Float32Array(t.cells.length);
  const alongs = new Float32Array(t.cells.length);
  t.cells.forEach((p, i) => {
    const [x, y] = trackAngles(p, f);
    const ok = Math.abs(x) >= near && Math.abs(x) <= far && (lookSide === 'both' || (x > 0) === (lookSide === 'left'));
    across[i] = ok ? x : Number.NaN;
    alongs[i] = y;
  });
  const best = bestScene(across, alongs, sw, sl, sat.scenesPerPass);
  if (!best) return null;
  const mid = (best.window[0] + best.window[1]) / 2;
  return {
    ...common,
    ...lookAt(mid, distance),
    side: mid > 0 ? 'left' : 'right',
    coverage: best.count / t.cells.length,
    window: best.window,
    along: best.along,
    cells: across,
    cellsAlong: alongs,
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

/** How fast a satellite's ground track moves, radians of the Earth per second (Earth's turning left out). */
const trackRate = (orbitRadius: number) => Math.sqrt(398600.4418 / orbitRadius ** 3);

/**
 * The points (other than `op`'s, from `candidates` of the same pass) one
 * scene of `op`'s satellite can take together with it: within the scene's
 * length along the track after it, and its width across it. Returns them
 * with `op` and where across the track the scene goes.
 */
function sharedScene(op: Opportunity, candidates: Opportunity[], sat: SatelliteSpec): { members: Opportunity[]; window: [number, number] } {
  const width = sat.swath / R;
  const x0 = (op.window[0] + op.window[1]) / 2;
  // Consecutive scenes reach further along the track: as far as `scenesPerPass` scene lengths.
  const span = ((sat.length * sat.scenesPerPass) / R / trackRate(op.orbitRadius)) * 1000;
  const near = [op, ...candidates.filter((c) => c.time >= op.time && c.time - op.time <= span && Math.abs((c.window[0] + c.window[1]) / 2 - x0) <= width)];
  const xOf = (o: Opportunity) => (o.window[0] + o.window[1]) / 2;
  // The scene across the track: from each point's angle, as wide as the scene, with op inside; the one taking most.
  let best = [op];
  for (const left of near.map(xOf).filter((x) => x <= x0 && x >= x0 - width)) {
    const inside = near.filter((o) => xOf(o) >= left - 1e-12 && xOf(o) <= left + width + 1e-12);
    if (inside.length > best.length) best = inside;
  }
  const xs = best.map(xOf);
  const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
  return { members: best, window: [mid - width / 2, mid + width / 2] };
}

/**
 * Strings passes (of any satellite) together to cover the targets, earliest
 * first: going through the opportunities in time order, a pass is taken when
 * its scenes, placed over what is still uncovered, add at least `minGain` of
 * an area, until `goal` of it is covered; a point needs just one pass. The
 * targets share the satellites, so a shot is only taken when its satellite
 * is free: `minInterval` minutes after its last shot (of any target), and
 * fewer than `maxPerDay` shots in the 24 hours before. With `share`, points
 * close together on a pass are taken in one scene: a shot for one point
 * also takes the others that fit in the same scene (its width across the
 * track, its length along it), so they need no shots of their own.
 *
 * Targets with a `priority` are planned in its order, most important
 * first: the targets of one priority get their shots, and the next ones fit
 * in with what the satellites have left (so a less important target never
 * takes the shot a more important one needs). Within a priority it is time
 * order as above.
 */
export function coverPlan(opportunities: Opportunity[], targets: PlanTarget[], sats: SatelliteSpec[], goal = 0.95, minGain = 0.02, share = true): CoverPlan[] {
  const plans: CoverPlan[] = targets.map((_, ti) => ({ target: ti, steps: [], coverage: 0, done: null, blocked: 0 }));
  const covered = targets.map((t) => new Uint8Array(t.cells?.length ?? 0));
  const totals = targets.map(() => 0);
  const shots = sats.map(() => [] as number[]);
  // Whether the satellite cannot take a shot at `time`: too close to one it takes (before or after, as more important
  // targets are planned first), or a 24 hours round it already full.
  const busy = (s: number, time: number) => {
    const sat = sats[s];
    const taken = shots[s];
    if (sat.minInterval > 0 && taken.some((t) => Math.abs(time - t) < sat.minInterval * 60000)) return true;
    if (sat.maxPerDay <= 0) return false;
    const near = taken.filter((t) => Math.abs(time - t) < 86400000);
    return [time, ...near.filter((t) => t > time - 86400000 && t <= time)].some((from) => near.filter((t) => t >= from && t < from + 86400000).length + 1 > sat.maxPerDay);
  };
  const sorted = [...opportunities].sort((a, b) => a.time - b.time);
  let shot = 0;
  const isPoint = (o: Opportunity) => !covered[o.target].length && o.width === 0;
  const rank = (t: number) => targets[t]?.priority ?? -Infinity;
  const tiers = [...new Set(targets.map((_, t) => rank(t)))].sort((a, b) => b - a);
  for (const tier of tiers) sorted.forEach((op, i) => {
    if (rank(op.target) !== tier) return;
    const plan = plans[op.target];
    if (!plan || plan.done !== null) return;
    const n = covered[op.target].length;
    const sat = sats[op.satellite];
    if (!n) {
      if (busy(op.satellite, op.time)) {
        plan.blocked++;
        return;
      }
      shots[op.satellite].push(op.time);
      shot++;
      // Other points still to take, seen by the same satellite on this pass (seconds later).
      const others: Opportunity[] = [];
      if (share && sat && isPoint(op)) {
        for (let j = i + 1; j < sorted.length && sorted[j].time - op.time < 600000; j++) {
          const o = sorted[j];
          if (o.satellite === op.satellite && o.target !== op.target && isPoint(o) && plans[o.target].done === null && !others.some((x) => x.target === o.target)) others.push(o);
        }
      }
      const { members, window } = others.length ? sharedScene(op, others, sat) : { members: [op], window: op.window };
      const times = members.map((m) => m.time);
      const scene: [number, number] | undefined = members.length > 1 ? [Math.min(...times), Math.max(...times)] : undefined;
      for (const m of members) {
        const p = plans[m.target];
        const mid = (window[0] + window[1]) / 2;
        const shared = members.length > 1 ? { window, scene, ...lookAt(mid, m.orbitRadius), side: mid > 0 ? ('left' as const) : ('right' as const) } : {};
        p.steps.push({ ...m, ...shared, gain: 1, cumulative: 1, shot, shotTargets: members.length });
        p.coverage = 1;
        p.done = m.time;
      }
      return;
    }
    if (!op.cells || !op.cellsAlong || !sat) return;
    const cov = covered[op.target];
    const best = bestScene(op.cells, op.cellsAlong, sat.swath / R, sat.length / R, sat.scenesPerPass, (i) => !cov[i]);
    if (!best || best.count / n < Math.min(minGain, goal - totals[op.target] / n - 1e-9)) return;
    if (busy(op.satellite, op.time)) {
      plan.blocked++;
      return;
    }
    const [a, b] = best.window;
    const [c, d] = best.along;
    let gain = 0;
    op.cells.forEach((x, i) => {
      const y = op.cellsAlong![i];
      if (!cov[i] && x >= a && x <= b && y >= c && y <= d) {
        cov[i] = 1;
        gain++;
      }
    });
    shots[op.satellite].push(op.time);
    shot++;
    totals[op.target] += gain;
    const total = totals[op.target] / n;
    const mid = (a + b) / 2;
    plan.steps.push({ ...op, window: best.window, along: best.along, ...lookAt(mid, op.orbitRadius), side: mid > 0 ? 'left' : 'right', gain: gain / n, cumulative: total, shot, shotTargets: 1 });
    plan.coverage = total;
    if (total >= goal) plan.done = op.time;
  });
  // Shots were numbered as they were taken; in a plan by priority, number them again in time order.
  if (tiers.length > 1) {
    const order = [...new Set(plans.flatMap((p) => p.steps.map((s) => s.shot!)))].sort((a, b) => a - b);
    const times = new Map<number, number>();
    for (const p of plans) for (const s of p.steps) times.set(s.shot!, s.time);
    order.sort((a, b) => times.get(a)! - times.get(b)! || a - b);
    const renumber = new Map(order.map((n, i) => [n, i + 1]));
    for (const p of plans) for (const s of p.steps) s.shot = renumber.get(s.shot!);
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
  /** The scenes the pass takes: side by side across the track, and one after another along it. */
  scenes: Array<Array<[number, number]>>;
  /** Where the satellite is at the moment. */
  position: [number, number];
}

/**
 * The ground track, reach and scenes of an opportunity (`minutes` before and
 * after it). Where the scenes go comes from the opportunity itself (`window`,
 * `along`, `scene`); `target` is the target it was planned for.
 */
export function passShapes(sat: SatelliteSpec, target: PlanTarget, op: Opportunity, minutes = 5): PassShapes | null {
  const satrec = satrecOf(sat);
  if (typeof satrec === 'string') return null;
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
  const frame = frameOf(st);
  // The scenes: one swath across the track, and along it the scenes taken one after another (for a scene shared
  // by several points, from the first of them to the last).
  const rate = trackRate(norm(st.r));
  const sceneLength = sat.length / R;
  const [a, b] = op.window;
  const [from0, to0] = op.scene
    ? framed(((op.scene[0] - op.time) / 1000) * rate, ((op.scene[1] - op.time) / 1000) * rate, sceneLength, sat.scenesPerPass)
    : op.along;
  const frames = Math.max(1, Math.round((to0 - from0) / sceneLength));
  const scenes: Array<Array<[number, number]>> = [];
  for (let k = 0; k < frames; k++) {
    const from = from0 + k * sceneLength;
    const to = from + sceneLength;
    const ring: Array<[number, number]> = [];
    // Each edge in a few pieces, so the scenes follow the curve of the track.
    const edge = (x: number, y0e: number, y1e: number) => {
      for (let i = 0; i <= 4; i++) ring.push(lonLatOf(pointAt(frame, x, y0e + ((y1e - y0e) * i) / 4)));
    };
    edge(a, from, to);
    edge(b, to, from);
    ring.push(ring[0]);
    scenes.push(ring);
  }
  return { track, reach, scenes, position: [g.longitude * deg, g.latitude * deg] };
}

/** Where an opportunity's scenes are along the track (radians, as `along`); for a shared scene, from its first point to its last. */
function alongOf(op: Opportunity, sat: SatelliteSpec): [number, number] {
  if (!op.scene) return op.along;
  const rate = trackRate(op.orbitRadius);
  return framed(((op.scene[0] - op.time) / 1000) * rate, ((op.scene[1] - op.time) / 1000) * rate, sat.length / R, sat.scenesPerPass);
}

/** Where a place (longitude, latitude) is seen from a satellite's orbit at `time`: radians across the track (left positive) and along it; null when SGP4 fails. */
export function trackPlace(sat: SatelliteSpec, time: number, lonLat: [number, number]): [number, number] | null {
  const satrec = satrecOf(sat);
  if (typeof satrec === 'string') return null;
  const st = stateAt(satrec, time);
  return st ? trackAngles(unit(ecefOf(lonLat)), frameOf(st)) : null;
}

/**
 * An opportunity with its scenes moved `dx` radians across the track and
 * `dy` along it (dragged on the map): kept where the satellite can look (its
 * off-nadir angles, a tighter limit, the incidences and side asked for), with
 * its angles and how much of `target` it takes worked out again.
 */
export function shiftScene(
  op: Opportunity,
  sat: SatelliteSpec,
  target: PlanTarget,
  dx: number,
  dy: number,
  options: Partial<Pick<PlanOptions, 'maxOffNadir' | 'minIncidence' | 'maxIncidence' | 'side'>>,
): Opportunity {
  const limit = Math.min(sat.maxOffNadir, options.maxOffNadir ?? Infinity);
  const [near, far] = reachOf(sat, limit, op.orbitRadius, options);
  const lookSide = sideFor(sat, options) ?? sat.lookSide;
  const half = (op.window[1] - op.window[0]) / 2;
  let mid = (op.window[0] + op.window[1]) / 2 + dx;
  // Toward the side it may look to: within its nearest and farthest reach there.
  const sign = lookSide === 'both' ? (mid >= 0 ? 1 : -1) : lookSide === 'left' ? 1 : -1;
  mid = sign * Math.min(far, Math.max(near, sign * mid));
  const base = alongOf(op, sat);
  const along: [number, number] = [base[0] + dy, base[1] + dy];
  const window: [number, number] = [mid - half, mid + half];
  const inside = (x: number, y: number) => x >= window[0] && x <= window[1] && y >= along[0] && y <= along[1];
  let coverage: number;
  if (op.cells && op.cellsAlong) {
    let n = 0;
    op.cells.forEach((x, i) => {
      if (!Number.isNaN(x) && inside(x, op.cellsAlong![i])) n++;
    });
    coverage = n / op.cells.length;
  } else {
    const at = trackPlace(sat, op.time, target.center);
    coverage = at && inside(at[0], at[1]) ? 1 : 0;
  }
  const { scene: _scene, ...rest } = op;
  void _scene;
  return { ...rest, window, along, ...lookAt(mid, op.orbitRadius), side: mid > 0 ? 'left' : 'right', coverage, adjusted: true };
}

/** How many scenes an opportunity takes, one after another along the pass. */
export function scenesTaken(op: Opportunity, sat: SatelliteSpec): number {
  return Math.max(1, Math.round(((op.along[1] - op.along[0]) * R) / sat.length));
}

/** Scenes of `sceneLength` km one after another along the track to cover `length` km (at least one). */
function framesFor(length: number, sceneLength: number): number {
  return sceneLength > 0 ? Math.max(1, Math.ceil(length / sceneLength - 1e-6)) : 1;
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

/** Where a satellite is at a moment, and the ground it reaches across its track. */
export interface GroundState {
  /** The sub-satellite point (longitude, latitude). */
  lonLat: [number, number];
  /** Height above the ellipsoid, km. */
  height: number;
  ascending: boolean;
  /** The points `offNadirs` degrees across the track (left positive), longitude, latitude. */
  across: Array<[number, number]>;
}

/** The satellite (its `satrec`) at `ms`, with the points `offNadirs` degrees across its track; null when SGP4 fails. */
export function groundStateAt(satrec: SatRec, ms: number, offNadirs: readonly number[]): GroundState | null {
  const st = stateAt(satrec, ms);
  if (!st) return null;
  const g = eciToGeodetic({ x: st.eci[0], y: st.eci[1], z: st.eci[2] }, st.gmst);
  const f = frameOf(st);
  const distance = norm(st.r);
  const across = offNadirs.map((a) => lonLatOf(pointAt(f, (Math.sign(a) * groundRange(Math.abs(a), distance)) / R, 0)));
  return { lonLat: [g.longitude * deg, g.latitude * deg], height: g.height, ascending: st.north, across };
}
