/**
 * Coordinate notations: latitude / longitude (decimal or degrees, minutes,
 * seconds), MGRS and UTM, written and read. Everything goes through WGS 84
 * longitude / latitude (`[lon, lat]`).
 *
 * UTM is written `54N 386543 3950123`: the zone, then N or S for the
 * hemisphere (as in "WGS 84 / UTM zone 54N"), easting and northing in metres.
 */
import { forward as toMgrs, toPoint as fromMgrs } from 'mgrs';
import proj4 from 'proj4';

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
  const [e, n] = proj4('EPSG:4326', utmProj(zone, north), lonLat);
  return `${zone}${north ? 'N' : 'S'} ${Math.round(e)} ${Math.round(n)}`;
}

/**
 * Reads a coordinate typed in any of the supported notations:
 * - latitude, longitude: `35.6812, 139.7671`, `35.6812 139.7671`,
 *   `N35.6812 E139.7671`, `139.7671E 35.6812N`, `35°40'52.3"N 139°46'1.6"E`
 *   (without N/S/E/W, latitude comes first);
 * - MGRS: `54SUE8843349290`, `54S UE 88433 49290` (any even number of digits);
 * - UTM: `54N 386543 3950123` (zone, N or S, easting, northing; `E`/`N` or `m` after the numbers are allowed).
 * Returns `[lon, lat]`, or null when the text is none of them.
 */
export function parseCoordinate(text: string): LonLat | null {
  const t = text.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!t) return null;
  return parseMgrs(t) ?? parseUtm(t) ?? parseLatLon(t);
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
  const [lon, lat] = proj4(utmProj(zone, m[2] === 'N'), 'EPSG:4326', [easting, northing]);
  return valid([lon, lat]);
}

function parseLatLon(t: string): LonLat | null {
  // Degree, minute and second marks become spaces; a comma separates the two values.
  const s = t.replace(/[°º˚'’′"”″]/g, ' ').replace(/(\d)D(?=[ \d])/g, '$1 ');
  let halves: string[];
  if (s.includes(',')) halves = s.split(',');
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
  const [d, m = 0, sec = 0] = rest.split(' ').map(Number);
  if (m >= 60 || sec >= 60) return null;
  let value = Math.abs(d) + m / 60 + sec / 3600;
  if (d < 0 || rest.startsWith('-') || letter === 'S' || letter === 'W') value = -value;
  return { value, axis: letter === 'N' || letter === 'S' ? 'lat' : letter === 'E' || letter === 'W' ? 'lon' : null };
}

function valid([lon, lat]: LonLat): LonLat | null {
  return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lon, lat] : null;
}

function utmProj(zone: number, north: boolean): string {
  return `+proj=utm +zone=${zone}${north ? '' : ' +south'} +datum=WGS84 +units=m +no_defs`;
}
