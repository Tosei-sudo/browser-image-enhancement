/**
 * Planar geometry operations (buffer, union, intersection) on OpenLayers
 * geometries, with JSTS (the JavaScript port of JTS, which QGIS's GEOS is a
 * port of too). Coordinates are taken as they are: callers move geometries
 * to a local projection in metres first (see `common.ts`).
 */
import GeometryFactory from 'jsts/org/locationtech/jts/geom/GeometryFactory.js';
import OL3Parser from 'jsts/org/locationtech/jts/io/OL3Parser.js';
import BufferOp from 'jsts/org/locationtech/jts/operation/buffer/BufferOp.js';
import BufferParameters from 'jsts/org/locationtech/jts/operation/buffer/BufferParameters.js';
import UnaryUnionOp from 'jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js';
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js';
import 'jsts/org/locationtech/jts/monkey.js';
import type Geometry from 'ol/geom/Geometry.js';
import Point from 'ol/geom/Point.js';
import LineString from 'ol/geom/LineString.js';
import LinearRing from 'ol/geom/LinearRing.js';
import Polygon from 'ol/geom/Polygon.js';
import MultiPoint from 'ol/geom/MultiPoint.js';
import MultiLineString from 'ol/geom/MultiLineString.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import GeometryCollection from 'ol/geom/GeometryCollection.js';

/** A JSTS geometry (its typings are loose). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JstsGeometry = any;

const factory = new GeometryFactory();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parser = new (OL3Parser as any)(factory, undefined);
parser.inject(Point, LineString, LinearRing, Polygon, MultiPoint, MultiLineString, MultiPolygon, GeometryCollection);

/** An OpenLayers geometry as a JSTS one. */
export function toJsts(geometry: Geometry): JstsGeometry {
  return parser.read(geometry);
}

/** A JSTS geometry as an OpenLayers one; null when empty. */
export function fromJsts(geometry: JstsGeometry): Geometry | null {
  if (!geometry || geometry.isEmpty()) return null;
  return parser.write(geometry) as Geometry;
}

/** End caps of a line's buffer. */
export type CapStyle = 'round' | 'flat' | 'square';

/**
 * `geometry` grown (or, for a negative distance, a polygon shrunk) by
 * `distance`, with `segments` segments per quarter circle.
 */
export function buffer(geometry: JstsGeometry, distance: number, segments = 16, cap: CapStyle = 'round'): JstsGeometry {
  const parameters = new BufferParameters(segments, { round: BufferParameters.CAP_ROUND, flat: BufferParameters.CAP_FLAT, square: BufferParameters.CAP_SQUARE }[cap]);
  return BufferOp.bufferOp(geometry, distance, parameters);
}

/** Everything in `geometries` merged into one. */
export function union(geometries: JstsGeometry[]): JstsGeometry {
  return UnaryUnionOp.union(factory.createGeometryCollection(geometries));
}

/** Where `a` and `b` overlap. */
export function intersection(a: JstsGeometry, b: JstsGeometry): JstsGeometry {
  return OverlayOp.intersection(a, b);
}

/** A rectangle polygon. */
export function box(minX: number, minY: number, maxX: number, maxY: number): JstsGeometry {
  return toJsts(new Polygon([[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]]));
}
