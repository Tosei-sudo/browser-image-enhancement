/**
 * Multipatch layers of Esri feature services (`esriGeometryMultiPatch`).
 *
 * The REST API documents two ways to get such a layer's shapes as JSON: the
 * footprint (`multipatchOption=xyFootprint`, a polygon) and, from ArcGIS
 * Enterprise 10.9, the 3D extent (`multipatchOption=extent`, five points
 * with the lowest and highest height). Each feature is shown as its
 * footprint in 2D and, in 3D, as the footprint raised from the lowest to the
 * highest height (a block, as LOD1 buildings are). Detailed 3D shapes are
 * what scene services (I3S) are for; the 3D view opens those.
 */
import type Feature from 'ol/Feature.js';
import type Polygon from 'ol/geom/Polygon.js';
import type MultiPolygon from 'ol/geom/MultiPolygon.js';
import { PATCH, setMultiPatch, type MultiPatch, type Patch } from '../multipatch.js';

/** The lowest and highest height of a `multipatchOption=extent` geometry (rings of x, y, z), or null without heights. */
export function extentHeights(geometry: unknown): [number, number] | null {
  const rings = (geometry as { rings?: unknown } | null)?.rings;
  if (!Array.isArray(rings)) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const ring of rings) {
    if (!Array.isArray(ring)) continue;
    for (const p of ring) {
      const z = Array.isArray(p) ? p[2] : undefined;
      if (typeof z !== 'number' || !Number.isFinite(z)) continue;
      min = Math.min(min, z);
      max = Math.max(max, z);
    }
  }
  return min <= max ? [min, max] : null;
}

/**
 * A block: `polygons` (each an outer ring then its holes; longitude,
 * latitude; closed or not) raised from `low` to `high` as a multipatch —
 * walls as triangle strips, the roof and the floor as rings.
 */
export function blockOf(polygons: number[][][][], low: number, high: number): MultiPatch {
  const patches: Patch[] = [];
  const open = (ring: number[][]) => (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring);
  for (const polygon of polygons) {
    const rings = polygon.map(open).filter((r) => r.length >= 3);
    for (const ring of rings) {
      const closed = [...ring, ring[0]];
      patches.push({ type: PATCH.strip, xyz: Float64Array.from(closed.flatMap(([x, y]) => [x, y, low, x, y, high])) });
    }
    for (const z of [high, low]) {
      rings.forEach((ring, i) => patches.push({ type: i ? PATCH.inner : PATCH.outer, xyz: Float64Array.from([...ring, ring[0]].flatMap(([x, y]) => [x, y, z])) }));
    }
  }
  return { patches };
}

/**
 * Gives each feature (its geometry a footprint in `toLonLat`'s projection)
 * the block of its heights, so the 3D view stands it up. Returns how many got one.
 */
export function raiseFootprints(features: readonly Feature[], heights: ReadonlyMap<unknown, [number, number]>, toLonLat: (xy: number[]) => number[]): number {
  let count = 0;
  for (const feature of features) {
    const range = heights.get(feature.getId());
    const geometry = feature.getGeometry() as Polygon | MultiPolygon | undefined;
    if (!range || !geometry) continue;
    const type = geometry.getType();
    const polygons = type === 'Polygon' ? [(geometry as Polygon).getCoordinates()] : type === 'MultiPolygon' ? (geometry as MultiPolygon).getCoordinates() : [];
    if (!polygons.length) continue;
    const lonLat = polygons.map((polygon) => polygon.map((ring) => ring.map((p) => toLonLat(p))));
    setMultiPatch(feature, blockOf(lonLat, range[0], range[1]));
    count++;
  }
  return count;
}
