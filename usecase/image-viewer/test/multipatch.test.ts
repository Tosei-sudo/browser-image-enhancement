import { describe, expect, it } from 'vitest';
import type Feature from 'ol/Feature.js';
import { footprintOf, heightRange, multiPatchOf, PATCH, readMultiPatches, trianglesOf } from '../src/multipatch.js';
import { readShapefile } from '../src/vector-files.js';
import { boxBuilding, dbf, multipatchShp, ascii } from './fixtures.js';

/** Area of the triangles' projections on the x, y plane, each counted as positive. */
function flatArea(t: Float64Array): number {
  let area = 0;
  for (let i = 0; i < t.length; i += 9) area += Math.abs((t[i + 3] - t[i]) * (t[i + 7] - t[i + 1]) - (t[i + 6] - t[i]) * (t[i + 4] - t[i + 1])) / 2;
  return area;
}

/** Total area of the triangles in 3D. */
function area3d(t: Float64Array): number {
  let area = 0;
  for (let i = 0; i < t.length; i += 9) {
    const u = [t[i + 3] - t[i], t[i + 4] - t[i + 1], t[i + 5] - t[i + 2]];
    const v = [t[i + 6] - t[i], t[i + 7] - t[i + 1], t[i + 8] - t[i + 2]];
    area += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return area;
}

describe('readMultiPatches', () => {
  it('reads every patch with its type and heights', () => {
    const [shape] = readMultiPatches(multipatchShp([boxBuilding(0, 0, 10, 20, 5, 35)]));
    expect(shape!.patches.map((p) => p.type)).toEqual([PATCH.strip, PATCH.outer, PATCH.outer]);
    expect(shape!.patches[0].xyz.length).toBe(30);
    expect(Array.from(shape!.patches[1].xyz.slice(0, 6))).toEqual([0, 0, 35, 10, 0, 35]);
    expect(heightRange(shape!)).toEqual([5, 35]);
  });

  it('turns a box into triangles: four walls, a roof and a floor', () => {
    const [shape] = readMultiPatches(multipatchShp([boxBuilding(0, 0, 10, 20, 5, 35)]));
    const t = trianglesOf(shape!);
    // 8 wall triangles from the strip, 2 + 2 from the rings.
    expect(t.length / 9).toBe(12);
    // Walls 2 × (10 + 20) × 30 m, roof and floor 200 m² each.
    expect(area3d(t)).toBeCloseTo(1800 + 400, 6);
    expect(flatArea(t)).toBeCloseTo(400, 6);
  });

  it('cuts holes out of rings, and fans spread from their first point', () => {
    const ring = (z: number, ...xy: Array<[number, number]>) => xy.map(([x, y]) => [x, y, z] as [number, number, number]);
    const courtyard = [
      { type: PATCH.outer, points: ring(10, [0, 0], [10, 0], [10, 10], [0, 10], [0, 0]) },
      { type: PATCH.inner, points: ring(10, [4, 4], [4, 6], [6, 6], [6, 4], [4, 4]) },
    ];
    const fan = [{ type: PATCH.fan, points: ring(0, [0, 0], [1, 0], [1, 1], [0, 1]) }];
    const [a, b] = readMultiPatches(multipatchShp([courtyard, fan]));
    expect(flatArea(trianglesOf(a!))).toBeCloseTo(96, 6);
    expect(trianglesOf(b!).length / 9).toBe(2);
    expect(flatArea(trianglesOf(b!))).toBeCloseTo(1, 6);
    // The footprint keeps the hole.
    const [polygon] = footprintOf(a!);
    expect(polygon).toHaveLength(2);
  });

  it('a vertical ring (a wall) is triangulated in its own plane', () => {
    const wall = [{ type: PATCH.outer, points: [[0, 0, 0], [10, 0, 0], [10, 0, 5], [0, 0, 5], [0, 0, 0]] as Array<[number, number, number]> }];
    const [shape] = readMultiPatches(multipatchShp([wall]));
    expect(area3d(trianglesOf(shape!))).toBeCloseTo(50, 6);
    // Seen from above a wall has no footprint.
    expect(footprintOf(shape!)).toEqual([]);
  });
});

describe('readShapefile with multipatches', () => {
  it('opens footprints on the map and keeps the shapes for 3D', () => {
    const shapes = [boxBuilding(139.7, 35.68, 0.0001, 0.0002, 3, 33), boxBuilding(139.701, 35.68, 0.0001, 0.0001, 3, 13)];
    const file = readShapefile('buildings', {
      shp: multipatchShp(shapes),
      dbf: dbf([{ name: 'NAME', length: 4 }], [[ascii('A')], [ascii('B')]]),
    });
    expect(file.features).toHaveLength(2);
    expect(file.geometryType).toBe('Polygon');
    const f = file.features[0] as Feature;
    expect(f.get('NAME')).toBe('A');
    // The roof and the floor share an outline: one polygon.
    expect(f.getGeometry()!.getType()).toBe('MultiPolygon');
    const coordinates = (f.getGeometry() as unknown as { getCoordinates(): number[][][][] }).getCoordinates();
    expect(coordinates).toHaveLength(1);
    // In Web Mercator on the map, longitude / latitude with heights for 3D.
    expect(coordinates[0][0][0][0]).toBeCloseTo(15_551_332.86, 1);
    const shape = multiPatchOf(f)!;
    expect(shape.patches[1].xyz[0]).toBeCloseTo(139.7, 9);
    expect(heightRange(shape)).toEqual([3, 33]);
  });

  it('takes the .prj CRS to longitude and latitude', () => {
    // JGD2011 / Japan Plane Rectangular CS IX (EPSG:6677): its origin is 139° 50′ E, 36° N.
    const prj =
      'PROJCS["JGD2011 / Japan Plane Rectangular CS IX",GEOGCS["JGD2011",DATUM["Japanese_Geodetic_Datum_2011",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",36],PARAMETER["central_meridian",139.833333333333],PARAMETER["scale_factor",0.9999],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1]]';
    const file = readShapefile('plane', { shp: multipatchShp([boxBuilding(0, 0, 10, 10, 0, 20)]), prj });
    const shape = multiPatchOf(file.features[0] as Feature)!;
    expect(shape.patches[0].xyz[0]).toBeCloseTo(139.833333, 5);
    expect(shape.patches[0].xyz[1]).toBeCloseTo(36, 5);
    expect(file.crs).toBe('JGD2011 / Japan Plane Rectangular CS IX');
  });
});
