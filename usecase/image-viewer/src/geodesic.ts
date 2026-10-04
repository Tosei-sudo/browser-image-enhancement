/**
 * Distances and areas on the WGS 84 ellipsoid, with GeographicLib (Karney's
 * algorithms, accurate to a few nanometres anywhere on Earth, antipodes
 * included). turf's `distance` and `area` treat the Earth as a sphere, which
 * is off by up to about 0.5 %; these follow true geodesics on the ellipsoid.
 */
import * as geographiclib from 'geographiclib-geodesic';
import type { LonLat } from './coordinates.js';

// A CommonJS package: Node puts its exports under `default`, bundlers on the namespace.
const { Geodesic } = ((geographiclib as unknown as { default?: typeof geographiclib }).default ?? geographiclib) as typeof geographiclib;
const WGS84 = Geodesic.WGS84;

/** Length in metres of the geodesic path through `points`. */
export function geodesicLength(points: readonly LonLat[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const [lon1, lat1] = points[i - 1];
    const [lon2, lat2] = points[i];
    length += WGS84.Inverse(lat1, lon1, lat2, lon2, Geodesic.DISTANCE).s12 ?? 0;
  }
  return length;
}

/** Area (m²) and perimeter (m) of the polygon `ring` (not closed: the last point joins the first), edges being geodesics. */
export function geodesicArea(ring: readonly LonLat[]): { area: number; perimeter: number } {
  const polygon = WGS84.Polygon(false);
  for (const [lon, lat] of ring) polygon.AddPoint(lat, lon);
  const { area, perimeter } = polygon.Compute(false, true);
  // Signed by direction (counter-clockwise positive): either way round is the smaller area.
  return { area: Math.abs(area ?? 0), perimeter };
}

/** Longest straight piece (metres) a geodesic is cut into for drawing. */
const STEP = 10_000;
/** Most pieces per segment. */
const MAX_PIECES = 256;

/**
 * Points along the geodesics through `points` (and back to the first when
 * `closed`), close enough that straight lines between them draw the curve.
 * Longitudes are unrolled (they run past ±180° rather than jump), so a path
 * across the antimeridian stays continuous on the map. The given points are
 * kept as they are.
 */
export function geodesicPath(points: readonly LonLat[], closed = false): LonLat[] {
  if (points.length < 2) return points.map((p) => [p[0], p[1]]);
  const ends = closed ? [...points, points[0]] : points;
  const path: LonLat[] = [[ends[0][0], ends[0][1]]];
  for (let i = 1; i < ends.length; i++) {
    const [lon1, lat1] = ends[i - 1];
    const [lon2, lat2] = ends[i];
    const line = WGS84.InverseLine(lat1, lon1, lat2, lon2, Geodesic.STANDARD | Geodesic.DISTANCE_IN);
    const pieces = Math.min(MAX_PIECES, Math.max(1, Math.ceil(line.s13 / STEP)));
    for (let k = 1; k < pieces; k++) {
      const p = line.Position((line.s13 * k) / pieces, Geodesic.LATITUDE | Geodesic.LONGITUDE | Geodesic.LONG_UNROLL);
      path.push([p.lon2!, p.lat2!]);
    }
    path.push([lon2, lat2]);
  }
  return path;
}

/** A length for people: `850.3 m`, `12.345 km`. */
export function formatLength(metres: number): string {
  if (metres < 1000) return `${metres.toFixed(metres < 100 ? 2 : 1)} m`;
  const km = metres / 1000;
  return `${km.toLocaleString('ja-JP', { minimumFractionDigits: km < 100 ? 3 : 1, maximumFractionDigits: km < 100 ? 3 : 1 })} km`;
}

/** An area for people: `512.4 m²`, `3.25 ha`, `12.345 km²`. */
export function formatArea(squareMetres: number): string {
  if (squareMetres < 10_000) return `${squareMetres.toFixed(1)} m²`;
  if (squareMetres < 1_000_000) return `${(squareMetres / 10_000).toFixed(2)} ha`;
  const km2 = squareMetres / 1_000_000;
  return `${km2.toLocaleString('ja-JP', { minimumFractionDigits: km2 < 100 ? 3 : 1, maximumFractionDigits: km2 < 100 ? 3 : 1 })} km²`;
}
