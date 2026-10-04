/**
 * Voronoi (Thiessen) polygons: the area nearer each point than any other.
 * The points are moved to a local azimuthal equidistant projection centred on
 * the layer, so the cells are measured in metres on the ground; long cell
 * edges are densified there so that they keep their shape back on the map.
 */
import { Delaunay } from 'd3-delaunay';
import Feature from 'ol/Feature.js';
import type Geometry from 'ol/geom/Geometry.js';
import Point from 'ol/geom/Point.js';
import MultiPoint from 'ol/geom/MultiPoint.js';
import Polygon from 'ol/geom/Polygon.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import GeometryCollection from 'ol/geom/GeometryCollection.js';
import { createEmpty, extend, isEmpty } from 'ol/extent.js';
import { aeqd, attributesOf, centerOf, copyFields, field, fromLocal, toLocal, type ProcessingInput, type ProcessingResult } from './common.js';
import { fromJsts, intersection, toJsts, union, type JstsGeometry } from './jsts.js';

export interface VoronoiOptions {
  /** Space added around the points' extent, in % of its width and height (default 10). */
  margin?: number;
  /** Copy each point's attributes to its cell (Thiessen polygons) instead of numbering the cells. */
  keepAttributes: boolean;
  /** Polygon features (`EPSG:3857`) the cells are cut to. */
  clip?: Feature[] | null;
}

/** Longest straight piece of a cell edge in the local plane (m), and the most pieces an edge is cut into. */
const STEP = 1000;
const MAX_PIECES = 64;

/** A ring with long edges cut into pieces (the last point repeats the first). */
function densify(ring: number[][], step: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const pieces = Math.min(MAX_PIECES, Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step)));
    for (let k = 0; k < pieces; k++) out.push([x0 + ((x1 - x0) * k) / pieces, y0 + ((y1 - y0) * k) / pieces]);
  }
  out.push([...out[0]]);
  return out;
}

/** The polygons of a geometry made by an overlay (which may hold lines or points too); null when none. */
function polygonal(geometry: Geometry | null): Polygon | MultiPolygon | null {
  if (!geometry) return null;
  if (geometry instanceof Polygon || geometry instanceof MultiPolygon) return geometry;
  if (geometry instanceof GeometryCollection) {
    const polygons: number[][][][] = [];
    for (const part of geometry.getGeometries()) {
      if (part instanceof Polygon) polygons.push(part.getCoordinates());
      else if (part instanceof MultiPolygon) polygons.push(...part.getCoordinates());
    }
    if (polygons.length === 0) return null;
    return polygons.length === 1 ? new Polygon(polygons[0]) : new MultiPolygon(polygons);
  }
  return null;
}

/**
 * Voronoi cells of the points of `input` (ボロノイ分割), or, with
 * `keepAttributes`, Thiessen polygons carrying their point's attributes
 * (ティーセンポリゴン). Cells fill the points' extent widened by `margin` %,
 * cut to `clip` when given.
 */
export function voronoi(input: ProcessingInput, options: VoronoiOptions): ProcessingResult {
  const margin = (options.margin ?? 10) / 100;
  const extent = createEmpty();
  for (const feature of input.features) {
    const g = feature.getGeometry();
    if (g instanceof Point || g instanceof MultiPoint) extend(extent, g.getExtent());
  }
  if (isEmpty(extent)) throw new Error('ポイントがありません（ボロノイ分割にはポイントレイヤーが必要です）');
  const local = aeqd(centerOf(extent));

  // The points in metres, each with the feature it came from; exact duplicates are left out.
  const points: Array<{ xy: [number, number]; feature: Feature }> = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const feature of input.features) {
    const g = feature.getGeometry();
    const coordinates = g instanceof Point ? [g.getCoordinates()] : g instanceof MultiPoint ? g.getCoordinates() : [];
    for (const c of coordinates) {
      const key = `${c[0]},${c[1]}`;
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      const xy = (toLocal(new Point(c), local) as Point).getCoordinates();
      points.push({ xy: [xy[0], xy[1]], feature });
    }
  }
  if (points.length < 2) throw new Error('位置の異なるポイントが 2 つ以上必要です');

  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const { xy: [x, y] } of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  // Points in a line have no width (or height): pad that side like the other.
  const padX = (maxX - minX) * margin || (maxY - minY) * margin || 1;
  const padY = (maxY - minY) * margin || (maxX - minX) * margin || 1;
  const bounds = [minX - padX, minY - padY, maxX + padX, maxY + padY];
  const step = Math.max(STEP, Math.hypot(bounds[2] - bounds[0], bounds[3] - bounds[1]) / (MAX_PIECES * 4));

  let clip: JstsGeometry | null = null;
  if (options.clip) {
    const parts = options.clip
      .map((f) => f.getGeometry())
      .filter((g): g is Polygon | MultiPolygon => g instanceof Polygon || g instanceof MultiPolygon)
      .map((g) => toJsts(toLocal(g, local)));
    if (parts.length === 0) throw new Error('切り抜きに使うポリゴンがありません');
    clip = union(parts);
  }

  const diagram = Delaunay.from(points.map((p) => p.xy)).voronoi(bounds as [number, number, number, number]);
  const features: Feature[] = [];
  let clippedAway = 0;
  points.forEach((point, i) => {
    const cell = diagram.cellPolygon(i);
    if (!cell) return;
    let geometry: Geometry | null = new Polygon([densify(cell, step)]);
    if (clip) {
      geometry = polygonal(fromJsts(intersection(toJsts(geometry), clip)));
      if (!geometry) {
        clippedAway++;
        return;
      }
    }
    const feature = new Feature();
    if (options.keepAttributes) feature.setProperties(attributesOf(point.feature));
    else feature.set('id', i + 1);
    feature.setGeometry(fromLocal(geometry, local));
    features.push(feature);
  });

  const notes = [`${features.length} 個のセルを作りました`];
  if (duplicates > 0) notes.push(`同じ位置のポイント ${duplicates} 個を除きました（最初のものを使用）`);
  if (clippedAway > 0) notes.push(`切り抜き範囲の外のセル ${clippedAway} 個を除きました`);
  return {
    title: options.keepAttributes ? `${input.title}_ティーセン` : `${input.title}_ボロノイ`,
    features,
    fields: options.keepAttributes ? copyFields(input.fields) : [field('id', 'integer')],
    crs: input.crs,
    notes,
  };
}
