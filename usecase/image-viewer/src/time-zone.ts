/**
 * The time zone a source's dates and times are really in, when it is not
 * the one the service says (config.json: `timeZone` on a source, or a
 * `timeZones` rule matching its URL).
 *
 * A source with a zone set has its date values read as clock times in that
 * zone, whatever the service declares: an Esri date (milliseconds, read by
 * the service as clock time in its own zone, UTC unless its
 * `dateFieldsTimeReference` says otherwise, or `serviceTimeZone`) and text
 * with or without a zone suffix (`2026-10-28T09:00:00Z` read as 09:00 in the
 * set zone). Edits sent back are written the same way, so the source keeps
 * its own clock. Sources without one are read as before.
 */
import { parseTime } from './time.js';

/** A time zone: an IANA name (`Asia/Tokyo`) or a fixed offset (`+09:00`). */
export interface TimeZone {
  /** As written in config.json, cleaned up (`Asia/Tokyo`, `UTC+09:00`). */
  name: string;
  /** Milliseconds the zone's clock is ahead of UTC at `instant`. */
  offset(instant: number): number;
}

function fixed(minutes: number): TimeZone {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const name = minutes === 0 ? 'UTC' : `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return { name, offset: () => minutes * 60_000 };
}

export const UTC: TimeZone = fixed(0);

const formatters = new Map<string, Intl.DateTimeFormat>();

function iana(name: string): TimeZone | null {
  let format = formatters.get(name);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat('en-US', { timeZone: name, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    } catch {
      return null;
    }
    formatters.set(name, format);
  }
  const f = format;
  return {
    name: f.resolvedOptions().timeZone,
    offset(instant) {
      if (!Number.isFinite(instant)) return 0;
      const parts: Record<string, number> = {};
      for (const p of f.formatToParts(new Date(instant))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
      const clock = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
      return clock - (instant - (((instant % 1000) + 1000) % 1000));
    },
  };
}

/** Windows zone names ArcGIS writes in `dateFieldsTimeReference`, as IANA names. */
const windowsZones: Record<string, string> = {
  'utc': 'UTC',
  'coordinated universal time': 'UTC',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul',
  'china standard time': 'Asia/Shanghai',
  'taipei standard time': 'Asia/Taipei',
  'singapore standard time': 'Asia/Singapore',
  'se asia standard time': 'Asia/Bangkok',
  'india standard time': 'Asia/Kolkata',
  'arabian standard time': 'Asia/Dubai',
  'w. europe standard time': 'Europe/Berlin',
  'romance standard time': 'Europe/Paris',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'e. europe standard time': 'Europe/Chisinau',
  'russian standard time': 'Europe/Moscow',
  'aus eastern standard time': 'Australia/Sydney',
  'new zealand standard time': 'Pacific/Auckland',
  'hawaiian standard time': 'Pacific/Honolulu',
  'alaskan standard time': 'America/Anchorage',
  'pacific standard time': 'America/Los_Angeles',
  'mountain standard time': 'America/Denver',
  'central standard time': 'America/Chicago',
  'eastern standard time': 'America/New_York',
};

/**
 * A zone from config.json or a service: an IANA name (`Asia/Tokyo`, `UTC`),
 * an offset (`+09:00`, `+0900`, `+9`, `UTC+9`, `GMT-05:30`) or a Windows
 * name (`Tokyo Standard Time`); null when it is none of these.
 */
export function parseTimeZone(value: unknown): TimeZone | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (/^(utc|gmt|z)$/i.test(text)) return UTC;
  const m = /^(?:utc|gmt)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(text);
  if (m) {
    const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
    if (minutes > 14 * 60) return null;
    return fixed(m[1] === '-' ? -minutes : minutes);
  }
  const windows = windowsZones[text.toLowerCase()];
  if (windows) return windows === 'UTC' ? UTC : iana(windows);
  return /^[A-Za-z][\w+-]*(\/[\w+-]+)*$/.test(text) ? iana(text) : null;
}

/** The instant a clock time in `zone` stands for (`clock`: the clock's fields as if UTC). */
export function instantOf(clock: number, zone: TimeZone): number {
  // The offset at the guess, then again at the result: right across daylight saving changes.
  const first = clock - zone.offset(clock);
  const second = clock - zone.offset(first);
  return second === first ? first : clock - zone.offset(second);
}

/** The clock time in `zone` at `instant` (its fields as if UTC). */
export function clockOf(instant: number, zone: TimeZone): number {
  return instant + zone.offset(instant);
}

/** How a source's times are read: the zone its values really are in, and the one the service reads them in. */
export interface TimeShift {
  /** The zone the data's clock times are in. */
  data: TimeZone;
  /** The zone the service reads its stored clock times in (Esri dates; UTC by default). */
  service: TimeZone;
}

/** A value from the service (milliseconds) as the instant it stands for. */
export function readInstant(raw: number, shift: TimeShift): number {
  if (!Number.isFinite(raw)) return raw;
  return instantOf(clockOf(raw, shift.service), shift.data);
}

/** An instant as the value the service keeps (milliseconds). */
export function writeInstant(instant: number, shift: TimeShift): number {
  if (!Number.isFinite(instant)) return instant;
  return instantOf(clockOf(instant, shift.data), shift.service);
}

/** Date and time as text (ISO 8601, `T` or a space, a zone suffix or none), as sources write them. */
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})([T ])(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;

/** The instant a date-time text stands for, read as clock time in `zone` (its own suffix ignored); null when it is not one. */
export function readTextInstant(text: string, zone: TimeZone): number | null {
  const m = DATE_TIME.exec(text.trim());
  if (!m) return null;
  const [, y, mo, d, , h, mi, s, f] = m;
  const clock = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0), f ? Math.round(Number(`0.${f}`) * 1000) : 0);
  return Number.isFinite(clock) ? instantOf(clock, zone) : null;
}

const pad = (n: number, size = 2) => String(n).padStart(size, '0');

/** Clock fields (as if UTC) as `yyyy-mm-ddThh:mm:ss(.sss)`. */
function clockText(clock: number, separator = 'T'): string {
  const d = new Date(clock);
  const ms = d.getUTCMilliseconds();
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}${separator}${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${ms ? `.${pad(ms, 3)}` : ''}`;
}

/** An offset as a suffix: `+09:00`, `Z` for none. */
function suffix(offset: number): string {
  if (offset === 0) return 'Z';
  const minutes = Math.round(Math.abs(offset) / 60_000);
  return `${offset < 0 ? '-' : '+'}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** An instant as text with this browser's offset (`2026-10-28T09:00:00+09:00`), how corrected text values are shown. */
export function localText(instant: number): string {
  const offset = -new Date(instant).getTimezoneOffset() * 60_000;
  return `${clockText(instant + offset)}${suffix(offset)}`;
}

/**
 * An instant written back the way the source wrote its text (`like`):
 * clock time in `zone`, with the same separator and the same kind of
 * suffix (`Z` stays `Z`, an offset stays one, none stays none).
 */
export function writeText(instant: number, zone: TimeZone, like: string): string {
  const m = DATE_TIME.exec(like.trim());
  const clock = clockOf(instant, zone);
  const text = clockText(clock, m?.[4] ?? 'T');
  const end = m?.[9];
  if (!end) return text;
  if (/^z$/i.test(end)) return `${text}${end}`;
  return `${text}${suffix(zone.offset(instant))}`;
}

/** Whether `value` is date-time text that {@link readTextInstant} reads. */
export function isDateTimeText(value: unknown): value is string {
  return typeof value === 'string' && DATE_TIME.test(value.trim());
}

/** What text date values are kept on: features and the like. */
export interface Attributed {
  getKeys(): string[];
  get(key: string): unknown;
  set(key: string, value: unknown, silent?: boolean): void;
}

/** The text date attributes of a source read in its zone, and how to write them back. */
export interface TextTimes {
  zone: TimeZone;
  /** The attributes changed, each with a value as the source wrote it (its form, for writing back). */
  fields: Map<string, string>;
  /** A value of `name` as the source writes it (others as they are). */
  back(name: string, value: unknown): unknown;
}

/**
 * Reads the date-time text attributes of `features` as clock times in
 * `zone` and writes them as the instants they stand for, with this
 * browser's offset (`2026-10-28T09:00:00+09:00`); null without a zone.
 */
export function shiftTexts(features: readonly Attributed[], zone: TimeZone | null | undefined): TextTimes | null {
  if (!zone) return null;
  const fields = new Map<string, string>();
  for (const f of features) {
    for (const key of f.getKeys()) {
      const v = f.get(key);
      if (!isDateTimeText(v)) continue;
      const t = readTextInstant(v, zone);
      if (t === null || !Number.isFinite(t)) continue;
      if (!fields.has(key)) fields.set(key, v);
      f.set(key, localText(t), true);
    }
  }
  return {
    zone,
    fields,
    back(name, value) {
      const like = fields.get(name);
      if (like === undefined || typeof value !== 'string' || !value.trim()) return value;
      const t = parseTime(value);
      return t === null ? value : writeText(t, zone, like);
    },
  };
}

// ---- Which sources have a zone ----

/** A zone for the sources whose URL matches. */
export interface TimeZoneRule {
  /** Tested against the URL (a layer's `…/FeatureServer/0`, a catalog's or a feed's URL). */
  match: RegExp;
  zone: TimeZone;
  /** The zone the service reads its stored values in; by default what the service says (Esri), or UTC. */
  service?: TimeZone;
  /** Shown in the layer's information. */
  label?: string;
}

let rules: TimeZoneRule[] = [];

/** Sets the rules (config.json's `timeZones` and every source's own `timeZone`); the first match wins. */
export function setTimeZoneRules(list: readonly TimeZoneRule[]): void {
  rules = [...list];
}

export function timeZoneRules(): readonly TimeZoneRule[] {
  return rules;
}

/** The rule for `url`, or undefined: the source is read as the service says. */
export function timeZoneRuleFor(url: string | undefined | null): TimeZoneRule | undefined {
  if (!url) return undefined;
  return rules.find((r) => r.match.test(url));
}

/** A rule for one source's URL and the layers under it (`…/FeatureServer` also matches `…/FeatureServer/0`). */
export function sourceRule(url: string, zone: TimeZone, service?: TimeZone | null, label?: string): TimeZoneRule {
  const clean = url.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { match: new RegExp(`^${escaped}(?:[/?#]|$)`, 'i'), zone, ...(service ? { service } : {}), ...(label ? { label } : {}) };
}

/** The shift as text for a layer's information: `Asia/Tokyo（サービス側: UTC）`. */
export function shiftText(shift: TimeShift): string {
  return `${shift.data.name}（サービス側: ${shift.service.name}）`;
}
