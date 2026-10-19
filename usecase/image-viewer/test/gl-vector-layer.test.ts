import { describe, expect, it } from 'vitest';
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import MultiPoint from 'ol/geom/MultiPoint.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import { GlVectorLayer, polygonVertices, type GlPaint } from '../src/gl-vector-layer.js';
import { labelThinner } from '../src/vector-style.js';

/*
 * What the WebGL vector layer keeps for the GPU (no WebGL here): triangles,
 * segments and points cut once from each geometry, a row of colors per
 * feature, and old shapes cleared out when many are left behind.
 */

const paint: GlPaint = { fill: [255, 0, 0, 0.5], stroke: [0, 0, 255, 1], width: 2 };

interface Inside {
  fills_: { length: number; data: Float32Array };
  indices_: { length: number; data: Uint32Array };
  lines_: { length: number; data: Float32Array };
  points_: { length: number; data: Float32Array };
  data_: Float32Array;
  entries_: Map<Feature, { slot: number }>;
  garbage_: number;
  compact_(): void;
}
const inside = (layer: GlVectorLayer) => layer as unknown as Inside;
const row = (layer: GlVectorLayer, feature: Feature) => {
  const slot = inside(layer).entries_.get(feature)!.slot;
  return Array.from(inside(layer).data_.subarray(slot * 16, slot * 16 + 12));
};

describe('GlVectorLayer', () => {
  it('cuts polygons (with holes), lines and points once into triangles, segments and points', () => {
    const layer = new GlVectorLayer();
    const outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const hole = [[2, 2], [2, 4], [4, 4], [4, 2], [2, 2]];
    layer.draw(new Feature(new Polygon([outer, hole])), paint);
    const s = inside(layer);
    // 8 corners, 8 triangles; the two rings' outlines are 8 segments.
    expect(s.fills_.length / 5).toBe(10);
    expect(s.indices_.length / 3).toBe(8);
    expect(s.lines_.length / 12).toBe(8);
    layer.draw(new Feature(new LineString([[0, 0], [3, 4], [3, 10]])), paint);
    expect(s.lines_.length / 12).toBe(10);
    // The second segment starts 5 units along the line.
    expect(s.lines_.data[9 * 12 + 9]).toBe(5);
    layer.draw(new Feature(new MultiPoint([[1, 1], [2, 2]])), paint);
    layer.draw(new Feature(new Point([5, 5])), paint);
    expect(s.points_.length / 8).toBe(3);
    expect(layer.count).toBe(4);
  });

  it('keeps coordinates of millions of meters to the millimeter (high and low parts)', () => {
    const layer = new GlVectorLayer();
    const x = 15_560_123.4567;
    layer.draw(new Feature(new Point([x, 4_250_000.0012])), paint);
    const d = inside(layer).points_.data;
    expect(d[0] + d[2]).toBeCloseTo(x, 3);
    expect(d[1] + d[3]).toBeCloseTo(4_250_000.0012, 3);
  });

  it('writes colors, width, time and whether it shows as one row; restyling changes only that row', () => {
    const layer = new GlVectorLayer();
    const f = new Feature(new LineString([[0, 0], [1, 1]]));
    layer.draw(f, paint, { t0: 10, t1: 20 });
    expect(row(layer, f)).toEqual([1, 0, 0, 0.5, 0, 0, 1, 1, 2, 10, 20, 1]);
    const segments = inside(layer).lines_.length;
    layer.draw(f, null);
    expect(row(layer, f).slice(8)).toEqual([0, 0, 0, 0]);
    expect(inside(layer).lines_.length).toBe(segments);
  });

  it('cuts a reshaped geometry again under a new number, and clears out what was left behind', () => {
    const layer = new GlVectorLayer();
    const f = new Feature(new LineString([[0, 0], [1, 1]]));
    const g = new Feature(new Point([3, 3]));
    layer.draw(f, paint);
    layer.draw(g, { ...paint, width: 5 });
    const before = inside(layer).entries_.get(f)!.slot;
    (f.getGeometry() as LineString).setCoordinates([[0, 0], [2, 2], [4, 0]]);
    layer.draw(f, paint);
    const after = inside(layer).entries_.get(f)!.slot;
    expect(after).not.toBe(before);
    // The old shape stays in the buffers, undrawn.
    expect(Array.from(inside(layer).data_.subarray(before * 16 + 8, before * 16 + 12))).toEqual([0, 0, 0, 0]);
    expect(inside(layer).lines_.length / 12).toBe(3);
    layer.remove(g);
    expect(inside(layer).garbage_).toBeGreaterThan(0);
    inside(layer).compact_();
    expect(inside(layer).garbage_).toBe(0);
    expect(inside(layer).lines_.length / 12).toBe(2);
    expect(inside(layer).points_.length).toBe(0);
    expect(inside(layer).entries_.get(f)!.slot).toBe(0);
    expect(row(layer, f)).toEqual([1, 0, 0, 0.5, 0, 0, 1, 1, 2, 0, 0, 1]);
  });

  it('places the corners of polygon and star symbols as OpenLayers does (first corner up)', () => {
    const square = polygonVertices({ kind: 'polygon', points: 4, radius: Math.SQRT2 * 5, angle: Math.PI / 4 });
    expect(Array.from(square).map((v) => Math.round(v * 1000) / 1000)).toEqual([5, -5, 5, 5, -5, 5, -5, -5]);
    const star = polygonVertices({ kind: 'polygon', points: 5, radius: 10, radius2: 4, angle: 0 });
    expect(star.length).toBe(20);
    expect(star[0]).toBeCloseTo(0);
    expect(star[1]).toBeCloseTo(-10);
  });
});

describe('labelThinner', () => {
  it('leaves out a label landing on another label in the same pass, and starts afresh in the next', async () => {
    const thin = labelThinner(10);
    const a = new Feature(new Point([0, 0]));
    const b = new Feature(new Point([3, 0]));
    const far = new Feature(new Point([100, 0]));
    const at = (f: Feature) => f.getGeometry() as Point;
    expect(thin(a, at(a), 'abcdef', 1)).toBe(true);
    expect(thin(b, at(b), 'abcdef', 1)).toBe(false);
    expect(thin(far, at(far), 'abcdef', 1)).toBe(true);
    // The same feature again (OpenLayers may style it twice).
    expect(thin(a, at(a), 'abcdef', 1)).toBe(true);
    // Zoomed in: 3 units are 30 pixels, apart enough.
    await Promise.resolve();
    expect(thin(b, at(b), 'abcdef', 0.1)).toBe(true);
    expect(thin(a, at(a), 'abcdef', 0.1)).toBe(true);
  });
});
