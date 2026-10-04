/**
 * Centroids (QGIS "Centroids"): a point at the centre of mass of each
 * feature, worked out on the ground rather than on the Web Mercator map.
 */
import Feature from 'ol/Feature.js';
import type Geometry from 'ol/geom/Geometry.js';
import Point from 'ol/geom/Point.js';
import MultiPoint from 'ol/geom/MultiPoint.js';
import MultiLineString from 'ol/geom/MultiLineString.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import GeometryCollection from 'ol/geom/GeometryCollection.js';
import { aeqd, attributesOf, centerOf, copyFields, fromLocal, toLocal, type ProcessingInput, type ProcessingResult } from './common.js';
import { toJsts } from './jsts.js';

/** Options of {@link centroids}. */
export interface CentroidOptions {
  /** One point for each part of a multi geometry. */
  perPart?: boolean;
  /** For a polygon whose centroid falls outside it, a point inside it instead. */
  inside?: boolean;
}

/** The parts of a geometry (itself when it is not a multi geometry or a collection). */
function partsOf(geometry: Geometry): Geometry[] {
  if (geometry instanceof MultiPoint) return geometry.getPoints();
  if (geometry instanceof MultiLineString) return geometry.getLineStrings();
  if (geometry instanceof MultiPolygon) return geometry.getPolygons();
  if (geometry instanceof GeometryCollection) return geometry.getGeometries().flatMap(partsOf);
  return [geometry];
}

/**
 * The centroid of `geometry` (`EPSG:3857`), in `EPSG:3857`: computed in an
 * azimuthal equidistant projection centred on the geometry's extent, so that
 * Web Mercator's stretching towards the poles does not pull it. Polygons are
 * weighted by area (holes taking away), lines by length, points equally; a
 * mix counts only its highest dimension. Null when the geometry is empty.
 */
function centroidOf(geometry: Geometry, inside: boolean): Point | null {
  const extent = geometry.getExtent();
  if (!Number.isFinite(extent[0])) return null;
  const projection = aeqd(centerOf(extent));
  const local = toJsts(toLocal(geometry, projection));
  if (local.isEmpty()) return null;
  let point = local.getCentroid();
  if (inside && local.getDimension() === 2 && !local.contains(point)) point = local.getInteriorPoint();
  if (!point || point.isEmpty()) return null;
  return fromLocal(new Point([point.getX(), point.getY()]), projection) as Point;
}

/**
 * A point layer of the centroids of the features of `input` (one per part
 * with `perPart`), each with the attributes of its feature.
 */
export function centroids(input: ProcessingInput, options: CentroidOptions = {}): ProcessingResult {
  const { perPart = false, inside = false } = options;
  const features: Feature[] = [];
  let skipped = 0;
  for (const feature of input.features) {
    const geometry = feature.getGeometry();
    if (!geometry) {
      skipped++;
      continue;
    }
    const attributes = attributesOf(feature);
    let made = 0;
    for (const part of perPart ? partsOf(geometry) : [geometry]) {
      const point = centroidOf(part, inside);
      if (!point) continue;
      const result = new Feature(attributes);
      result.setGeometry(point);
      features.push(result);
      made++;
    }
    if (!made) skipped++;
  }
  const notes = [`重心 ${features.length} 点を作成しました`];
  if (skipped) notes.push(`形状のない地物 ${skipped} 件を飛ばしました`);
  return { title: `${input.title}_重心`, features, fields: copyFields(input.fields), crs: input.crs, notes };
}
