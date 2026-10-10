import { describe, expect, it } from 'vitest';
import Feature from 'ol/Feature.js';
import Polygon from 'ol/geom/Polygon.js';
import { blockOf, extentHeights, raiseFootprints } from '../src/services/esri-multipatch.js';
import { footprintOf, heightRange, multiPatchOf, trianglesOf } from '../src/multipatch.js';

describe('Esri multipatch layers', () => {
  it('read the lowest and highest height of an extent', () => {
    expect(extentHeights({ hasZ: true, rings: [[[0, 0, 5], [0, 1, 5], [1, 1, 42], [1, 0, 5], [0, 0, 5]]] })).toEqual([5, 42]);
    expect(extentHeights({ rings: [[[0, 0], [1, 1]]] })).toBeNull();
    expect(extentHeights(null)).toBeNull();
  });

  it('raise a footprint with a courtyard into a block', () => {
    const outer = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    const hole = [
      [4, 4],
      [4, 6],
      [6, 6],
      [6, 4],
      [4, 4],
    ];
    const block = blockOf([[outer, hole]], 2, 30);
    expect(heightRange(block)).toEqual([2, 30]);
    // Seen from above: the ring with its hole, once (roof and floor are the same outline).
    const footprint = footprintOf(block);
    expect(footprint).toHaveLength(1);
    expect(footprint[0]).toHaveLength(2);
    // Walls: 4 + 4 sides of 2 triangles; roof and floor: (100 − 4) each, in 8 triangles.
    const t = trianglesOf(block);
    expect(t.length / 9).toBe(16 + 16);
  });

  it('give features their blocks by object id', () => {
    const a = new Feature(new Polygon([[[0, 0], [1, 0], [1, 1], [0, 0]]]));
    a.setId(7);
    const b = new Feature(new Polygon([[[0, 0], [1, 0], [1, 1], [0, 0]]]));
    b.setId(8);
    expect(raiseFootprints([a, b], new Map([[7, [0, 12] as [number, number]]]), (p) => p)).toBe(1);
    expect(heightRange(multiPatchOf(a)!)).toEqual([0, 12]);
    expect(multiPatchOf(b)).toBeUndefined();
  });
});
