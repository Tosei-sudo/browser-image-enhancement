import { describe, expect, it } from 'vitest';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import MultiPoint from 'ol/geom/MultiPoint.js';
import LineString from 'ol/geom/LineString.js';
import { fromLonLat, toLonLat } from 'ol/proj.js';
import { pointsToLine } from '../src/processing/points-to-line.js';
import { field } from '../src/processing/common.js';
import { geodesicLength } from '../src/geodesic.js';
import type { LonLat } from '../src/coordinates.js';

function point(lon: number, lat: number, properties: Record<string, unknown> = {}): Feature {
  const feature = new Feature(properties);
  feature.setGeometry(new Point(fromLonLat([lon, lat])));
  return feature;
}

function lonLats(feature: Feature): LonLat[] {
  return (feature.getGeometry() as LineString).getCoordinates().map((c) => toLonLat(c).map((v) => Math.round(v * 1e6) / 1e6) as LonLat);
}

const fields = [field('t', 'date'), field('n', 'double'), field('s', 'string'), field('g', 'string')];

describe('pointsToLine', () => {
  it('sorts by a date field as time, missing values last', () => {
    const features = [
      point(139.3, 35, { t: '2024-03-01T00:00:00Z' }),
      point(139.1, 35, { t: Date.UTC(2024, 0, 1) }),
      point(139.9, 35, { t: null }),
      point(139.2, 35, { t: '2024-02-01T00:00:00Z' }),
    ];
    const result = pointsToLine({ title: 'gps', features, fields }, { orderField: 't', groupField: null });
    expect(result.title).toBe('gps_ライン');
    expect(result.features).toHaveLength(1);
    const line = result.features[0];
    expect(lonLats(line).map((p) => p[0])).toEqual([139.1, 139.2, 139.3, 139.9]);
    expect(line.get('begin')).toBe(Date.UTC(2024, 0, 1));
    expect(line.get('end')).toBeNull();
    expect(line.get('points')).toBe(4);
    expect(result.fields.map((f) => [f.name, f.type])).toEqual([['begin', 'date'], ['end', 'date'], ['points', 'integer'], ['length_m', 'double']]);
  });

  it('sorts numbers numerically and text naturally, stably', () => {
    const numbers = [point(1, 0, { n: 10 }), point(2, 0, { n: 9 }), point(3, 0, { n: 100 }), point(4, 0, { n: 9 })];
    const byNumber = pointsToLine({ title: 'a', features: numbers, fields }, { orderField: 'n', groupField: null });
    expect(lonLats(byNumber.features[0]).map((p) => p[0])).toEqual([2, 4, 1, 3]);

    const texts = [point(1, 0, { s: 'p10' }), point(2, 0, { s: 'p9' }), point(3, 0, { s: '' }), point(4, 0, { s: 'p100' })];
    const byText = pointsToLine({ title: 'a', features: texts, fields }, { orderField: 's', groupField: null });
    expect(lonLats(byText.features[0]).map((p) => p[0])).toEqual([2, 1, 4, 3]);
  });

  it('keeps the layer order without an order field, multipoints in order', () => {
    const multi = new Feature();
    multi.setGeometry(new MultiPoint([fromLonLat([5, 0]), fromLonLat([6, 0])]));
    const result = pointsToLine({ title: 'a', features: [point(9, 0), multi, point(1, 0)], fields }, { orderField: null, groupField: null });
    expect(lonLats(result.features[0]).map((p) => p[0])).toEqual([9, 5, 6, 1]);
    expect(result.fields.map((f) => f.name)).toEqual(['points', 'length_m']);
  });

  it('makes a line per group, null its own, skipping short groups and non-points', () => {
    const notPoint = new Feature({ g: 'a' });
    notPoint.setGeometry(new LineString([fromLonLat([0, 0]), fromLonLat([1, 1])]));
    const features = [
      point(1, 0, { g: 'a', n: 2 }),
      point(2, 0, { g: 'b', n: 1 }),
      point(3, 0, { g: 'a', n: 1 }),
      point(4, 0, { g: null, n: 1 }),
      point(5, 0, { n: 2 }),
      point(6, 0, { g: 'c', n: 1 }),
      notPoint,
    ];
    const result = pointsToLine({ title: 'a', features, fields }, { orderField: 'n', groupField: 'g' });
    expect(result.features.map((f) => f.get('g'))).toEqual(['a', null]);
    expect(lonLats(result.features[0]).map((p) => p[0])).toEqual([3, 1]);
    expect(lonLats(result.features[1]).map((p) => p[0])).toEqual([4, 5]);
    expect(result.fields[0]).toMatchObject({ name: 'g', type: 'string' });
    expect(result.notes?.some((n) => n.includes('2 件'))).toBe(true);
    expect(result.notes?.some((n) => n.includes('点でない地物 1 件'))).toBe(true);
  });

  it('measures length_m along the ellipsoid', () => {
    const path: LonLat[] = [[139.7671, 35.6812], [139.7, 35.69], [139.69, 35.7]];
    const result = pointsToLine({ title: 'a', features: path.map(([lon, lat]) => point(lon, lat)), fields }, { orderField: null, groupField: null });
    expect(result.features[0].get('length_m')).toBeCloseTo(geodesicLength(path), 3);
    expect(result.features[0].get('length_m')).toBeGreaterThan(6000);
  });
});
