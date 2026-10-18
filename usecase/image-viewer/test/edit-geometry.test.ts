import { describe, expect, it } from 'vitest';
import LineString from 'ol/geom/LineString.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import { fromLonLat } from 'ol/proj.js';
import {
  fitToType,
  mergeGeometries,
  moveBy,
  offsetCoordinates,
  offsetGeometry,
  polygonOf,
  rectangleRing,
  regularRing,
  rotateBy,
  splitGeometry,
} from '../src/edit-geometry.js';
import { geodesicArea, geodesicDestination, geodesicInverse, geodesicLength } from '../src/geodesic.js';
import type { LonLat } from '../src/coordinates.js';

const tokyo: LonLat = [139.7671, 35.6812];

describe('shapes from numbers', () => {
  it('makes a rectangle of the typed sides on the ground, counter-clockwise', () => {
    const ring = rectangleRing(tokyo, 200, 100);
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
    expect(geodesicArea(ring.slice(0, 4)).area).toBeCloseTo(20_000, -1);
    // The far sides are a few millimetres off: a rectangle on the ellipsoid is not quite closed.
    expect(geodesicLength(ring)).toBeCloseTo(600, 1);
    // Counter-clockwise: positive shoelace sum.
    let sum = 0;
    for (let i = 1; i < ring.length; i++) sum += (ring[i][0] - ring[i - 1][0]) * (ring[i][1] + ring[i - 1][1]);
    expect(sum).toBeLessThan(0);
  });

  it('turns a rectangle by its angle', () => {
    const ring = rectangleRing(tokyo, 100, 50, 30);
    // From the corner, the side "up" heads 30° east of north.
    const up = ring.find((p) => Math.abs(geodesicInverse(tokyo, p).distance - 50) < 0.01)!;
    expect(geodesicInverse(tokyo, up).bearing).toBeCloseTo(30, 6);
  });

  it('puts a regular polygon\'s corners at the radius', () => {
    const ring = regularRing(tokyo, 500, 6);
    expect(ring).toHaveLength(7);
    for (const p of ring) expect(geodesicInverse(tokyo, p).distance).toBeCloseTo(500, 6);
    expect(geodesicInverse(tokyo, ring[0]).bearing).toBeCloseTo(0, 6);
  });

  it('finds a point by distance and bearing, and back', () => {
    const p = geodesicDestination(tokyo, 45, 1000);
    const back = geodesicInverse(tokyo, p);
    expect(back.distance).toBeCloseTo(1000, 6);
    expect(back.bearing).toBeCloseTo(45, 6);
  });
});

describe('moving and turning by numbers', () => {
  it('moves by metres on the ground, not map units', () => {
    const point = new Point(fromLonLat(tokyo));
    moveBy([point], 'EPSG:3857', 100, -50);
    const [lon, lat] = new Point(point.getCoordinates()).transform('EPSG:3857', 'EPSG:4326').getCoordinates();
    const r = geodesicInverse(tokyo, [lon, lat]);
    expect(r.distance).toBeCloseTo(Math.hypot(100, 50), 0);
  });

  it('turns clockwise about the middle', () => {
    const line = new LineString([
      [0, 0],
      [0, 10],
    ]);
    rotateBy([line], 90);
    const [[x1, y1], [x2, y2]] = line.getCoordinates();
    expect([x1, y1, x2, y2].map((v) => Math.round(v))).toEqual([-5, 5, 5, 5]);
  });
});

describe('parallel lines', () => {
  it('shifts a line to its left with sharp corners', () => {
    const out = offsetCoordinates(
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      1,
    );
    expect(out.map((p) => p.map((v) => Math.round(v * 1000) / 1000))).toEqual([
      [0, 1],
      [9, 1],
      [9, 10],
    ]);
  });

  it('grows and shrinks a polygon by metres', () => {
    const square = polygonOf(rectangleRing(tokyo, 100, 100), 'EPSG:3857');
    const grown = offsetGeometry(square, 'EPSG:3857', 10) as Polygon;
    const area = (p: Polygon) => geodesicArea(p.clone().transform('EPSG:3857', 'EPSG:4326').getCoordinates()[0].slice(0, -1) as LonLat[]).area;
    expect(area(grown)).toBeCloseTo(120 * 120, -2);
    expect(offsetGeometry(square, 'EPSG:3857', -60)).toBeNull();
  });
});

describe('splitting and merging', () => {
  const knife = new LineString([
    [5, -5],
    [5, 15],
  ]);

  it('cuts a line where the knife crosses, keeping its vertices', () => {
    const line = new LineString([
      [0, 0],
      [3, 1],
      [6, 0],
      [12, 0],
    ]);
    const pieces = splitGeometry(line, knife)!.map((g) => (g as LineString).getCoordinates());
    expect(pieces).toHaveLength(2);
    expect(pieces[0].slice(0, 2)).toEqual([
      [0, 0],
      [3, 1],
    ]);
    expect(pieces[0][2][1]).toBeCloseTo(1 / 3);
    expect(pieces[1][0][0]).toBeCloseTo(5);
    expect(pieces[1].slice(1)).toEqual([
      [6, 0],
      [12, 0],
    ]);
  });

  it('cuts a polygon in two, and refuses a knife that misses', () => {
    const square = new Polygon([
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ]);
    const pieces = splitGeometry(square, knife)!;
    expect(pieces).toHaveLength(2);
    expect(pieces.map((p) => (p as Polygon).getArea()).sort()).toEqual([50, 50]);
    expect(splitGeometry(square, new LineString([[20, 0], [20, 10]]))).toBeNull();
    // Into the polygon but not across it: no cut.
    expect(splitGeometry(square, new LineString([[5, -5], [5, 5]]))).toBeNull();
  });

  it('dissolves touching polygons and joins lines end to end', () => {
    const a = new Polygon([[[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]]]);
    const b = new Polygon([[[5, 0], [10, 0], [10, 5], [5, 5], [5, 0]]]);
    const merged = mergeGeometries([a, b]) as Polygon;
    expect(merged.getType()).toBe('Polygon');
    expect(merged.getArea()).toBe(50);
    const joined = mergeGeometries([new LineString([[0, 0], [5, 0]]), new LineString([[5, 0], [5, 5]])]);
    expect(joined?.getType()).toBe('LineString');
    expect((joined as LineString).getCoordinates()).toHaveLength(3);
    expect(mergeGeometries([new Point([0, 0]), new Point([1, 1])])?.getType()).toBe('MultiPoint');
  });

  it('fits a geometry to the layer\'s type', () => {
    const square = new Polygon([[[0, 0], [1, 0], [1, 1], [0, 0]]]);
    expect(fitToType(square, 'MultiPolygon')?.getType()).toBe('MultiPolygon');
    expect(fitToType(new MultiPolygon([square.getCoordinates()]), 'Polygon')?.getType()).toBe('Polygon');
    expect(fitToType(new MultiPolygon([square.getCoordinates(), square.getCoordinates()]), 'Polygon')).toBeNull();
    expect(fitToType(square, 'LineString')).toBeNull();
    expect(fitToType(square, null)).toBe(square);
  });
});
