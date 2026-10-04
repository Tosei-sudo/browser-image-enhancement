import { describe, expect, it } from 'vitest';
import { formatArea, formatLength, geodesicArea, geodesicLength, geodesicPath } from '../src/geodesic.js';

describe('geodesicLength', () => {
  it('measures on the WGS 84 ellipsoid, not a sphere', () => {
    // A degree of latitude is 110.574 km at the equator and 111.694 km at the pole (a sphere: 111.195 km everywhere).
    expect(geodesicLength([[0, 0], [0, 1]])).toBeCloseTo(110_574.389, 2);
    expect(geodesicLength([[0, 89], [0, 90]])).toBeCloseTo(111_693.865, 2);
    // A degree of longitude on the equator: 111.319 km.
    expect(geodesicLength([[0, 0], [1, 0]])).toBeCloseTo(111_319.491, 2);
  });

  it('matches the GeographicLib documentation: Wellington to Salamanca', () => {
    expect(geodesicLength([[174.81, -41.32], [-5.5, 40.96]])).toBeCloseTo(19_959_679.267, 2);
  });

  it('adds the segments of a path', () => {
    const a = geodesicLength([[139.7671, 35.6812], [139.7, 35.69]]);
    const b = geodesicLength([[139.7, 35.69], [139.69, 35.7]]);
    expect(geodesicLength([[139.7671, 35.6812], [139.7, 35.69], [139.69, 35.7]])).toBeCloseTo(a + b, 6);
    expect(geodesicLength([[139.7, 35.69]])).toBe(0);
  });

  it('handles nearly antipodal points', () => {
    // Half the meridian: 20003.931 km.
    expect(geodesicLength([[0, 0], [180, 0.5]])).toBeGreaterThan(19_900_000);
    expect(geodesicLength([[0, 90], [0, -90]])).toBeCloseTo(20_003_931.459, 2);
  });
});

describe('geodesicArea', () => {
  it('a 1° square on the equator', () => {
    const { area, perimeter } = geodesicArea([[0, 0], [1, 0], [1, 1], [0, 1]]);
    expect(area).toBeCloseTo(12_308_778_361.469, 0);
    expect(perimeter).toBeCloseTo(443_770.9, 0);
  });

  it('is positive whichever way round', () => {
    const ring: [number, number][] = [[139, 35], [140, 35], [140, 36], [139, 36]];
    expect(geodesicArea(ring).area).toBeCloseTo(geodesicArea([...ring].reverse()).area, 3);
  });
});

describe('geodesicPath', () => {
  it('keeps the given points and adds points along long segments', () => {
    const path = geodesicPath([[-73.78, 40.64], [103.99, 1.36]]);
    expect(path[0]).toEqual([-73.78, 40.64]);
    expect(path.at(-1)).toEqual([103.99, 1.36]);
    expect(path.length).toBeGreaterThan(100);
    // The great-circle route from New York to Singapore passes near the pole.
    expect(Math.max(...path.map((p) => p[1]))).toBeGreaterThan(80);
  });

  it('crosses the antimeridian without jumping', () => {
    const path = geodesicPath([[179, 0], [-179, 0]].map(([lon, lat]) => [lon, lat] as [number, number]));
    for (let i = 1; i < path.length - 1; i++) expect(Math.abs(path[i][0] - path[i - 1][0])).toBeLessThan(1);
  });

  it('closes a ring', () => {
    const path = geodesicPath([[0, 0], [1, 0], [1, 1]], true);
    expect(path.at(-1)).toEqual([0, 0]);
  });
});

describe('format', () => {
  it('lengths', () => {
    expect(formatLength(12.345)).toBe('12.35 m');
    expect(formatLength(850.33)).toBe('850.3 m');
    expect(formatLength(12_345.6)).toBe('12.346 km');
    expect(formatLength(19_959_679.267)).toBe('19,959.7 km');
  });

  it('areas', () => {
    expect(formatArea(512.44)).toBe('512.4 m²');
    expect(formatArea(32_500)).toBe('3.25 ha');
    expect(formatArea(12_308_778_361)).toBe('12,308.8 km²');
  });
});
