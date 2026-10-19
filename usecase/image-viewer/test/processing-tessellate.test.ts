import { describe, expect, it } from 'vitest';
import Polygon from 'ol/geom/Polygon.js';
import { fromLonLat } from 'ol/proj.js';
import { cellArea, columnLetters, sideForArea, sideForWidth, tessellate } from '../src/processing/tessellate.js';
import { registerJapaneseCrs, targetCrs } from '../src/processing/reproject.js';

/** A lon/lat box as a map (EPSG:3857) polygon. */
function box(w: number, s: number, e: number, n: number): Polygon {
  return new Polygon([[[w, s], [e, s], [e, n], [w, n], [w, s]].map((p) => fromLonLat(p))]);
}

const tokyo = box(139.7, 35.65, 139.75, 35.7);
const sum = (r: ReturnType<typeof tessellate>) => r.features.reduce((t, f) => t + (f.get('area_m2') as number), 0);

describe('tessellate', () => {
  it('lays 1 km squares on the ground, about 1 km² each', () => {
    const result = tessellate([tokyo], { shape: 'square', size: 1000, origin: 'center' });
    expect(result.features.length).toBeGreaterThan(20);
    for (const f of result.features) expect(f.get('area_m2')).toBeCloseTo(1e6, -3);
    expect(result.fields.map((f) => f.name)).toEqual(['id', 'row', 'col', 'label', 'area_m2']);
    expect(result.features[0].get('label')).toBe('A1');
    expect(result.features[0].get('id')).toBe(1);
  });

  it('cuts cells to the area so their areas add up to it', () => {
    const result = tessellate([tokyo], { shape: 'hexagon', size: 700, clip: 'clip' });
    const whole = tessellate([tokyo], { shape: 'square', size: 100_000, clip: 'clip' });
    expect(whole.features).toHaveLength(1);
    expect(sum(result) / sum(whole)).toBeCloseTo(1, 3);
  });

  it('keeps fewer cells inside than touching, centres in between', () => {
    const touching = tessellate([tokyo], { shape: 'triangle', size: 800 }).features.length;
    const inside = tessellate([tokyo], { shape: 'triangle', size: 800, clip: 'within' }).features.length;
    const centres = tessellate([tokyo], { shape: 'triangle', size: 800, clip: 'center' }).features.length;
    expect(inside).toBeLessThan(centres);
    expect(centres).toBeLessThan(touching);
  });

  it('tiles without gaps: hexagons and triangles of the same area cover the same area when cut', () => {
    const a = 250_000;
    const hex = tessellate([tokyo], { shape: 'hexagon', size: sideForArea('hexagon', a), clip: 'clip', orientation: 'pointy', rotation: 17 });
    const tri = tessellate([tokyo], { shape: 'triangle', size: sideForArea('triangle', a), clip: 'clip', rotation: -30 });
    expect(sum(hex) / sum(tri)).toBeCloseTo(1, 3);
    for (const f of hex.features.filter((f) => f.getGeometry()!.getType() === 'Polygon')) expect(f.get('area_m2')).toBeLessThanOrEqual(a * 1.001);
  });

  it('lines up with a CRS origin in its units', async () => {
    registerJapaneseCrs();
    const crs = await targetCrs('EPSG:6677');
    const result = tessellate([tokyo], { shape: 'square', size: 1000, crs, origin: 'crs' });
    expect(result.crs?.epsg).toBe(6677);
    const ring = (result.features[0].getGeometry() as Polygon).clone().transform('EPSG:3857', crs.projection).getCoordinates()[0];
    for (const [x, y] of ring) {
      expect(Math.abs(x / 1000 - Math.round(x / 1000))).toBeLessThan(1e-6);
      expect(Math.abs(y / 1000 - Math.round(y / 1000))).toBeLessThan(1e-6);
    }
  });

  it('refuses too many cells', () => {
    expect(() => tessellate([tokyo], { shape: 'square', size: 1, maxCells: 1000 })).toThrow(/多すぎます/);
  });

  it('notes the stretch of a wide geodesic grid', () => {
    const result = tessellate([box(125, 25, 150, 45)], { shape: 'hexagon', size: 100_000 });
    expect(result.notes!.join()).toMatch(/大きくなります/);
  });

  it('converts sizes', () => {
    expect(cellArea('hexagon', sideForArea('hexagon', 42))).toBeCloseTo(42);
    expect(sideForWidth('square', 5)).toBe(5);
    expect(columnLetters(0)).toBe('A');
    expect(columnLetters(25)).toBe('Z');
    expect(columnLetters(26)).toBe('AA');
  });
});
