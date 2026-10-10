/**
 * Times for the timeline: reading dates from attribute values, file names
 * and image metadata, finding the attributes of a layer that hold times, and
 * the calendar steps of the time axis.
 *
 * Times are milliseconds since 1970 (UTC). Text without a time zone
 * (`2024-05-01`, `2024/05/01 10:00`) is read as local time, which is also how
 * the timeline shows times; text with one (`…Z`, `…+09:00`) and Esri / GeoPackage
 * dates (already milliseconds) keep theirs.
 */
import type { FeatureLike } from 'ol/Feature.js';
import type { Field } from './services/index.js';

/** How the values of an attribute are read as times. */
export type TimeHint = 'date' | 'year' | 'text';

const MIN_YEAR = 1800;
const MAX_YEAR = 2200;

function local(y: number, mo = 1, d = 1, h = 0, mi = 0, s = 0, ms = 0): number | null {
  if (y < MIN_YEAR || y > MAX_YEAR || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 24 || mi > 59 || s > 60) return null;
  const t = new Date(y, mo - 1, d, h, mi, s, ms);
  // 2024-02-31 is not a day.
  if (t.getDate() !== d && h < 24) return null;
  return t.getTime();
}

function zoned(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number, zone: string): number | null {
  if (local(y, mo, d) === null) return null;
  const utc = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  if (zone === 'Z' || zone === 'z') return utc;
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone);
  if (!m) return null;
  const offset = (Number(m[2]) * 60 + Number(m[3] ?? 0)) * (m[1] === '-' ? -1 : 1);
  return utc - offset * 60_000;
}

const n = (s: string | undefined) => (s === undefined ? 0 : Number(s));
const fraction = (s: string | undefined) => (s ? Math.round(Number(`0.${s}`) * 1000) : 0);

/**
 * The time of an attribute value, or null. `hint` says how to read numbers:
 * `date` as milliseconds (Esri and GeoPackage dates), `year` as a year;
 * otherwise numbers are not times.
 */
export function parseTime(value: unknown, hint: TimeHint = 'text'): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (hint === 'date') return value;
    if (hint === 'year' && Number.isInteger(value)) return local(value);
    return null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  let m: RegExpExecArray | null;
  // A year alone, only for an attribute that is a year.
  if ((m = /^(\d{4})$/.exec(text))) return hint === 'year' ? local(n(m[1])) : null;
  if (hint === 'date' && /^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  // ISO 8601 and the like: 2024-05-01, 2024-05-01T10:00:00.5Z, 2024/05/01 10:00, 2024.05.01, EXIF's 2024:05:01 10:00:00.
  m = /^(\d{4})([-/.:])(\d{1,2})\2(\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|z|[+-]\d{2}:?\d{2}|[+-]\d{2})?$/.exec(text);
  if (m) {
    const [, y, , mo, d, h, mi, s, f, zone] = m;
    return zone ? zoned(n(y), n(mo), n(d), n(h), n(mi), n(s), fraction(f), zone) : local(n(y), n(mo), n(d), n(h), n(mi), n(s), fraction(f));
  }
  // 2024-05 (a month).
  if ((m = /^(\d{4})[-/](\d{1,2})$/.exec(text))) return local(n(m[1]), n(m[2]));
  // Compact: 20240501, 20240501103000, 20240501T103000Z, 20240501_103000.
  m = /^(\d{4})(\d{2})(\d{2})(?:[T_ ]?(\d{2})(\d{2})(\d{2})?(?:\.(\d+))?)?(Z)?$/.exec(text);
  if (m) {
    const [, y, mo, d, h, mi, s, f, zone] = m;
    return zone ? zoned(n(y), n(mo), n(d), n(h), n(mi), n(s), fraction(f), zone) : local(n(y), n(mo), n(d), n(h), n(mi), n(s), fraction(f));
  }
  // Japanese: 2024年5月1日 10時30分(15秒).
  m = /^(\d{4})年(\d{1,2})月(?:(\d{1,2})日)?\s*(?:(\d{1,2})[時:](?:(\d{1,2})分?)?(?:(\d{1,2})秒?)?)?$/.exec(text);
  if (m) return local(n(m[1]), n(m[2]), m[3] ? n(m[3]) : 1, n(m[4]), n(m[5]), n(m[6]));
  return null;
}

/** Names of attributes that usually hold a time, to try them first. */
const TIME_NAME = /date|time|day|日時|日付|年月日|時刻|timestamp|datetime|_at$|^at$|開始|終了|start|end|begin|from|until|観測|撮影|取得|acq/i;
const YEAR_NAME = /^(year|yr|年|年度|.*_year|.*年)$/i;
const START_NAME = /start|begin|from|開始|始/i;
const END_NAME = /end|until|finish|stop|終了|終/i;

/** An attribute that holds times. */
export interface TimeField {
  name: string;
  hint: TimeHint;
}

/**
 * The attributes of a layer that hold times, best first: date attributes,
 * then those whose (first 200) values nearly all read as times.
 */
export function timeFields(fields: readonly Field[], features: readonly FeatureLike[]): TimeField[] {
  const sample = features.length > 200 ? features.filter((_, i) => i % Math.ceil(features.length / 200) === 0) : features;
  const found: Array<TimeField & { rank: number }> = [];
  for (const field of fields) {
    if (field.type === 'oid') continue;
    let hint: TimeHint | null = null;
    if (field.type === 'date') hint = 'date';
    else {
      const year = YEAR_NAME.test(field.name) || YEAR_NAME.test(field.alias);
      const values = sample.map((f) => f.get(field.name)).filter((v) => v !== null && v !== undefined && v !== '');
      if (!values.length) continue;
      const kind: TimeHint = year ? 'year' : 'text';
      const read = values.filter((v) => parseTime(v, kind) !== null).length;
      if (read / values.length >= 0.8) hint = kind;
    }
    if (!hint) continue;
    const named = TIME_NAME.test(field.name) || TIME_NAME.test(field.alias);
    found.push({ name: field.name, hint, rank: (hint === 'date' ? 0 : 2) + (named ? 0 : 1) });
  }
  return found.sort((a, b) => a.rank - b.rank).map(({ name, hint }) => ({ name, hint }));
}

/**
 * The attributes the timeline starts with for a layer: the first time
 * attribute, and, when it names a start (`start_date`), the one naming an end.
 * Esri layers' own `timeInfo` wins when given.
 */
export function defaultTimeFields(candidates: readonly TimeField[], given?: { start?: string; end?: string }): { start: TimeField | null; end: TimeField | null } {
  const byName = (name?: string) => (name ? (candidates.find((c) => c.name === name) ?? null) : null);
  if (given?.start && byName(given.start)) return { start: byName(given.start), end: byName(given.end) };
  const start = candidates.find((c) => START_NAME.test(c.name)) ?? candidates[0] ?? null;
  const end = start && START_NAME.test(start.name) ? (candidates.find((c) => c !== start && END_NAME.test(c.name)) ?? null) : null;
  return { start, end };
}

/** The time in a file name (`S2A_20240501T012345_…`, `img_2024-05-01.tif`), or null. */
export function timeFromName(name: string): number | null {
  const base = name.replace(/^.*[/\\]/, '');
  const patterns = [
    /(?<!\d)((?:19|20)\d{2})(\d{2})(\d{2})[T_-]?(\d{2})(\d{2})(\d{2})(?!\d)/,
    /(?<!\d)((?:19|20)\d{2})[-_.](\d{2})[-_.](\d{2})(?:[T_ -](\d{2})[-_:.]?(\d{2})(?:[-_:.]?(\d{2}))?)?(?!\d)/,
    /(?<!\d)((?:19|20)\d{2})(\d{2})(\d{2})(?!\d)/,
  ];
  for (const re of patterns) {
    const m = re.exec(base);
    if (!m) continue;
    const t = local(n(m[1]), n(m[2]), n(m[3]), n(m[4]), n(m[5]), n(m[6]));
    if (t !== null) return t;
  }
  return null;
}

/** Item names of GDAL metadata that say when an image was taken, best first. */
const ACQUISITION = [
  /^(acquisition|acq)_?(start_?)?(date_?time|time|date)?(_utc)?$/i,
  /collect(ion)?_?start|first_?line_?time|sensing_?(start|time)|imaging_?date_?time|scene_?(center_?)?time|start_?time/i,
  /^(image|imaging|acquisition|capture)_?date$/i,
  /date_?time|datetime/i,
];

/**
 * When an image was taken, from its GDAL metadata (TIFF tag 42112): the
 * acquisition items satellite products write, or null.
 */
export function timeFromGdalMetadata(xml: string): number | null {
  const items: Array<[string, string]> = [];
  for (const m of xml.matchAll(/<Item\b[^>]*\bname="([^"]+)"[^>]*>([^<]*)<\/Item>/g)) items.push([m[1], m[2].trim()]);
  for (const re of ACQUISITION) {
    for (const [name, value] of items) {
      if (!re.test(name)) continue;
      const t = parseTime(value);
      if (t !== null) return t;
    }
  }
  // IMAGING_DATE + IMAGING_TIME, as two items.
  const date = items.find(([k]) => /^imaging_?date$/i.test(k))?.[1];
  const time = items.find(([k]) => /^imaging_?time$/i.test(k))?.[1];
  return date && time ? parseTime(`${date}T${time}`) : null;
}

/** Calendar units of the time axis. */
export type TimeUnit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

export const unitNames: Record<TimeUnit, string> = { second: '秒', minute: '分', hour: '時間', day: '日', week: '週', month: 'か月', year: '年' };

const FIXED: Partial<Record<TimeUnit, number>> = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 };

/** `t` moved by `count` units, along the local calendar (a month after Jan 31 is the end of February). */
export function addTime(t: number, unit: TimeUnit, count: number): number {
  const d = new Date(t);
  switch (unit) {
    case 'year':
    case 'month': {
      const months = unit === 'year' ? count * 12 : count;
      const day = d.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + months);
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, last));
      return d.getTime();
    }
    case 'day':
    case 'week':
      d.setDate(d.getDate() + count * (unit === 'week' ? 7 : 1));
      return d.getTime();
    default:
      return t + count * FIXED[unit]!;
  }
}

/** The start of the `count`-unit step `t` is in (local calendar: years at 1 January, weeks on Mondays). */
export function floorTime(t: number, unit: TimeUnit, count = 1): number {
  const d = new Date(t);
  switch (unit) {
    case 'year':
      return new Date(Math.floor(d.getFullYear() / count) * count, 0, 1).getTime();
    case 'month': {
      const months = d.getFullYear() * 12 + d.getMonth();
      const m = Math.floor(months / count) * count;
      return new Date(Math.floor(m / 12), m % 12, 1).getTime();
    }
    case 'week': {
      const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
      return day.getTime();
    }
    case 'day': {
      const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      if (count > 1) day.setDate(1 + Math.floor((day.getDate() - 1) / count) * count);
      return day.getTime();
    }
    default: {
      const size = FIXED[unit]! * count;
      // Whole hours and minutes in local time.
      const offset = new Date(t).getTimezoneOffset() * 60_000;
      return Math.floor((t - offset) / size) * size + offset;
    }
  }
}

/** A step of the time axis. */
export interface TimeStep {
  unit: TimeUnit;
  count: number;
}

const STEPS: TimeStep[] = [
  { unit: 'second', count: 1 },
  { unit: 'second', count: 10 },
  { unit: 'minute', count: 1 },
  { unit: 'minute', count: 5 },
  { unit: 'minute', count: 15 },
  { unit: 'hour', count: 1 },
  { unit: 'hour', count: 3 },
  { unit: 'hour', count: 6 },
  { unit: 'hour', count: 12 },
  { unit: 'day', count: 1 },
  { unit: 'week', count: 1 },
  { unit: 'month', count: 1 },
  { unit: 'month', count: 3 },
  { unit: 'month', count: 6 },
  { unit: 'year', count: 1 },
  { unit: 'year', count: 2 },
  { unit: 'year', count: 5 },
  { unit: 'year', count: 10 },
  { unit: 'year', count: 25 },
  { unit: 'year', count: 50 },
  { unit: 'year', count: 100 },
];

/** Rough length of a step, in ms. */
export function stepLength({ unit, count }: TimeStep): number {
  const day = 86_400_000;
  const size = FIXED[unit] ?? (unit === 'month' ? 30.44 * day : 365.25 * day);
  return size * count;
}

/** The smallest step at least `ms` long. */
export function stepAtLeast(ms: number): TimeStep {
  return STEPS.find((s) => stepLength(s) >= ms) ?? STEPS[STEPS.length - 1];
}

/** The step starts between `from` and `to`. */
export function stepsBetween(from: number, to: number, step: TimeStep, max = 2000): number[] {
  const out: number[] = [];
  let t = floorTime(from, step.unit, step.count);
  while (t <= to && out.length < max) {
    if (t >= from) out.push(t);
    const next = addTime(t, step.unit, step.count);
    if (next <= t) break;
    t = next;
  }
  return out;
}

const pad = (v: number) => String(v).padStart(2, '0');

/** A time as text, as precisely as `unit` needs (local time). */
export function formatTime(t: number, unit: TimeUnit = 'second'): string {
  const d = new Date(t);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  switch (unit) {
    case 'year':
      return String(d.getFullYear());
    case 'month':
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    case 'week':
    case 'day':
      return date;
    case 'hour':
    case 'minute':
      return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    default:
      return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
}

/** The unit a time needs to be shown exactly: `day` for midnight, `minute` for whole minutes… */
export function unitOf(t: number): TimeUnit {
  const d = new Date(t);
  if (d.getSeconds() || d.getMilliseconds()) return 'second';
  if (d.getHours() || d.getMinutes()) return 'minute';
  return 'day';
}

/** A time span as text: `2024-05-01 – 2024-05-31`. */
export function formatSpan(from: number, to: number): string {
  const unit = [unitOf(from), unitOf(to)].includes('second') ? 'second' : [unitOf(from), unitOf(to)].includes('minute') ? 'minute' : 'day';
  return `${formatTime(from, unit)} – ${formatTime(to, unit)}`;
}

/** A time as ISO 8601 UTC (WMS `TIME`): `2024-05-01T00:00:00Z`. */
export function isoTime(t: number): string {
  return new Date(t).toISOString().replace(/\.000Z$/, 'Z');
}

/** Reads an ISO 8601 duration (`P1D`, `PT6H`, `P1M`, `P1Y2M`) as a calendar step list. */
export function parseDuration(text: string): Array<[TimeUnit, number]> | null {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text.trim());
  if (!m || text.trim() === 'P' || text.trim().endsWith('T')) return null;
  const units: TimeUnit[] = ['year', 'month', 'week', 'day', 'hour', 'minute', 'second'];
  const out: Array<[TimeUnit, number]> = [];
  units.forEach((u, i) => {
    const v = m[i + 1];
    if (v && Number(v) > 0) out.push([u, Number(v)]);
  });
  return out.length ? out : null;
}

/**
 * A time as a WMS server writes it: ISO 8601 in UTC when no zone is given
 * (`2024-05-01`, `2024-05-01T10:00`, `2024`), or null.
 */
export function utcTime(text: string): number | null {
  const t = text.trim();
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})$/.exec(t))) return Date.UTC(Number(m[1]), 0, 1);
  if ((m = /^(\d{4})-(\d{2})$/.exec(t))) return Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return parseTime(`${t}T00:00:00Z`);
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(t)) return parseTime(`${t}Z`);
  return parseTime(t);
}

/**
 * The times a WMS time dimension offers (`2024-01-01,2024-02-01` or
 * `2024-01-01/2024-12-31/P1M`, or a mix), at most `max` of them; an
 * interval without a period gives its two ends. `dateOnly` when every
 * value is a day, to be asked for as one (`TIME=2024-05-01`).
 */
export function wmsTimes(values: string, max = 5000): { times: number[]; dateOnly: boolean } {
  const out: number[] = [];
  let dateOnly = true;
  for (const part of values.split(',')) {
    const [a, b, period] = part.trim().split('/');
    const from = utcTime(a ?? '');
    if (from === null) continue;
    if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(a.trim())) dateOnly = false;
    const to = b ? utcTime(b) : null;
    const step = period ? parseDuration(period) : null;
    if (step?.some(([unit]) => unit === 'hour' || unit === 'minute' || unit === 'second')) dateOnly = false;
    if (to === null) out.push(from);
    else if (!step) out.push(from, to);
    else {
      let t = from;
      while (t <= to && out.length < max) {
        out.push(t);
        // Along the UTC calendar: shift by the zone offset, step locally, shift back.
        const next = step.reduce((v, [unit, count]) => addUtc(v, unit, count), t);
        if (next <= t) break;
        t = next;
      }
    }
    if (out.length >= max) break;
  }
  return { times: [...new Set(out)].sort((x, y) => x - y), dateOnly: dateOnly && out.length > 0 };
}

function addUtc(t: number, unit: TimeUnit, count: number): number {
  const d = new Date(t);
  switch (unit) {
    case 'year':
      d.setUTCFullYear(d.getUTCFullYear() + count);
      return d.getTime();
    case 'month':
      d.setUTCMonth(d.getUTCMonth() + count);
      return d.getTime();
    case 'week':
      return t + count * 7 * 86_400_000;
    case 'day':
      return t + count * 86_400_000;
    default:
      return t + count * FIXED[unit]!;
  }
}

/** A time for a WMS `TIME` parameter: the UTC day, or the UTC time. */
export function wmsTimeText(t: number, dateOnly: boolean): string {
  return dateOnly ? new Date(t).toISOString().slice(0, 10) : isoTime(t);
}

/**
 * The timeline's filter of a vector layer: the time span of each feature
 * (null: none, so not shown) and the window shown; a feature is shown when
 * its span meets the window.
 */
export interface TimeFilter {
  span: (feature: FeatureLike) => readonly [number, number] | null;
  window: readonly [number, number];
}
