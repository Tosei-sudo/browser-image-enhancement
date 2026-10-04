import { describe, expect, it } from 'vitest';
import Feature from 'ol/Feature.js';
import type Geometry from 'ol/geom/Geometry.js';
import Point from 'ol/geom/Point.js';
import LineString from 'ol/geom/LineString.js';
import Polygon from 'ol/geom/Polygon.js';
import { toLonLat } from 'ol/proj.js';
import type { LonLat } from '../src/coordinates.js';
import { geodesicArea } from '../src/geodesic.js';
import { geodesicBuffer } from '../src/processing/buffer.js';
import { direct, field, inverse, type ProcessingInput } from '../src/processing/common.js';
import { webMercator } from '../src/vector-write.js';

/** A layer of the given geometries (longitude / latitude), with an `id` and a `name` per feature. */
function layer(geometries: Geometry[]): ProcessingInput {
  const features = geometries.map((geometry, i) => new Feature({ geometry: geometry.transform('EPSG:4326', 'EPSG:3857'), id: i + 1, name: `f${i + 1}` }));
  return { title: 'テスト', features, fields: [field('id', 'oid'), field('name', 'string')] };
}

/** The outer ring of a polygon result in longitude / latitude. */
function outerRing(feature: Feature): LonLat[] {
  const polygon = feature.getGeometry() as Polygon;
  expect(polygon.getType()).toBe('Polygon');
  return polygon.getCoordinates()[0].map((xy) => toLonLat(xy) as LonLat);
}

describe('geodesicBuffer', () => {
  it.each([
    ['Tokyo', [139.7671, 35.6812]],
    ['60°N', [24.94, 60]],
  ] as [string, LonLat][])('makes a point buffer a geodesic circle (%s)', (_, center) => {
    const result = geodesicBuffer(layer([new Point(center)]), { distance: 1000, segments: 8 });
    expect(result.features).toHaveLength(1);
    const ring = outerRing(result.features[0]);
    expect(ring).toHaveLength(33);
    for (const vertex of ring) expect(inverse(center, vertex).distance).toBeCloseTo(1000, 3);
  });

  it('a 1 km point buffer covers about π km²', () => {
    const result = geodesicBuffer(layer([new Point([139.7671, 35.6812])]), { distance: 1000, segments: 32 });
    const { area } = geodesicArea(outerRing(result.features[0]).slice(0, -1));
    expect(Math.abs(area / (Math.PI * 1e6) - 1)).toBeLessThan(0.005);
  });

  it('buffers a line into a polygon whose boundary is the distance away', () => {
    const start: LonLat = [139.6, 35.6];
    const end = direct(start, 60, 20_000);
    const result = geodesicBuffer(layer([new LineString([start, end])]), { distance: 500 });
    const ring = outerRing(result.features[0]);
    const { azimuth, distance: length } = inverse(start, end);
    const samples = Array.from({ length: 4001 }, (_, i) => direct(start, azimuth, (length * i) / 4000));
    for (const vertex of ring) {
      const nearest = Math.min(...samples.map((p) => inverse(p, vertex).distance));
      expect(Math.abs(nearest - 500)).toBeLessThan(0.5);
    }
  });

  it('dissolves overlapping buffers into one polygon without attributes', () => {
    const a: LonLat = [139.7, 35.6];
    const result = geodesicBuffer(layer([new Point(a), new Point(direct(a, 90, 1500))]), { distance: 1000, dissolve: true });
    expect(result.features).toHaveLength(1);
    expect(result.features[0].getGeometry()!.getType()).toBe('Polygon');
    expect(result.fields).toEqual([]);
    expect(result.features[0].get('name')).toBeUndefined();
  });

  it('drops a polygon a negative buffer empties, with a note', () => {
    const small = new Polygon([[[139.7, 35.6], [139.701, 35.6], [139.701, 35.601], [139.7, 35.601], [139.7, 35.6]]]);
    const large = new Polygon([[[139.7, 35.6], [139.72, 35.6], [139.72, 35.62], [139.7, 35.62], [139.7, 35.6]]]);
    const result = geodesicBuffer(layer([small, large]), { distance: -100 });
    expect(result.features).toHaveLength(1);
    expect(result.features[0].get('name')).toBe('f2');
    expect(result.notes!.some((note) => note.startsWith('1 件'))).toBe(true);
    // The shrunk polygon lies inside the original.
    const inner = result.features[0].getGeometry()!.getExtent();
    const outer = large.getExtent(); // layer() moved it to EPSG:3857 in place
    expect(inner[0]).toBeGreaterThan(outer[0]);
    expect(inner[3]).toBeLessThan(outer[3]);
  });

  it('copies attributes and fields, skips features without geometry', () => {
    const input = layer([new Point([139.7, 35.6])]);
    input.features.push(new Feature({ id: 9, name: 'none' }));
    input.crs = webMercator;
    const result = geodesicBuffer(input, { distance: 10 });
    expect(result.title).toBe('テスト_バッファ');
    expect(result.crs).toBe(input.crs);
    expect(result.features).toHaveLength(1);
    expect(result.features[0].get('id')).toBe(1);
    expect(result.features[0].get('name')).toBe('f1');
    expect(result.fields.map((f) => [f.name, f.type])).toEqual([['id', 'integer'], ['name', 'string']]);
    expect(result.notes).toHaveLength(2);
  });
});
