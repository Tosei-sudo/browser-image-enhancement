import { describe, expect, it } from 'vitest';
import { polygonize, ringArea } from '../src/mask-polygons.js';

/** A mask from rows of '#' (set) and '.' (unset). */
const maskOf = (rows: string[]) => ({ mask: Uint8Array.from(rows.join('').split(''), (c) => (c === '#' ? 1 : 0)), width: rows[0].length, height: rows.length });

describe('polygons of a mask', () => {
  it('outlines a block clockwise, corners only', () => {
    const { mask, width, height } = maskOf(['....', '.##.', '.##.', '....']);
    const [p, ...rest] = polygonize(mask, width, height);
    expect(rest).toEqual([]);
    expect(p.pixels).toBe(4);
    expect(p.rings).toHaveLength(1);
    expect(p.rings[0]).toHaveLength(4);
    expect(ringArea(p.rings[0])).toBe(4);
    expect(new Set(p.rings[0].map(String))).toEqual(new Set(['1,1', '3,1', '3,3', '1,3']));
  });

  it('keeps a hole, and regions touching at a corner apart', () => {
    const { mask, width, height } = maskOf(['###..', '#.#..', '###..', '...##', '...##']);
    const polygons = polygonize(mask, width, height);
    expect(polygons.map((p) => p.pixels)).toEqual([8, 4]);
    expect(polygons[0].rings).toHaveLength(2);
    expect(ringArea(polygons[0].rings[1])).toBe(-1);
    expect(polygons[1].rings).toHaveLength(1);
  });

  it('reaches the border, and L shapes', () => {
    const { mask, width, height } = maskOf(['#..', '#..', '###']);
    const [p] = polygonize(mask, width, height);
    expect(p.pixels).toBe(5);
    expect(p.rings[0]).toHaveLength(6);
  });

  it('drops small regions, fills small holes and keeps the largest', () => {
    const { mask, width, height } = maskOf(['#....#', '......', '.###..', '.#.#..', '.###..']);
    expect(polygonize(mask, width, height, { minPixels: 2 }).map((p) => [p.pixels, p.rings.length])).toEqual([[8, 1]]);
    expect(polygonize(mask, width, height, { maxPolygons: 2 })).toHaveLength(2);
    expect(polygonize(new Uint8Array(4), 2, 2)).toEqual([]);
  });

  it('handles a checkerboard', () => {
    const { mask, width, height } = maskOf(['#.#', '.#.', '#.#']);
    const polygons = polygonize(mask, width, height);
    expect(polygons).toHaveLength(5);
    expect(polygons.every((p) => p.pixels === 1 && p.rings[0].length === 4)).toBe(true);
  });
});
