/**
 * Coordinate notations: latitude / longitude (decimal or degrees, minutes,
 * seconds), MGRS and UTM, written and read. Everything goes through WGS 84
 * longitude / latitude (`[lon, lat]`).
 *
 * UTM is written `54N 386543 3950123`: the zone, then N or S for the
 * hemisphere (as in "WGS 84 / UTM zone 54N"), easting and northing in metres.
 */
import { forward as toMgrs, toPoint as fromMgrs } from 'mgrs';
import { fromUtm, toUtm } from './utm.js';

/** WGS 84 longitude and latitude in degrees, longitude first (as GeoJSON). */
export type LonLat = [number, number];

/** `35.681240, 139.767100` (latitude first). */
export function formatLatLon([lon, lat]: LonLat): string {
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

/** `54S UE 88433 49290` (1 m precision); null outside the MGRS area (the poles). */
export function formatMgrs(lonLat: LonLat): string | null {
  try {
    const m = /^(\d{1,2}[A-Z])([A-Z]{2})(\d{5})(\d{5})$/.exec(toMgrs(lonLat, 5));
    return m ? `${m[1]} ${m[2]} ${m[3]} ${m[4]}` : null;
  } catch {
    return null;
  }
}

/** The UTM zone of a point, with the Norway and Svalbard exceptions (as MGRS uses). */
export function utmZone(lonLat: LonLat): number | null {
  try {
    return Number(/^\d{1,2}/.exec(toMgrs(lonLat, 1))![0]);
  } catch {
    return null;
  }
}

/** The EPSG code of a UTM zone on WGS 84. */
export function utmEpsg(zone: number, north: boolean): string {
  return `EPSG:${(north ? 32600 : 32700) + zone}`;
}

/** `54N 386543 3950123`; null outside UTM (beyond 84°N / 80°S). */
export function formatUtm(lonLat: LonLat): string | null {
  const zone = utmZone(lonLat);
  if (zone === null) return null;
  const north = lonLat[1] >= 0;
  const [e, n] = toUtm(lonLat, zone, north);
  return `${zone}${north ? 'N' : 'S'} ${Math.round(e)} ${Math.round(n)}`;
}

/**
 * Reads a coordinate typed in any of the supported notations:
 * - latitude, longitude, in decimal degrees or degrees, minutes and seconds:
 *   `35.6812, 139.7671`, `N35.6812 E139.7671`, `139.7671E 35.6812N`,
 *   `35°40'52.3"N 139°46'1.6"E`, `35 40 52.3 139 46 1.6`, `35d40m52s N`,
 *   `北緯35度40分52秒 東経139度46分1秒`, packed `354052N 1394601E`,
 *   `lat 35.68 lon 139.76`, `POINT(139.76 35.68)` (WKT, longitude first),
 *   full-width digits and Japanese punctuation. Without N/S/E/W or a label,
 *   latitude comes first, unless only the first value can be a longitude
 *   (`139.76, 35.68`);
 * - MGRS: `54SUE8843349290`, `54S UE 88433 49290` (any even number of digits);
 * - UTM: `54N 386543 3950123` (zone, N or S, easting, northing; `E`/`N` or `m` after the numbers are allowed).
 * Returns `[lon, lat]`, or null when the text is none of them.
 */
export function parseCoordinate(text: string): LonLat | null {
  const t = normalize(text);
  if (!t) return null;
  return parseMgrs(t) ?? parseUtm(t) ?? parseWkt(t) ?? parseLatLon(t);
}

/** Full-width characters, Japanese words and marks, labels and odd minus signs to one plain form. */
function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212\uFE63\uFF0D]/g, '-')
    .replace(/[、，;；|\t]/g, ',')
    // Labels name the axis: `lat 35.6 lon 139.7`, `緯度: 35.6`; the sign stays with the number.
    .replace(/緯度\s*[:=]?\s*/g, ' N ')
    .replace(/経度\s*[:=]?\s*/g, ' E ')
    .replace(/北緯/g, ' N ')
    .replace(/南緯/g, ' S ')
    .replace(/東経/g, ' E ')
    .replace(/西経/g, ' W ')
    .replace(/度/g, '°')
    .replace(/分/g, "'")
    .replace(/秒/g, '"')
    .toUpperCase()
    .replace(/(?:LATITUDE|LAT)\s*[:=]?\s*/g, ' N ')
    .replace(/(?:LONGITUDE|LONG|LNG|LON)\s*[:=]?\s*/g, ' E ')
    .replace(/[()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** WKT `POINT(lon lat)`. */
function parseWkt(t: string): LonLat | null {
  const m = /^POINT ?Z? ?(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)(?: -?\d+(?:\.\d+)?)?$/.exec(t);
  return m ? valid([Number(m[1]), Number(m[2])]) : null;
}

function parseMgrs(t: string): LonLat | null {
  const compact = t.replace(/ /g, '');
  const m = /^(\d{1,2})([C-HJ-NP-X])([A-HJ-NP-Z]{2})(\d*)$/.exec(compact);
  if (!m || m[4].length % 2 !== 0 || m[4].length > 10 || Number(m[1]) < 1 || Number(m[1]) > 60) return null;
  try {
    const [lon, lat] = fromMgrs(compact);
    return valid([lon, lat]);
  } catch {
    return null;
  }
}

function parseUtm(t: string): LonLat | null {
  const m = /^(\d{1,2}) ?([NS])[ ,]+(\d+(?:\.\d+)?) ?(?:M ?)?E?[ ,]+(\d+(?:\.\d+)?) ?(?:M ?)?N?$/.exec(t);
  if (!m) return null;
  const zone = Number(m[1]);
  const easting = Number(m[3]);
  const northing = Number(m[4]);
  if (zone < 1 || zone > 60 || easting < 100_000 || easting > 900_000 || northing > 10_000_000) return null;
  const [lon, lat] = fromUtm([easting, northing], zone, m[2] === 'N');
  return valid([lon, lat]);
}

function parseLatLon(t: string): LonLat | null {
  // Degree, minute and second marks (also `35d40m52s`) become spaces; a comma separates the two values.
  const s = t
    .replace(/(\d) ?M ?(\d+(?:\.\d+)?) ?S(?![\d.])/g, '$1 $2 ')
    .replace(/(\d) ?D ?(?=[\d ]|$)/g, '$1 ')
    .replace(/(\d) ?M(?=[ \d]|$)/g, '$1 ')
    .replace(/[°º˚'’′‘`"”″“]/g, ' ')
    .replace(/ ?, ?/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
  let halves: string[];
  if (s.includes(',')) halves = s.split(',').filter((h) => h.trim());
  else {
    // Split at the hemisphere letters, else by the count of numbers.
    const numbers = s.match(/[-+]?\d+(?:\.\d+)?/g) ?? [];
    if (/[NSEW]/.test(s)) halves = splitByLetters(s);
    else if (numbers.length === 2 || numbers.length === 4 || numbers.length === 6) {
      const k = numbers.length / 2;
      halves = [numbers.slice(0, k).join(' '), numbers.slice(k).join(' ')];
    } else return null;
  }
  if (halves.length !== 2) return null;
  const parts = halves.map(readAngle);
  if (parts.some((p) => p === null)) return null;
  const [a, b] = parts as Array<{ value: number; axis: 'lat' | 'lon' | null }>;
  let lat: number;
  let lon: number;
  if (a.axis === 'lon' || b.axis === 'lat') [lon, lat] = [a.value, b.value];
  else if (!a.axis && !b.axis && Math.abs(a.value) > 90 && Math.abs(b.value) <= 90) [lon, lat] = [a.value, b.value];
  else [lat, lon] = [a.value, b.value];
  return valid([lon, lat]);
}

/** `N35 40 52 E139 46 1` or `35 40 52 N 139 46 1 E` → the two halves. */
function splitByLetters(s: string): string[] {
  const letters = [...s.matchAll(/[NSEW]/g)];
  if (letters.length !== 2) return [];
  const first = letters[0].index!;
  // A letter before the first number marks the start of each half; else it ends it.
  const leading = !/\d/.test(s.slice(0, first));
  const cut = leading ? letters[1].index! : first + 1;
  return [s.slice(0, cut), s.slice(cut)];
}

function readAngle(half: string): { value: number; axis: 'lat' | 'lon' | null } | null {
  const letter = /[NSEW]/.exec(half)?.[0] ?? null;
  const rest = half.replace(/[NSEW]/g, ' ').trim();
  if (!/^[-+]?\d+(?:\.\d+)?(?: \d+(?:\.\d+)?){0,2}$/.test(rest)) return null;
  const [d, m = 0, sec = 0] = rest.includes(' ') ? rest.split(' ').map(Number) : unpack(rest);
  if (m >= 60 || sec >= 60) return null;
  let value = Math.abs(d) + m / 60 + sec / 3600;
  if (d < 0 || rest.startsWith('-') || letter === 'S' || letter === 'W') value = -value;
  return { value, axis: letter === 'N' || letter === 'S' ? 'lat' : letter === 'E' || letter === 'W' ? 'lon' : null };
}

/**
 * One number: decimal degrees, or degrees, minutes and seconds written
 * together (`354052.3` = 35° 40′ 52.3″, `1394601`, `3540` = 35° 40′) when it
 * is too large to be degrees.
 */
function unpack(text: string): number[] {
  const value = Number(text);
  const digits = /^[-+]?(\d+)/.exec(text)![1];
  if (Math.abs(value) <= 180 || digits.length < 4 || digits.length > 7) return [value];
  const sign = text.startsWith('-') ? -1 : 1;
  const fraction = text.slice(text.indexOf(digits) + digits.length);
  if (digits.length <= 5) return [sign * Number(digits.slice(0, -2)), Number(digits.slice(-2) + fraction)];
  return [sign * Number(digits.slice(0, -4)), Number(digits.slice(-4, -2)), Number(digits.slice(-2) + fraction)];
}

function valid([lon, lat]: LonLat): LonLat | null {
  return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lon, lat] : null;
}
