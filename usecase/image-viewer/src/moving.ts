/**
 * Moving objects (ships by AIS, aircraft by ADS-B): what the feeds send, read
 * into positions, and kept per object as a track.
 *
 * - Messages: a JSON object, an array of them, GeoJSON (Feature /
 *   FeatureCollection, points), Esri features (`attributes` + `geometry`, as
 *   ArcGIS Stream Services send them), lists under a key (`features`, `data`,
 *   `vessels`, `aircraft`, `ac`…) and OpenSky's `states` arrays. Nested objects
 *   (aisstream.io's `MetaData` / `Message`) are flattened to dotted keys.
 * - Fields by role (id, time, lat, lon, heading, course, speed, name, kind):
 *   found by their usual names (mmsi, icao24, lat, longitude, cog, sog,
 *   shipname, timestamp…), or as set in 「詳細」 / config.json.
 * - Tracks: each object's fixes in time order, with caps on the objects and
 *   fixes kept; positions at any time are interpolated between fixes
 *   (for the timeline, and for checking AI detections against them).
 */
import { decodeCsv, parseCsv } from './csv.js';
import { parseTime } from './time.js';
import { readInstant, readTextInstant, UTC, type TimeZone } from './time-zone.js';

/** What a field means for a moving object. */
export type MovingRole = 'id' | 'time' | 'lat' | 'lon' | 'heading' | 'course' | 'speed' | 'name' | 'kind';
export const movingRoles: Record<MovingRole, string> = {
  id: 'ID（MMSI・ICAO）',
  time: '時刻',
  lat: '緯度',
  lon: '経度',
  heading: '船首方位・機首方位',
  course: '針路（COG）',
  speed: '速度',
  name: '名前',
  kind: '種別',
};
export const MOVING_ROLES = Object.keys(movingRoles) as MovingRole[];

/** Which field holds each role: flattened keys (`MetaData.MMSI`). */
export type FieldMap = Partial<Record<MovingRole, string>>;

/** What objects a feed has: drawn as ships or aircraft. */
export type MovingKind = 'ship' | 'aircraft';
export const movingKinds: Record<MovingKind, string> = { ship: '船舶', aircraft: '航空機' };

/** How a feed is reached. */
export type FeedType = 'websocket' | 'sse' | 'poll' | 'esri-stream';
export const feedTypes: Record<FeedType, string> = {
  websocket: 'WebSocket',
  sse: 'Server-Sent Events',
  poll: 'ポーリング（GeoJSON・JSON）',
  'esri-stream': 'ArcGIS Stream Service',
};

/** One feed of config.json's `movingFeeds`, or added by URL. */
export interface FeedConfig {
  label: string;
  type: FeedType;
  url: string;
  /** Seconds between requests, for `poll`. */
  interval?: number;
  /** Fields by role, over what is found by name. */
  fields?: FieldMap;
  kind?: MovingKind;
}

/** A value kept as an attribute. */
export type Primitive = string | number | boolean | null;

/** One position report, read. */
export interface MovingRecord {
  id: string;
  /** ms since 1970. */
  t: number;
  lon: number;
  lat: number;
  /** Degrees from north, clockwise; null when unknown. */
  heading: number | null;
  course: number | null;
  speed: number | null;
  name: string | null;
  kind: string | null;
  /** The other values of the message (flattened keys). */
  attrs: Record<string, Primitive>;
}

/** Records read from one message at most. */
export const MAX_RECORDS_PER_MESSAGE = 50_000;
/** Attributes kept per record at most, and the longest text kept. */
const MAX_ATTRS = 40;
const MAX_TEXT = 200;
const MAX_KEY = 64;

// ---- reading messages ----

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Keys a list of objects is commonly sent under. */
const LIST_KEYS = ['features', 'data', 'items', 'records', 'vessels', 'ships', 'aircraft', 'ac', 'results', 'positions', 'rows', 'list'];

/** OpenSky Network's state vector, by index. */
const OPENSKY = ['icao24', 'callsign', 'origin_country', 'time_position', 'last_contact', 'longitude', 'latitude', 'baro_altitude', 'on_ground', 'velocity', 'true_track', 'vertical_rate', 'sensors', 'geo_altitude', 'squawk', 'spi', 'position_source'];

/** Web Mercator metres to longitude / latitude. */
function mercatorToLonLat(x: number, y: number): [number, number] {
  const R = 6378137;
  return [((x / R) * 180) / Math.PI, ((2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180) / Math.PI];
}

/** A point's longitude / latitude from an Esri geometry (`x`, `y`, in degrees or Web Mercator) or GeoJSON coordinates. */
function pointOf(geometry: unknown): [number, number] | null {
  if (!isRecord(geometry)) return null;
  let x: unknown;
  let y: unknown;
  if (typeof geometry.x === 'number' && typeof geometry.y === 'number') [x, y] = [geometry.x, geometry.y];
  else if (Array.isArray(geometry.coordinates)) {
    let c: unknown = geometry.coordinates;
    // MultiPoint and lines: the first point.
    while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
    if (Array.isArray(c)) [x, y] = c;
  }
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const wkid = isRecord(geometry.spatialReference) ? geometry.spatialReference.wkid : undefined;
  if (wkid === 102100 || wkid === 3857 || wkid === 102113 || Math.abs(x) > 180 || Math.abs(y) > 90) return mercatorToLonLat(x, y);
  return [x, y];
}

/** `value` flattened: nested objects as dotted keys (three levels), arrays left out. */
export function flatten(value: Record<string, unknown>, into: Record<string, Primitive> = {}, prefix = '', depth = 0): Record<string, Primitive> {
  for (const [key, v] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (v === null || typeof v === 'number' || typeof v === 'boolean') into[name] = typeof v === 'number' && !Number.isFinite(v) ? null : v;
    else if (typeof v === 'string') into[name] = v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) : v;
    else if (isRecord(v) && depth < 3) flatten(v, into, name, depth + 1);
  }
  return into;
}

/**
 * The objects in a message, flattened. A point geometry (GeoJSON, Esri)
 * gives `_lon` and `_lat`.
 */
export function recordsOf(message: unknown, max = MAX_RECORDS_PER_MESSAGE): Array<Record<string, Primitive>> {
  const out: Array<Record<string, Primitive>> = [];
  const one = (item: unknown) => {
    if (out.length >= max || !isRecord(item)) return;
    // GeoJSON features and Esri features: their attributes and their point.
    const props = isRecord(item.properties) ? item.properties : isRecord(item.attributes) ? item.attributes : null;
    if (props && (item.type === 'Feature' || 'geometry' in item || 'attributes' in item)) {
      const flat = flatten(props);
      const at = pointOf(item.geometry);
      if (at) [flat._lon, flat._lat] = at;
      if (item.id !== undefined && flat.id === undefined && (typeof item.id === 'string' || typeof item.id === 'number')) flat.id = item.id;
      out.push(flat);
    } else out.push(flatten(item));
  };
  const list = (items: unknown[]) => {
    for (const item of items) {
      if (out.length >= max) break;
      one(item);
    }
  };
  if (Array.isArray(message)) list(message);
  else if (isRecord(message)) {
    if (message.type === 'FeatureCollection' && Array.isArray(message.features)) list(message.features);
    else if (Array.isArray(message.states) && message.states.every(Array.isArray)) {
      // OpenSky: [icao24, callsign, …] per aircraft.
      for (const s of message.states as unknown[][]) {
        if (out.length >= max) break;
        const o: Record<string, unknown> = {};
        OPENSKY.forEach((k, i) => (o[k] = typeof s[i] === 'string' ? (s[i] as string).trim() : s[i]));
        out.push(flatten(o));
      }
    } else {
      const key = LIST_KEYS.find((k) => Array.isArray(message[k]) && (message[k] as unknown[]).some(isRecord));
      if (key) list(message[key] as unknown[]);
      else one(message);
    }
  }
  return out;
}

// ---- fields by role ----

/** The usual names of each role, best first (compared lower case, without `_`, `-`, spaces). */
const NAMES: Record<MovingRole, string[]> = {
  id: ['mmsi', 'icao24', 'icao', 'hex', 'userid', 'trackid', 'vesselid', 'imo', 'id', 'uid', 'callsign', 'flight'],
  time: ['timestamp', 'timeutc', 'time', 'datetime', 'basedatetime', 'lastcontact', 'timeposition', 'postime', 'ts', 'date', 'updated', 'lastupdate', 'receivedat'],
  lat: ['lat', 'latitude', '_lat'],
  lon: ['lon', 'lng', 'long', 'longitude', '_lon'],
  heading: ['trueheading', 'heading', 'hdg', 'truehdg', 'navheading', 'magheading'],
  course: ['cog', 'course', 'truetrack', 'track', 'dir', 'direction'],
  speed: ['sog', 'speed', 'velocity', 'gs', 'groundspeed', 'spd'],
  name: ['shipname', 'vesselname', 'name', 'callsign', 'flight', 'registration', 'reg'],
  kind: ['kind', 'vesseltype', 'shiptype', 'aircrafttype', 'category', 'type', 'typecode'],
};

const norm = (key: string) =>
  key
    .slice(key.lastIndexOf('.') + 1)
    .toLowerCase()
    .replace(/[\s_-]+/g, '') || key;

/** The key's last part, compared as {@link NAMES} are (`_lat` and `_lon` keep their `_`). */
const nameOf = (key: string) => (key === '_lat' || key === '_lon' ? key : norm(key));

/**
 * The field of each role among `keys`, by name; `given` (from 「詳細」 or
 * config.json) wins. A field serves one role only.
 */
export function detectFields(keys: Iterable<string>, given: FieldMap = {}): FieldMap {
  const all = [...new Set(keys)];
  const used = new Set(Object.values(given).filter(Boolean));
  const found: FieldMap = {};
  for (const role of MOVING_ROLES) {
    if (given[role]) {
      found[role] = given[role];
      continue;
    }
    for (const candidate of NAMES[role]) {
      const key = all.find((k) => !used.has(k) && nameOf(k) === candidate);
      if (key) {
        found[role] = key;
        used.add(key);
        break;
      }
    }
  }
  return found;
}

/** Whether a field map can place objects: an id, a latitude and a longitude. */
export function canPlace(map: FieldMap): boolean {
  return !!(map.id && map.lat && map.lon);
}

/** Ships or aircraft, from the names of the fields (AIS has MMSIs, ADS-B ICAO addresses and call signs). */
export function guessKind(keys: Iterable<string>): MovingKind {
  const names = new Set([...keys].map(nameOf));
  const ship = ['mmsi', 'shipname', 'vesselname', 'sog', 'cog', 'imo', 'shiptype', 'vesseltype', 'navstat', 'navigationalstatus'].some((n) => names.has(n));
  const air = ['icao24', 'icao', 'hex', 'squawk', 'baroaltitude', 'geoaltitude', 'altitude', 'altbaro', 'flight', 'onground'].some((n) => names.has(n));
  return air && !ship ? 'aircraft' : 'ship';
}

/** A number from a number or numeric text; null otherwise. */
export function numberOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(v.trim())) return Number(v);
  return null;
}

/**
 * A time from a feed: ms or s since 1970 as numbers, or text (ISO 8601 and
 * the like). Text without a time zone is UTC, as AIS and ADS-B times are;
 * aisstream.io's `… +0000 UTC` reads too.
 */
export function timeOf(v: unknown, zone?: TimeZone | null): number | null {
  const n = numberOf(v);
  if (n !== null) {
    const t = n > 1e11 ? n : n > 1e8 ? n * 1000 : null;
    // A feed in another zone than it says (config.json's timeZone): its clock read as that zone's.
    return t !== null && zone ? readInstant(t, { data: zone, service: UTC }) : t;
  }
  if (typeof v !== 'string') return null;
  const text = v.trim().replace(/\s*UTC$/i, '');
  if (!text) return null;
  // Nanoseconds and more: milliseconds are enough.
  const trimmed = text.replace(/([.,]\d{3})\d+/, '$1');
  if (zone) {
    const t = readTextInstant(trimmed.replace(/\s+([+-]\d{4})$/, '$1'), zone);
    if (t !== null) return t;
  }
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  return (zoned ? null : parseTime(`${trimmed}Z`)) ?? parseTime(trimmed);
}

/** An angle in degrees 0–360 (AIS's 511 and 360+ are "not available"); null otherwise. */
function angleOf(v: unknown): number | null {
  const n = numberOf(v);
  return n === null || n < 0 || n > 360 ? null : n % 360;
}

/**
 * One record as a position report by `map`, or null when it has no id or
 * no valid position. `now` is its time when it has none.
 */
export function readRecord(flat: Record<string, Primitive>, map: FieldMap, now: number, zone?: TimeZone | null): MovingRecord | null {
  const get = (role: MovingRole) => (map[role] ? flat[map[role]!] : undefined);
  const rawId = get('id');
  const id = typeof rawId === 'number' ? String(rawId) : typeof rawId === 'string' ? rawId.trim().slice(0, MAX_KEY) : '';
  if (!id) return null;
  const lat = numberOf(get('lat'));
  const lon = numberOf(get('lon'));
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const t = timeOf(get('time'), zone) ?? now;
  const speed = numberOf(get('speed'));
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_TEXT) : typeof v === 'number' ? String(v) : null);
  const mapped = new Set(Object.values(map));
  const attrs: Record<string, Primitive> = {};
  let n = 0;
  for (const [k, v] of Object.entries(flat)) {
    if (mapped.has(k) || k === '_lon' || k === '_lat' || k === 'geometry') continue;
    if (n++ >= MAX_ATTRS) break;
    attrs[k.slice(0, MAX_KEY)] = v;
  }
  return {
    id,
    t,
    lon,
    lat,
    heading: angleOf(get('heading')),
    course: angleOf(get('course')),
    speed: speed !== null && speed >= 0 && speed < 10000 ? speed : null,
    name: text(get('name')),
    kind: text(get('kind')),
    attrs,
  };
}

// ---- tracks ----

/** One position of an object. */
export interface Fix {
  t: number;
  lon: number;
  lat: number;
  /** The direction drawn: the heading, else the course. */
  dir: number | null;
  speed: number | null;
}

/** An object and its fixes, oldest first. */
export interface Track {
  id: string;
  name: string | null;
  kind: string | null;
  /** The latest report's other values, and its own heading and course. */
  attrs: Record<string, Primitive>;
  heading: number | null;
  course: number | null;
  fixes: Fix[];
}

export interface TrackLimits {
  /** Objects kept at most (new ones are left out beyond). */
  maxObjects: number;
  /** Fixes kept per object (the oldest go first). */
  maxFixesPerTrack: number;
  /** Fixes kept in all (new ones are left out beyond). */
  maxFixes: number;
}

export const DEFAULT_LIMITS: TrackLimits = { maxObjects: 20_000, maxFixesPerTrack: 5_000, maxFixes: 2_000_000 };

/** The index of the last fix at or before `t` (-1 when all are after). */
export function fixIndex(fixes: readonly Fix[], t: number): number {
  let lo = 0;
  let hi = fixes.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fixes[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The tracks of a feed. */
export class TrackStore {
  readonly tracks = new Map<string, Track>();
  /** Fixes held. */
  fixCount = 0;
  /** Reports left out by the caps. */
  dropped = 0;

  constructor(readonly limits: TrackLimits = DEFAULT_LIMITS) {}

  /** Adds a report; false when a cap left it out. */
  add(r: MovingRecord): boolean {
    let track = this.tracks.get(r.id);
    if (!track) {
      if (this.tracks.size >= this.limits.maxObjects) return (this.dropped++, false);
      track = { id: r.id, name: null, kind: null, attrs: {}, heading: null, course: null, fixes: [] };
      this.tracks.set(r.id, track);
    }
    const fix: Fix = { t: r.t, lon: r.lon, lat: r.lat, dir: r.heading ?? r.course, speed: r.speed };
    const fixes = track.fixes;
    const i = fixIndex(fixes, r.t);
    if (i >= 0 && fixes[i].t === r.t) fixes[i] = fix;
    else {
      if (this.fixCount >= this.limits.maxFixes) return (this.dropped++, false);
      fixes.splice(i + 1, 0, fix);
      this.fixCount++;
      if (fixes.length > this.limits.maxFixesPerTrack) {
        fixes.shift();
        this.fixCount--;
      }
    }
    // The latest report names the object (an older one arriving late does not).
    if (fixes[fixes.length - 1] === fix) {
      if (r.name) track.name = r.name;
      if (r.kind) track.kind = r.kind;
      track.attrs = r.attrs;
      track.heading = r.heading;
      track.course = r.course;
    } else {
      track.name ??= r.name;
      track.kind ??= r.kind;
    }
    return true;
  }

  /** Forgets fixes before `t`, and the objects left with none. */
  prune(t: number): void {
    for (const [id, track] of this.tracks) {
      const i = fixIndex(track.fixes, t - 1);
      if (i < 0) continue;
      track.fixes.splice(0, i + 1);
      this.fixCount -= i + 1;
      if (!track.fixes.length) this.tracks.delete(id);
    }
  }

  /** The first and last times held; null when empty. */
  range(): [number, number] | null {
    let min = Infinity;
    let max = -Infinity;
    for (const track of this.tracks.values()) {
      if (!track.fixes.length) continue;
      min = Math.min(min, track.fixes[0].t);
      max = Math.max(max, track.fixes[track.fixes.length - 1].t);
    }
    return min <= max ? [min, max] : null;
  }

  clear(): void {
    this.tracks.clear();
    this.fixCount = 0;
  }
}

/** Where an object is at a time. */
export interface Position {
  lon: number;
  lat: number;
  dir: number | null;
  speed: number | null;
  /** How long since the fix it is held at (0 between two fixes, interpolated). */
  age: number;
  /** Whether it lies between two fixes (interpolated). */
  interpolated: boolean;
}

/** The longitude `b` as close to `a` as the antimeridian allows (b − a in −180…180). */
function nearLon(a: number, b: number): number {
  let d = b - a;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  return a + d;
}

const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

/** The angle between `a` and `b`, a fraction `f` of the way, the short way round. */
function lerpAngle(a: number | null, b: number | null, f: number): number | null {
  if (a === null) return b;
  if (b === null) return a;
  let d = b - a;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  return (((a + d * f) % 360) + 360) % 360;
}

export interface PositionOptions {
  /** How long an object stays at its last fix (and at a fix before a long gap), ms. */
  hold: number;
  /** Fixes further apart than this are not joined (the object is held, then gone), ms. */
  maxGap?: number;
  /** How long before its first fix an object is already shown there, ms (0: not before). */
  lead?: number;
}

/** Where `track` is at `t`: between its fixes, interpolated; null when it is not known then. */
export function positionAt(track: Track, t: number, { hold, maxGap = 6 * 3_600_000, lead = 0 }: PositionOptions): Position | null {
  const fixes = track.fixes;
  if (!fixes.length) return null;
  const i = fixIndex(fixes, t);
  if (i < 0) {
    const first = fixes[0];
    return first.t - t <= lead ? { lon: first.lon, lat: first.lat, dir: first.dir, speed: first.speed, age: 0, interpolated: false } : null;
  }
  const a = fixes[i];
  const b = fixes[i + 1];
  if (a.t === t || !b || b.t - a.t > maxGap) {
    const age = t - a.t;
    if (age > hold) return b && b.t - t <= lead ? { lon: b.lon, lat: b.lat, dir: b.dir, speed: b.speed, age: 0, interpolated: false } : null;
    return { lon: a.lon, lat: a.lat, dir: a.dir, speed: a.speed, age, interpolated: false };
  }
  const f = (t - a.t) / (b.t - a.t);
  const lon = wrapLon(a.lon + (nearLon(a.lon, b.lon) - a.lon) * f);
  const speed = a.speed === null ? b.speed : b.speed === null ? a.speed : a.speed + (b.speed - a.speed) * f;
  return { lon, lat: a.lat + (b.lat - a.lat) * f, dir: lerpAngle(a.dir, b.dir, f), speed, age: 0, interpolated: true };
}

/**
 * The track from `from` to `to` as longitude / latitude points, ending at
 * `end` (the position drawn), at most `max` points (the latest). Longitudes
 * run on across the antimeridian, so the line does not cross the world.
 */
export function trailOf(track: Track, from: number, to: number, end: [number, number] | null, max = 500): Array<[number, number]> {
  const fixes = track.fixes;
  const last = fixIndex(fixes, to);
  let first = fixIndex(fixes, from - 1) + 1;
  first = Math.max(first, last - max + 1);
  const points: Array<[number, number]> = [];
  for (let i = first; i <= last; i++) {
    const f = fixes[i];
    const lon = points.length ? nearLon(points[points.length - 1][0], f.lon) : f.lon;
    points.push([lon, f.lat]);
  }
  if (end) {
    const lon = points.length ? nearLon(points[points.length - 1][0], end[0]) : end[0];
    const tail = points[points.length - 1];
    if (!tail || tail[0] !== lon || tail[1] !== end[1]) points.push([lon, end[1]]);
  }
  return points;
}

// ---- checking detections ----

/** Metres between two longitude / latitude points (haversine on the mean Earth radius). */
export function distanceMetres(a: readonly [number, number], b: readonly [number, number]): number {
  const R = 6_371_008.8;
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A detection to check: where it is and when (null: no time). */
export interface MatchPoint {
  lon: number;
  lat: number;
  t: number | null;
}

/** The object a detection was matched to. */
export interface Match {
  id: string;
  name: string | null;
  /** Metres from the detection to where the object was at its time. */
  distance: number;
  /** Seconds from the detection's time to the object's nearest fix. */
  dt: number;
}

export interface MatchOptions {
  /** How far apart in time a fix may be, ms (± this). */
  window: number;
  /** How far apart in space, metres. */
  distance: number;
}

/**
 * The nearest object to each detection, at the detection's time: where the
 * object was then (interpolated, or held at a fix within the window), and
 * within the distance. Null when none is; detections without a time get none.
 */
export function matchDetections(points: readonly MatchPoint[], tracks: Iterable<Track>, { window, distance }: MatchOptions): Array<Match | null> {
  const list = [...tracks];
  const results: Array<Match | null> = points.map(() => null);
  // Detections of one image share a time: where every object was is worked out once per time.
  const byTime = new Map<number, number[]>();
  points.forEach((p, i) => {
    if (p.t === null || !Number.isFinite(p.t)) return;
    const group = byTime.get(p.t);
    if (group) group.push(i);
    else byTime.set(p.t, [i]);
  });
  const dLat = (distance / 6_371_008.8) * (180 / Math.PI);
  for (const [t, indices] of byTime) {
    const at: Array<{ lon: number; lat: number; track: Track; dt: number }> = [];
    for (const track of list) {
      const fixes = track.fixes;
      const i = fixIndex(fixes, t);
      const before = i >= 0 ? t - fixes[i].t : Infinity;
      const after = i + 1 < fixes.length ? fixes[i + 1].t - t : Infinity;
      const dt = Math.min(before, after);
      if (dt > window) continue;
      const p = positionAt(track, t, { hold: window, lead: window, maxGap: Infinity });
      if (p) at.push({ lon: p.lon, lat: p.lat, track, dt });
    }
    at.sort((a, b) => a.lat - b.lat);
    for (const k of indices) {
      const p = points[k];
      // The objects within the distance in latitude, then by distance.
      let lo = 0;
      let hi = at.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (at[mid].lat < p.lat - dLat) lo = mid + 1;
        else hi = mid;
      }
      let best: Match | null = null;
      for (let j = lo; j < at.length && at[j].lat <= p.lat + dLat; j++) {
        const d = distanceMetres([p.lon, p.lat], [at[j].lon, at[j].lat]);
        if (d <= distance && (!best || d < best.distance)) best = { id: at[j].track.id, name: at[j].track.name, distance: d, dt: at[j].dt / 1000 };
      }
      results[k] = best;
    }
  }
  return results;
}

// ---- feeds ----

/** The protocols each kind of feed may use. */
const PROTOCOLS: Record<FeedType, string[]> = {
  websocket: ['ws:', 'wss:'],
  sse: ['http:', 'https:'],
  poll: ['http:', 'https:'],
  'esri-stream': ['http:', 'https:'],
};

/** The kind of feed a URL looks like: ws(s) WebSocket, an ArcGIS StreamServer, an event stream, or else polled. */
export function feedTypeOf(url: string): FeedType {
  if (/^wss?:/i.test(url)) return 'websocket';
  const path = url.split(/[?#]/, 1)[0];
  if (/\/StreamServer\/?$/i.test(path)) return 'esri-stream';
  if (/(^|[/._-])(sse|events?|event-stream)([/._-]|$)/i.test(path)) return 'sse';
  return 'poll';
}

/** The absolute URL of a feed, or throws what is wrong with it: ws / wss for WebSocket, http / https for the rest. */
export function feedUrl(text: string, type: FeedType, base?: string): string {
  let url: URL;
  try {
    url = new URL(text.trim(), base);
  } catch {
    throw new Error('URL として読み込み不可');
  }
  if (!PROTOCOLS[type].includes(url.protocol)) throw new Error(`${feedTypes[type]} の URL は ${PROTOCOLS[type].map((p) => p.replace(':', '')).join('・')} で指定`);
  if (url.username || url.password) throw new Error('URL にユーザー名・パスワードは書き込み不可');
  return url.href;
}

/** A URL without its query and fragment (tokens), for the information panel. */
export function displayUrl(url: string): string {
  return url.split(/[?#]/, 1)[0];
}

/** One `movingFeeds` entry of config.json, or null (saying why) when it cannot be used. */
export function movingFeedOf(value: unknown, problems: string[], index: number): FeedConfig | null {
  const at = `movingFeeds[${index}]`;
  if (!isRecord(value)) return (problems.push(`${at} はオブジェクトで指定`), null);
  const { label, type, url, interval, fields, kind } = value;
  if (typeof type !== 'string' || !(type in feedTypes)) return (problems.push(`${at} の type は ${Object.keys(feedTypes).join('・')} のいずれかで指定`), null);
  const feedType = type as FeedType;
  const relative = typeof url === 'string' && /^\.{0,2}\//.test(url) && feedType !== 'websocket';
  if (typeof url !== 'string' || (!relative && !PROTOCOLS[feedType].some((p) => url.toLowerCase().startsWith(`${p}//`)))) {
    return (problems.push(`${at} の url は ${PROTOCOLS[feedType].map((p) => `${p}//`).join('・')} で始まる URL で指定`), null);
  }
  const feed: FeedConfig = { label: typeof label === 'string' && label.trim() ? label.trim() : `フィード ${index + 1}`, type: feedType, url };
  if (interval !== undefined) {
    if (typeof interval === 'number' && interval >= 1) feed.interval = interval;
    else problems.push(`${at} の interval は 1 以上の秒数で指定`);
  }
  if (fields !== undefined) {
    if (!isRecord(fields)) problems.push(`${at} の fields は役割ごとの属性名のオブジェクトで指定`);
    else {
      const map: FieldMap = {};
      for (const [role, name] of Object.entries(fields)) {
        if (!(role in movingRoles)) problems.push(`${at} の fields.${role} は使用不可の役割（${MOVING_ROLES.join('・')}）`);
        else if (typeof name === 'string' && name.trim()) map[role as MovingRole] = name.trim();
        else problems.push(`${at} の fields.${role} は属性名で指定`);
      }
      if (Object.keys(map).length) feed.fields = map;
    }
  }
  if (kind !== undefined) {
    if (kind === 'ship' || kind === 'aircraft') feed.kind = kind;
    else problems.push(`${at} の kind は ship か aircraft で指定`);
  }
  return feed;
}

/**
 * A time as text for the attribute table: `2026-10-17 09:30:00 UTC`. The
 * timeline does not read this as a time on purpose: a feed layer follows the
 * timeline through its own time (the positions at the window's end), not by
 * hiding features.
 */
export function utcText(t: number): string {
  return new Date(t).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/** Rows read from a history file at most. */
export const MAX_HISTORY_ROWS = 2_000_000;

/**
 * The reports in a history file: a CSV / TSV (a header row; a time column
 * and positions, such as MarineCadastre's AIS or OpenSky's state vectors),
 * or GeoJSON / JSON as a feed would send it.
 */
export function historyRows(bytes: Uint8Array, name: string): Array<Record<string, Primitive>> {
  if (/\.(csv|tsv|txt)$/i.test(name)) {
    const rows = parseCsv(decodeCsv(bytes).text);
    const header = (rows.shift() ?? []).map((h, i) => h.trim().slice(0, MAX_KEY) || `列${i + 1}`);
    const out: Array<Record<string, Primitive>> = [];
    for (const row of rows) {
      if (out.length >= MAX_HISTORY_ROWS) break;
      if (row.length === 1 && !row[0].trim()) continue;
      const o: Record<string, Primitive> = {};
      header.forEach((h, i) => {
        const v = row[i]?.trim() ?? '';
        o[h] = v === '' ? null : v.slice(0, MAX_TEXT);
      });
      out.push(o);
    }
    return out;
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('CSV か GeoJSON・JSON として読み込み不可');
  }
  return recordsOf(json, MAX_HISTORY_ROWS);
}
