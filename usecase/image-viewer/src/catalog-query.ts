/**
 * The conditions of an image catalog search as a `where` (SQL) for its Esri
 * layer, and the reading of its date-like values. Free of OpenLayers and of
 * the page, so the service worker's check for new images (catalog-watch.ts)
 * builds the same queries as the search panel.
 */
import type { CatalogConfig } from './catalog.js';

/** The Esri field types the viewer cares about, by name. */
export type FieldTypes = Record<string, string>;

/** A day as `yyyy-mm-dd`, as a date input gives it. */
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n: number) => String(n).padStart(2, '0');
/** `yyyy-mm-dd hh:mm:ss` in UTC, for TIMESTAMP literals. */
export const utcText = (time: number) => {
  const d = new Date(time);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};
/** The start of a local day, in milliseconds. */
const localDay = (day: string, plus = 0) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d + plus).getTime();
};
const nextDay = (day: string) => {
  const d = new Date(localDay(day, 1));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * A condition on a date-like field for local days `from` to `to` (both
 * included, either may be ''), written for the field's type: date fields
 * compare timestamps (UTC, as ArcGIS stores them), date-only fields dates,
 * numbers milliseconds, and text the leading `yyyy-mm-dd`.
 */
export function dayRange(field: string, type: string | undefined, from: string, to: string): string[] {
  const parts: string[] = [];
  const bound = (day: string, op: '>=' | '<') => {
    if (type === 'esriFieldTypeDate' || type === 'esriFieldTypeTimestampOffset') return `${field} ${op} TIMESTAMP '${utcText(localDay(day))}'`;
    if (type === 'esriFieldTypeDateOnly') return `${field} ${op} DATE '${day}'`;
    if (type && /Integer|Double|Single/.test(type)) return `${field} ${op} ${localDay(day)}`;
    return `${field} ${op} '${day}'`;
  };
  if (dayPattern.test(from)) parts.push(bound(from, '>='));
  if (dayPattern.test(to)) parts.push(bound(nextDay(to), '<'));
  return parts;
}

/** A SQL string literal. */
export const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** What the search panel asks for. */
export interface CatalogSearch {
  acquiredFrom: string;
  acquiredTo: string;
  registeredFrom: string;
  registeredTo: string;
  systemRegisteredFrom: string;
  systemRegisteredTo: string;
  /** '' for any sensor. */
  sensor: string;
  /** Upper limit of the angle; null for none. */
  maxAngle: number | null;
  /** Azimuth range in degrees; from > to goes through north (350 to 10). Null for no limit. */
  azimuthFrom: number | null;
  azimuthTo: number | null;
  /** Extra SQL, ANDed with the rest. */
  where: string;
}

export const emptySearch: CatalogSearch = {
  acquiredFrom: '',
  acquiredTo: '',
  registeredFrom: '',
  registeredTo: '',
  systemRegisteredFrom: '',
  systemRegisteredTo: '',
  sensor: '',
  maxAngle: null,
  azimuthFrom: null,
  azimuthTo: null,
  where: '',
};

/** The `where` of a search. */
export function whereOf(catalog: CatalogConfig, types: FieldTypes, search: CatalogSearch): string {
  const { fields } = catalog;
  const parts: string[] = [];
  if (catalog.where) parts.push(`(${catalog.where})`);
  if (fields.acquired) parts.push(...dayRange(fields.acquired, types[fields.acquired], search.acquiredFrom, search.acquiredTo));
  if (fields.registered) parts.push(...dayRange(fields.registered, types[fields.registered], search.registeredFrom, search.registeredTo));
  if (fields.sensor && search.sensor) parts.push(`${fields.sensor} = ${quote(search.sensor)}`);
  if (fields.systemRegistered) parts.push(...dayRange(fields.systemRegistered, types[fields.systemRegistered], search.systemRegisteredFrom, search.systemRegisteredTo));
  if (fields.angle && search.maxAngle !== null && Number.isFinite(search.maxAngle)) parts.push(`${fields.angle} <= ${search.maxAngle}`);
  if (fields.azimuth) {
    const ok = (v: number | null): v is number => v !== null && Number.isFinite(v);
    const [from, to] = [search.azimuthFrom, search.azimuthTo];
    if (ok(from) && ok(to) && from > to) parts.push(`(${fields.azimuth} >= ${from} OR ${fields.azimuth} <= ${to})`);
    else {
      if (ok(from)) parts.push(`${fields.azimuth} >= ${from}`);
      if (ok(to)) parts.push(`${fields.azimuth} <= ${to}`);
    }
  }
  if (search.where.trim()) parts.push(`(${search.where.trim()})`);
  return parts.length ? parts.join(' AND ') : '1=1';
}

/** A date-like value as milliseconds, for sorting and showing; NaN when it is not one. */
export function timeOf(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !value.trim()) return Number.NaN;
  // `2026-10-01 01:23:45` without a zone: as ArcGIS shows them, in UTC.
  const text = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value.trim()) ? `${value.trim().replace(' ', 'T')}Z` : value.trim();
  return Date.parse(text);
}
