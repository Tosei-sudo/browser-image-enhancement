/**
 * Buffer (like QGIS's "Buffer"), geodesic on the WGS 84 ellipsoid: a point's
 * buffer is a true geodesic circle, and lines and polygons are buffered in an
 * azimuthal equidistant projection centred on each feature, after their edges
 * are densified along geodesics so long edges keep their true shape.
 */
import Feature from 'ol/Feature.js';
import type Geometry from 'ol/geom/Geometry.js';
import Point from 'ol/geom/Point.js';
import MultiPoint from 'ol/geom/MultiPoint.js';
import LineString from 'ol/geom/LineString.js';
import MultiLineString from 'ol/geom/MultiLineString.js';
import Polygon from 'ol/geom/Polygon.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import GeometryCollection from 'ol/geom/GeometryCollection.js';
import { createEmpty, extend } from 'ol/extent.js';
import { fromLonLat, toLonLat } from 'ol/proj.js';
import type { LonLat } from '../coordinates.js';
import { geodesicPath } from '../geodesic.js';
import { aeqd, attributesOf, centerOf, copyFields, direct, fromLocal, toLocal, type ProcessingInput, type ProcessingResult } from './common.js';
import { buffer, fromJsts, toJsts, union, type CapStyle } from './jsts.js';

export type { CapStyle };

/** Options of {@link geodesicBuffer}. */
export interface BufferOptions {
  /** Metres; negative shrinks polygons (and empties points and lines). */
  distance: number;
  /** Segments per quarter circle (default 16). */
  segments?: number;
  /** Merge all buffers into one feature (without attributes). */
  dissolve?: boolean;
  /** End caps of lines (and the shape of a point's buffer); default round. */
  cap?: CapStyle;
}

/** The geodesic circle of `radius` metres around `center` (a closed ring of `vertices` + 1 points, longitude / latitude). */
function circle(center: LonLat, radius: number, vertices: number): LonLat[] {
  const ring: LonLat[] = [];
  // Counter-clockwise from north, as azimuths run clockwise.
  for (let i = 0; i < vertices; i++) ring.push(direct(center, -(360 * i) / vertices, radius));
  ring.push(ring[0]);
  return ring;
}

/** A coordinate list (`EPSG:3857`) densified along geodesics. */
function densifyPath(coordinates: number[][]): number[][] {
  return geodesicPath(coordinates.map((xy) => toLonLat(xy) as LonLat)).map((lonLat) => fromLonLat(lonLat));
}

/** A copy of a map geometry with every edge densified along its geodesic (points stay as they are). */
function densify(geometry: Geometry): Geometry {
  if (geometry instanceof LineString) return new LineString(densifyPath(geometry.getCoordinates()));
  if (geometry instanceof MultiLineString) return new MultiLineString(geometry.getCoordinates().map(densifyPath));
  if (geometry instanceof Polygon) return new Polygon(geometry.getCoordinates().map(densifyPath));
  if (geometry instanceof MultiPolygon) return new MultiPolygon(geometry.getCoordinates().map((polygon) => polygon.map(densifyPath)));
  if (geometry instanceof GeometryCollection) return new GeometryCollection(geometry.getGeometries().map(densify));
  return geometry.clone();
}

/** The buffer of one map geometry, in the map's projection; null when empty. */
function bufferGeometry(geometry: Geometry, distance: number, segments: number, cap: CapStyle): Geometry | null {
  const center = centerOf(geometry.getExtent());
  if (cap === 'round' && geometry instanceof Point) {
    if (distance <= 0) return null;
    return new Polygon([circle(center, distance, 4 * segments).map((lonLat) => fromLonLat(lonLat))]);
  }
  const projection = aeqd(center);
  if (cap === 'round' && geometry instanceof MultiPoint) {
    if (distance <= 0) return null;
    const circles = geometry.getCoordinates().map((xy) => {
      const ring = circle(toLonLat(xy) as LonLat, distance, 4 * segments).map((lonLat) => projection.forward(lonLat));
      return toJsts(new Polygon([ring]));
    });
    const merged = fromJsts(union(circles));
    return merged && fromLocal(merged, projection);
  }
  const grown = fromJsts(buffer(toJsts(toLocal(densify(geometry), projection)), distance, segments, cap));
  return grown && fromLocal(grown, projection);
}

/**
 * Buffers of the input's features, `options.distance` metres on the WGS 84
 * ellipsoid. Features whose buffer is empty (a zero or negative distance
 * around a point or line, or a polygon shrunk away) and features without a
 * geometry are left out and counted in the notes.
 */
export function geodesicBuffer(input: ProcessingInput, options: BufferOptions): ProcessingResult {
  const { distance, segments = 16, dissolve = false, cap = 'round' } = options;
  const buffered: { geometry: Geometry; source: Feature }[] = [];
  let noGeometry = 0;
  let emptied = 0;
  for (const feature of input.features) {
    const geometry = feature.getGeometry();
    if (!geometry) {
      noGeometry++;
      continue;
    }
    const result = bufferGeometry(geometry, distance, segments, cap);
    if (result) buffered.push({ geometry: result, source: feature });
    else emptied++;
  }

  let features: Feature[];
  if (dissolve) {
    features = [];
    if (buffered.length > 0) {
      const extent = createEmpty();
      for (const { geometry } of buffered) extend(extent, geometry.getExtent());
      const projection = aeqd(centerOf(extent));
      const merged = fromJsts(union(buffered.map(({ geometry }) => toJsts(toLocal(geometry, projection)))));
      if (merged) features.push(new Feature(fromLocal(merged, projection)));
    }
  } else {
    features = buffered.map(({ geometry, source }) => {
      const feature = new Feature();
      feature.setProperties(attributesOf(source));
      feature.setGeometry(geometry);
      return feature;
    });
  }

  const notes = [dissolve ? `${buffered.length} 件のバッファを 1 つに統合しました` : `${features.length} 件のバッファを作成しました`];
  if (emptied > 0) notes.push(`${emptied} 件はバッファが空になるため除外しました`);
  if (noGeometry > 0) notes.push(`${noGeometry} 件はジオメトリがないため除外しました`);
  return { title: `${input.title}_バッファ`, features, fields: dissolve ? [] : copyFields(input.fields), crs: input.crs, notes };
}
