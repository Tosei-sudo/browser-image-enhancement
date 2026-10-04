import { describe, expect, it } from 'vitest';
import Feature from 'ol/Feature.js';
import Polygon from 'ol/geom/Polygon.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import MultiPoint from 'ol/geom/MultiPoint.js';
import LineString from 'ol/geom/LineString.js';
import Point from 'ol/geom/Point.js';
import { fromLonLat, toLonLat } from 'ol/proj.js';
import { centroids } from '../src/processing/centroid.js';
import { field } from '../src/processing/common.js';
import { toJsts } from '../src/processing/jsts.js';

type Ring = Array<[number, number]>;

function polygon(rings: Ring[], properties: Record<string, unknown> = {}): Feature {
  const feature = new Feature(properties);
  feature.setGeometry(new Polygon(rings.map((ring) => ring.map((p) => fromLonLat(p)))));
  return feature;
}

function lonLatOf(feature: Feature): number[] {
  return toLonLat((feature.getGeometry() as Point).getCoordinates());
}

describe('centroids', () => {
  it('puts the centroid of a small square in Tokyo at its centre', () => {
    const square = polygon([[[139.76, 35.68], [139.78, 35.68], [139.78, 35.7], [139.76, 35.7], [139.76, 35.68]]]);
    const result = centroids({ title: 'sq', features: [square], fields: [] }, {});
    expect(result.title).toBe('sq_重心');
    const [lon, lat] = lonLatOf(result.features[0]);
    expect(lon).toBeCloseTo(139.77, 5);
    expect(lat).toBeCloseTo(35.69, 3);
  });

  it('subtracts holes', () => {
    const outer: Ring = [[0, 0], [0.02, 0], [0.02, 0.02], [0, 0.02], [0, 0]];
    const hole: Ring = [[0.011, 0.005], [0.019, 0.005], [0.019, 0.015], [0.011, 0.015], [0.011, 0.005]];
    const [lon] = lonLatOf(centroids({ title: 'h', features: [polygon([outer, hole])], fields: [] }, {}).features[0]);
    expect(lon).toBeLessThan(0.01);
  });

  it('moves a centroid outside a concave polygon inside with inside=true', () => {
    // A C shape opening to the east: its centroid falls in the opening.
    const c: Ring = [[0, 0], [0.03, 0], [0.03, 0.005], [0.005, 0.005], [0.005, 0.025], [0.03, 0.025], [0.03, 0.03], [0, 0.03], [0, 0]];
    const feature = polygon([c]);
    const shape = toJsts(feature.getGeometry()!);
    const plain = centroids({ title: 'c', features: [feature], fields: [] }, {}).features[0];
    expect(shape.contains(toJsts(plain.getGeometry()!))).toBe(false);
    const inside = centroids({ title: 'c', features: [feature], fields: [] }, { inside: true }).features[0];
    expect(shape.contains(toJsts(inside.getGeometry()!))).toBe(true);
  });

  it('is not pulled north by Web Mercator at high latitude', () => {
    // A triangle with its base in the south: on the mercator map the north is stretched, so its area there weighs more.
    const ring: Ring = [[20, 60], [30, 60], [25, 75], [20, 60]];
    const feature = polygon([ring]);
    const [, lat] = lonLatOf(centroids({ title: 't', features: [feature], fields: [] }, {}).features[0]);
    const mercator = toJsts(feature.getGeometry()!).getCentroid();
    const naive = toLonLat([mercator.getX(), mercator.getY()])[1];
    expect(naive).toBeGreaterThan(lat + 0.3);
    // Roughly a third of the way up from the base (65°), as on the ground.
    expect(lat).toBeGreaterThan(64);
    expect(lat).toBeLessThan(66);
  });

  it('weights lines by length and points equally', () => {
    const line = new Feature();
    line.setGeometry(new LineString([fromLonLat([0, 0]), fromLonLat([0.02, 0]), fromLonLat([0.02, 0.0001])]));
    const points = new Feature();
    points.setGeometry(new MultiPoint([fromLonLat([0, 0]), fromLonLat([0.03, 0]), fromLonLat([0.03, 0.03])]));
    const [a, b] = centroids({ title: 'x', features: [line, points], fields: [] }, {}).features.map(lonLatOf);
    expect(a[0]).toBeCloseTo(0.01, 4);
    expect(b[0]).toBeCloseTo(0.02, 4);
    expect(b[1]).toBeCloseTo(0.01, 4);
  });

  it('makes one point per part with perPart and copies attributes', () => {
    const multi = new Feature({ name: '島', id: 7 });
    const sq = (x: number): number[][] => [[x, 0], [x + 0.01, 0], [x + 0.01, 0.01], [x, 0.01], [x, 0]].map((p) => fromLonLat(p));
    multi.setGeometry(new MultiPolygon([[sq(0)], [sq(1)], [sq(2)]]));
    const fields = [field('id', 'oid'), field('name', 'string')];
    const whole = centroids({ title: 'm', features: [multi], fields }, {});
    expect(whole.features).toHaveLength(1);
    const parts = centroids({ title: 'm', features: [multi], fields }, { perPart: true });
    expect(parts.features).toHaveLength(3);
    expect(parts.features.map((f) => f.get('name'))).toEqual(['島', '島', '島']);
    expect(parts.features[2].get('id')).toBe(7);
    expect(lonLatOf(parts.features[1])[0]).toBeCloseTo(1.005, 6);
    expect(parts.fields.map((f) => [f.name, f.type])).toEqual([['id', 'integer'], ['name', 'string']]);
    expect(parts.features[0].getGeometry()).toBeInstanceOf(Point);
  });
});
