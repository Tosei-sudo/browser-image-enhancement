/**
 * Geometry for the edit tools: shapes from numbers (a rectangle from a
 * corner and its sides in metres, a circle or regular polygon from its
 * centre and radius, on the ellipsoid), moving and rotating by numbers,
 * parallel lines (offsets), splitting along a drawn line and merging.
 * Geometries are in the map's projection; lengths the person types are
 * metres on the ground.
 */
import type Geometry from 'ol/geom/Geometry.js';
import LineString from 'ol/geom/LineString.js';
import MultiLineString from 'ol/geom/MultiLineString.js';
import MultiPoint from 'ol/geom/MultiPoint.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import { boundingExtent, getCenter } from 'ol/extent.js';
import { fromLonLat, getPointResolution, toLonLat, type ProjectionLike } from 'ol/proj.js';
import BufferOp from 'jsts/org/locationtech/jts/operation/buffer/BufferOp.js';
import BufferParameters from 'jsts/org/locationtech/jts/operation/buffer/BufferParameters.js';
import LineMerger from 'jsts/org/locationtech/jts/operation/linemerge/LineMerger.js';
import Polygonizer from 'jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js';
import type { LonLat } from './coordinates.js';
import type { DrawableType } from './edit-session.js';
import { geodesicDestination } from './geodesic.js';
import { fromJsts, toJsts, union, type JstsGeometry } from './processing/jsts.js';

type Coordinate = number[];

/**
 * The corners of a rectangle (closed ring, longitude and latitude): from
 * `corner`, `width` metres to the right (east when `angle` is 0; negative:
 * to the left) and `height` metres up (north; negative: down), turned
 * `angle` degrees clockwise.
 */
export function rectangleRing(corner: LonLat, width: number, height: number, angle = 0): LonLat[] {
  const right = geodesicDestination(corner, angle + 90, width);
  const up = geodesicDestination(corner, angle, height);
  const far = geodesicDestination(right, angle, height);
  const ring = [corner, right, far, up, corner];
  // Counter-clockwise, as GeoJSON wants an outer ring.
  return width * height < 0 ? ring.reverse() : ring;
}

/** A regular polygon (closed ring) of `sides` corners `radius` metres from `centre`, the first at `angle` degrees clockwise from north. */
export function regularRing(centre: LonLat, radius: number, sides: number, angle = 0): LonLat[] {
  const ring: LonLat[] = [];
  // Counter-clockwise: bearings decrease.
  for (let i = 0; i < sides; i++) ring.push(geodesicDestination(centre, angle - (360 * i) / sides, radius));
  ring.push(ring[0]);
  return ring;
}

/** Corners per circle: smooth at any scale an edit is drawn at. */
export const CIRCLE_SIDES = 72;

/** A ring of longitudes and latitudes as a polygon in `projection`. */
export function polygonOf(ring: readonly LonLat[], projection: ProjectionLike): Polygon {
  return new Polygon([ring.map((p) => fromLonLat(p, projection))]);
}

/** The middle of the extent of `geometries`. */
export function centreOf(geometries: readonly Geometry[]): Coordinate {
  const corners = geometries.flatMap((g) => {
    const [minX, minY, maxX, maxY] = g.getExtent();
    return [
      [minX, minY],
      [maxX, maxY],
    ];
  });
  return getCenter(boundingExtent(corners));
}

/** Moves `geometries` (in place) `east` and `north` metres on the ground, measured at their middle. */
export function moveBy(geometries: readonly Geometry[], projection: ProjectionLike, east: number, north: number): void {
  if (!geometries.length) return;
  const from = centreOf(geometries);
  const lonLat = toLonLat(from, projection) as LonLat;
  const to = fromLonLat(geodesicDestination(geodesicDestination(lonLat, 90, east), 0, north), projection);
  for (const g of geometries) g.translate(to[0] - from[0], to[1] - from[1]);
}

/** Moves `geometries` (in place) so that their middle is at `to`. */
export function moveTo(geometries: readonly Geometry[], to: Coordinate): void {
  if (!geometries.length) return;
  const from = centreOf(geometries);
  for (const g of geometries) g.translate(to[0] - from[0], to[1] - from[1]);
}

/** Turns `geometries` (in place) `degrees` clockwise about `anchor` (their middle when not given). */
export function rotateBy(geometries: readonly Geometry[], degrees: number, anchor?: Coordinate): void {
  if (!geometries.length) return;
  const about = anchor ?? centreOf(geometries);
  // The map's projections are conformal, so angles there are angles on the ground.
  for (const g of geometries) g.rotate((-degrees * Math.PI) / 180, about);
}

/** Map units per metre on the ground at `at`. */
function unitsPerMetre(projection: ProjectionLike, at: Coordinate): number {
  return 1 / getPointResolution(projection, 1, at, 'm');
}

/**
 * A line `distance` away from `line` (map units), to its left (negative: its
 * right), corners kept sharp unless they are very sharp.
 */
export function offsetCoordinates(line: readonly Coordinate[], distance: number): Coordinate[] {
  const points = line.filter((p, i) => i === 0 || p[0] !== line[i - 1][0] || p[1] !== line[i - 1][1]);
  if (points.length < 2) return points.map((p) => [p[0], p[1]]);
  const normals: Coordinate[] = [];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    const length = Math.hypot(dx, dy);
    normals.push([-dy / length, dx / length]);
  }
  const out: Coordinate[] = [[points[0][0] + normals[0][0] * distance, points[0][1] + normals[0][1] * distance]];
  for (let i = 1; i < points.length - 1; i++) {
    const [ax, ay] = normals[i - 1];
    const [bx, by] = normals[i];
    const [px, py] = points[i];
    // The corner where the two shifted edges meet: along the bisector, 1 / cos(half the turn) farther.
    const mx = ax + bx;
    const my = ay + by;
    const cos = (mx * ax + my * ay) / (Math.hypot(mx, my) || 1);
    if (Math.hypot(mx, my) < 1e-9 || cos < 0.25) {
      // Nearly turning back: cut the corner rather than shoot far out.
      out.push([px + ax * distance, py + ay * distance], [px + bx * distance, py + by * distance]);
      continue;
    }
    const scale = distance / (Math.hypot(mx, my) * cos);
    out.push([px + mx * scale, py + my * scale]);
  }
  const last = points[points.length - 1];
  const n = normals[normals.length - 1];
  out.push([last[0] + n[0] * distance, last[1] + n[1] * distance]);
  return out;
}

/**
 * A parallel copy of `geometry` `metres` away on the ground: lines to their
 * left (negative: right), polygons grown (negative: shrunk), with sharp
 * corners. Null when nothing is left (a polygon shrunk away) or for points.
 */
export function offsetGeometry(geometry: Geometry, projection: ProjectionLike, metres: number): Geometry | null {
  const at = getCenter(geometry.getExtent());
  const distance = metres * unitsPerMetre(projection, at);
  switch (geometry.getType()) {
    case 'LineString':
      return new LineString(offsetCoordinates((geometry as LineString).getCoordinates(), distance));
    case 'MultiLineString':
      return new MultiLineString((geometry as MultiLineString).getCoordinates().map((line) => offsetCoordinates(line, distance)));
    case 'Polygon':
    case 'MultiPolygon': {
      const parameters = new BufferParameters(8, BufferParameters.CAP_FLAT, BufferParameters.JOIN_MITRE, 5);
      return fromJsts(BufferOp.bufferOp(toJsts(geometry), distance, parameters));
    }
    default:
      return null;
  }
}

/** Which kind a geometry is: point, line or polygon. */
export function familyOf(type: string): 'point' | 'line' | 'polygon' | null {
  if (type === 'Point' || type === 'MultiPoint') return 'point';
  if (type === 'LineString' || type === 'MultiLineString') return 'line';
  if (type === 'Polygon' || type === 'MultiPolygon') return 'polygon';
  return null;
}

/**
 * `geometry` as a layer of `type` holds it: a single part wrapped as a
 * multi one, or a multi one with one part unwrapped. Null when it does not
 * fit (another kind, or several parts for a single type); `type` null takes
 * anything.
 */
export function fitToType(geometry: Geometry, type: DrawableType | null): Geometry | null {
  if (!type) return geometry;
  const have = geometry.getType();
  if (have === type) return geometry;
  if (familyOf(have) !== familyOf(type)) return null;
  switch (type) {
    case 'MultiPoint':
      return new MultiPoint([(geometry as Point).getCoordinates()]);
    case 'MultiLineString':
      return new MultiLineString([(geometry as LineString).getCoordinates()]);
    case 'MultiPolygon':
      return new MultiPolygon([(geometry as Polygon).getCoordinates()]);
    case 'Point': {
      const parts = (geometry as MultiPoint).getCoordinates();
      return parts.length === 1 ? new Point(parts[0]) : null;
    }
    case 'LineString': {
      const parts = (geometry as MultiLineString).getCoordinates();
      return parts.length === 1 ? new LineString(parts[0]) : null;
    }
    case 'Polygon': {
      const parts = (geometry as MultiPolygon).getCoordinates();
      return parts.length === 1 ? new Polygon(parts[0]) : null;
    }
  }
}

/** The parts of a JSTS geometry. */
function partsOf(geometry: JstsGeometry): JstsGeometry[] {
  const parts: JstsGeometry[] = [];
  for (let i = 0; i < geometry.getNumGeometries(); i++) parts.push(geometry.getGeometryN(i));
  return parts;
}

/** `line` cut where it crosses `knife`: its pieces, the vertices kept. */
function cutLine(line: readonly Coordinate[], knife: readonly Coordinate[]): Coordinate[][] {
  const pieces: Coordinate[][] = [];
  let piece: Coordinate[] = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1];
    const [bx, by] = line[i];
    const cuts: number[] = [];
    for (let k = 1; k < knife.length; k++) {
      const [cx, cy] = knife[k - 1];
      const [dx, dy] = knife[k];
      const denominator = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
      if (denominator === 0) continue;
      const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / denominator;
      const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / denominator;
      // A crossing at a vertex counts once (as the start of the next edge); not at the line's first point, where a cut leaves nothing.
      if (u >= 0 && u <= 1 && t < 1 && (t > 0 || (t === 0 && i > 1))) cuts.push(t);
    }
    for (const t of cuts.sort((a, b) => a - b)) {
      const at = [ax + (bx - ax) * t, ay + (by - ay) * t];
      if (t > 0) piece.push(at);
      pieces.push(piece);
      piece = [at];
    }
    piece.push(line[i]);
  }
  pieces.push(piece);
  return pieces;
}

/**
 * `geometry` (a line or polygon, single or multi) cut along `cutter`: its
 * pieces, each a single line or polygon. Null when the cutter does not cut
 * it in two.
 */
export function splitGeometry(geometry: Geometry, cutter: LineString): Geometry[] | null {
  const family = familyOf(geometry.getType());
  const target = toJsts(geometry);
  const knife = toJsts(cutter);
  if (!target.intersects(knife)) return null;
  if (family === 'line') {
    const lines = geometry.getType() === 'LineString' ? [(geometry as LineString).getCoordinates()] : (geometry as MultiLineString).getCoordinates();
    const pieces = lines.flatMap((line) => cutLine(line, cutter.getCoordinates()));
    return pieces.length > lines.length ? pieces.map((line) => new LineString(line)) : null;
  }
  if (family !== 'polygon') return null;
  const polygonizer = new Polygonizer();
  polygonizer.add(target.getBoundary().union(knife));
  const pieces: JstsGeometry[] = [...polygonizer.getPolygons().toArray()].filter((p: JstsGeometry) => target.contains(p.getInteriorPoint()));
  if (pieces.length <= partsOf(target).length) return null;
  return pieces.map((p) => fromJsts(p)).filter((g): g is Geometry => g !== null);
}

/**
 * `geometries` (all lines or all polygons, or points) merged into one:
 * polygons dissolved, lines that meet end to end joined. A multi geometry
 * when they stay apart.
 */
export function mergeGeometries(geometries: readonly Geometry[]): Geometry | null {
  if (geometries.length === 0) return null;
  const family = familyOf(geometries[0].getType());
  if (!family || geometries.some((g) => familyOf(g.getType()) !== family)) return null;
  if (family === 'point') return new MultiPoint(geometries.flatMap((g) => (g.getType() === 'Point' ? [(g as Point).getCoordinates()] : (g as MultiPoint).getCoordinates())));
  const merged = union(geometries.map(toJsts));
  if (family === 'polygon') return fromJsts(merged);
  const merger = new LineMerger();
  merger.add(merged);
  const lines = [...merger.getMergedLineStrings().toArray()].map((l: JstsGeometry) => fromJsts(l) as LineString);
  return lines.length === 1 ? lines[0] : new MultiLineString(lines.map((l) => l.getCoordinates()));
}
