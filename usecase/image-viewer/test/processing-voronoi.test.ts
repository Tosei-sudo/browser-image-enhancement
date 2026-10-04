import { describe, expect, it } from 'vitest';
import Feature from 'ol/Feature.js';
import type Geometry from 'ol/geom/Geometry.js';
import Point from 'ol/geom/Point.js';
import MultiPoint from 'ol/geom/MultiPoint.js';
import Polygon from 'ol/geom/Polygon.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import { fromLonLat } from 'ol/proj.js';
import { aeqd, centerOf, field, toLocal, type LocalProjection, type ProcessingInput } from '../src/processing/common.js';
import { voronoi } from '../src/processing/voronoi.js';

/** Points around Tokyo, a few km apart. */
const lonLats: Array<[number, number]> = [
  [139.70, 35.65], [139.75, 35.68], [139.80, 35.66], [139.72, 35.72], [139.78, 35.73], [139.74, 35.62], [139.83, 35.70],
];

function layer(points = lonLats): ProcessingInput {
  return {
    title: '駅',
    features: points.map((p, i) => new Feature({ geometry: new Point(fromLonLat(p)), name: `p${i}`, n: i })),
    fields: [field('name', 'string'), { ...field('n', 'oid'), editable: false }],
  };
}

/** The same local plane the tool works in. */
function plane(input: ProcessingInput): LocalProjection {
  const extent = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of input.features) {
    const [x0, y0, x1, y1] = f.getGeometry()!.getExtent();
    extent[0] = Math.min(extent[0], x0);
    extent[1] = Math.min(extent[1], y0);
    extent[2] = Math.max(extent[2], x1);
    extent[3] = Math.max(extent[3], y1);
  }
  return aeqd(centerOf(extent));
}

function localArea(geometry: Geometry, local: LocalProjection): number {
  return (toLocal(geometry, local) as Polygon | MultiPolygon).getArea();
}

describe('voronoi', () => {
  it('makes one numbered cell per point, holding its point', () => {
    const input = layer();
    const result = voronoi(input, { keepAttributes: false });
    expect(result.title).toBe('駅_ボロノイ');
    expect(result.fields.map((f) => [f.name, f.type])).toEqual([['id', 'integer']]);
    expect(result.features).toHaveLength(lonLats.length);
    result.features.forEach((cell, i) => {
      expect(cell.get('id')).toBe(i + 1);
      expect(cell.get('name')).toBeUndefined();
      expect(cell.getGeometry()!.intersectsCoordinate(fromLonLat(lonLats[i]))).toBe(true);
      // No other point lies in it.
      lonLats.forEach((p, j) => {
        if (j !== i) expect(cell.getGeometry()!.intersectsCoordinate(fromLonLat(p))).toBe(false);
      });
    });
  });

  it('tiles the points’ extent widened by the margin', () => {
    const input = layer();
    const local = plane(input);
    const xy = lonLats.map((p) => local.forward(p));
    const width = Math.max(...xy.map((p) => p[0])) - Math.min(...xy.map((p) => p[0]));
    const height = Math.max(...xy.map((p) => p[1])) - Math.min(...xy.map((p) => p[1]));
    for (const margin of [10, 25]) {
      const total = voronoi(input, { keepAttributes: false, margin }).features.reduce((sum, f) => sum + localArea(f.getGeometry()!, local), 0);
      const k = 1 + (2 * margin) / 100;
      expect(total / (width * k * height * k)).toBeCloseTo(1, 4);
    }
  });

  it('keeps the point attributes for Thiessen polygons', () => {
    const result = voronoi(layer(), { keepAttributes: true });
    expect(result.title).toBe('駅_ティーセン');
    expect(result.fields.map((f) => [f.name, f.type, f.editable])).toEqual([['name', 'string', true], ['n', 'integer', true]]);
    expect(result.features.map((f) => f.get('name'))).toEqual(lonLats.map((_, i) => `p${i}`));
    expect(result.features[3].get('n')).toBe(3);
  });

  it('cuts the cells to the clip polygons and drops those outside', () => {
    const input = layer();
    const local = plane(input);
    // A square of about 4 km around the second point only, in two overlapping halves.
    const [lon, lat] = lonLats[1];
    const half = (w: number, e: number) => new Feature(new Polygon([[[w, lat - 0.02], [e, lat - 0.02], [e, lat + 0.02], [w, lat + 0.02], [w, lat - 0.02]].map((p) => fromLonLat(p))]));
    const clip = [half(lon - 0.02, lon + 0.005), half(lon - 0.005, lon + 0.02), new Feature(new Point(fromLonLat([lon, lat])))];
    const result = voronoi(input, { keepAttributes: true, clip });
    const whole = voronoi(input, { keepAttributes: true });
    expect(result.features.length).toBeGreaterThan(0);
    expect(result.features.length).toBeLessThan(whole.features.length);
    const clipArea = localArea(new Polygon([[[lon - 0.02, lat - 0.02], [lon + 0.02, lat - 0.02], [lon + 0.02, lat + 0.02], [lon - 0.02, lat + 0.02], [lon - 0.02, lat - 0.02]].map((p) => fromLonLat(p))]), local);
    const total = result.features.reduce((sum, f) => sum + localArea(f.getGeometry()!, local), 0);
    expect(total / clipArea).toBeCloseTo(1, 3);
    for (const cell of result.features) {
      const original = whole.features.find((f) => f.get('name') === cell.get('name'))!;
      expect(localArea(cell.getGeometry()!, local)).toBeLessThanOrEqual(localArea(original.getGeometry()!, local) * (1 + 1e-9));
    }
    expect(result.notes!.join('\n')).toContain('切り抜き範囲の外');
  });

  it('drops exact duplicates (the first is kept) and reads every point of a MultiPoint', () => {
    const input = layer(lonLats.slice(0, 3));
    input.features.push(new Feature({ geometry: new Point(fromLonLat(lonLats[0])), name: 'dup', n: 9 }));
    input.features.push(new Feature({ geometry: new MultiPoint([fromLonLat(lonLats[3]), fromLonLat(lonLats[4]), fromLonLat(lonLats[1])]), name: 'multi', n: 10 }));
    const result = voronoi(input, { keepAttributes: true });
    expect(result.features.map((f) => f.get('name'))).toEqual(['p0', 'p1', 'p2', 'multi', 'multi']);
    expect(result.notes!.join('\n')).toContain('同じ位置のポイント 2 個');
  });

  it('needs two distinct points', () => {
    expect(() => voronoi(layer([lonLats[0], lonLats[0]]), { keepAttributes: false })).toThrow('2 つ以上');
    expect(() => voronoi({ title: 'x', features: [], fields: [] }, { keepAttributes: false })).toThrow('ポイント');
  });

  it('handles points in a line', () => {
    const result = voronoi(layer([[139.7, 35.6], [139.8, 35.6], [139.9, 35.6]]), { keepAttributes: false });
    expect(result.features).toHaveLength(3);
    for (const f of result.features) expect((f.getGeometry() as Polygon).getArea()).toBeGreaterThan(0);
  });

  it('keeps the input CRS', () => {
    const input = { ...layer(), crs: { projection: 'EPSG:6677', name: 'IX', wkt: null, epsg: 6677 } };
    expect(voronoi(input, { keepAttributes: false }).crs).toBe(input.crs);
  });
});
