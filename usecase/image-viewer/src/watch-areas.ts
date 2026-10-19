/**
 * Features of the map as the areas of a catalog watch (catalog-watch.ts).
 */
import { MultiPoint, MultiPolygon, Point, Polygon, type Geometry } from 'ol/geom.js';
import { fromExtent } from 'ol/geom/Polygon.js';
import type { WatchArea } from './catalog-watch.js';

/**
 * Geometries of the map (in `projection`) as watch areas in longitude / latitude: their points as one
 * set of points, their polygons (the extent of anything else, such as a line) as one polygon.
 */
export function areasOf(geometries: Geometry[], projection: string): WatchArea[] {
  const points: number[][] = [];
  const rings: number[][][] = [];
  for (const geometry of geometries) {
    const g = geometry.clone().transform(projection, 'EPSG:4326');
    if (g instanceof Point) points.push(g.getCoordinates().slice(0, 2));
    else if (g instanceof MultiPoint) points.push(...g.getCoordinates().map((c) => c.slice(0, 2)));
    // Left-handed: outer rings clockwise, as Esri polygons have them.
    else if (g instanceof Polygon) rings.push(...g.getCoordinates(false));
    else if (g instanceof MultiPolygon) rings.push(...g.getCoordinates(false).flat());
    else {
      const extent = g.getExtent();
      if (extent.every(Number.isFinite)) rings.push(...fromExtent(extent).getCoordinates(false));
    }
  }
  return [...(points.length ? [{ kind: 'points' as const, points }] : []), ...(rings.length ? [{ kind: 'polygon' as const, rings }] : [])];
}
