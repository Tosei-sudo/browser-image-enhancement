import { describe, expect, it } from 'vitest';
import { gridAround, HIDDEN, lineOfSight, metresPerDegree, OUTSIDE, raiseByTriangles, sightLineHeight, VISIBLE, viewshed, visibleArea, type ViewshedOptions } from '../src/viewshed.js';
import type { Dted } from '../src/dted.js';

/** A 1° DTED cell from (139°E, 35°N) at 1″ posts, heights `f(lon, lat)`. */
function cell(f: (lon: number, lat: number) => number, step = 3): Dted {
  const spacing = step / 3600;
  const n = Math.round(1 / spacing) + 1;
  const data = new Int16Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) data[r * n + c] = Math.round(f(139 + c * spacing, 36 - r * spacing));
  return { level: 'DTED1', west: 139, south: 35, spacing: [spacing, spacing], width: n, height: n, data, verticalAccuracy: null };
}

const at = { lon: 139.5, lat: 35.5 };
const m = metresPerDegree(at.lat);

/** Distance in metres from the observer to the centre of a grid cell. */
function distance(grid: ReturnType<typeof gridAround>, row: number, col: number): number {
  return Math.hypot((grid.west + col * grid.dLon - at.lon) * m.x, (grid.north - row * grid.dLat - at.lat) * m.y);
}

describe('metresPerDegree', () => {
  it('gives the WGS 84 radii of curvature', () => {
    // At 35.5°: a degree of latitude is about 110.95 km, of longitude 90.73 km.
    const { x, y, radius } = metresPerDegree(35.5);
    expect(y).toBeCloseTo(110_950, -2);
    expect(x).toBeCloseTo(90_729.4, 0);
    expect(radius).toBeGreaterThan(6_360_000);
    expect(radius).toBeLessThan(6_380_000);
  });
});

describe('viewshed', () => {
  it('sees flat ground up to the horizon the Earth curves away to', () => {
    const flat = cell(() => 0);
    const options: ViewshedOptions = { ...at, observerHeight: 10, targetHeight: 0, radius: 20_000, refraction: 0 };
    const grid = gridAround([flat], options);
    const result = viewshed(grid, options);
    // Horizon of an eye 10 m up: √(2Rh) ≈ 11.3 km. Ground nearer is seen, farther is behind the curve.
    const horizon = Math.sqrt(2 * m.radius * 10);
    let checked = 0;
    for (let r = 0; r < grid.height; r += 7) {
      for (let c = 0; c < grid.width; c += 7) {
        const d = distance(grid, r, c);
        const v = result[r * grid.width + c];
        if (d > options.radius) expect(v).toBe(OUTSIDE);
        else if (d < horizon * 0.9) expect(v).toBe(VISIBLE);
        else if (d > horizon * 1.1) expect(v).toBe(HIDDEN);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('refraction carries the view farther', () => {
    const flat = cell(() => 0);
    const base: ViewshedOptions = { ...at, observerHeight: 10, targetHeight: 0, radius: 20_000, refraction: 0 };
    const grid = gridAround([flat], base);
    const seen = (refraction: number) => visibleArea(grid, viewshed(grid, { ...base, refraction }));
    // The area grows as 1 / (1 − k).
    expect(seen(0.13) / seen(0)).toBeCloseTo(1 / 0.87, 1);
  });

  it('a ridge hides the ground behind it but not what stands tall enough', () => {
    // A 50 m wall running north–south 1 km east of the observer.
    const ridgeLon = at.lon + 1000 / m.x;
    const wall = cell((lon) => (Math.abs(lon - ridgeLon) < 30 / m.x ? 50 : 0));
    const options: ViewshedOptions = { ...at, observerHeight: 2, targetHeight: 0, radius: 3000, refraction: 0.13 };
    const grid = gridAround([wall], options);
    const result = viewshed(grid, options);
    const row = Math.round((grid.north - at.lat) / grid.dLat);
    const col = (metres: number) => Math.round((at.lon + metres / m.x - grid.west) / grid.dLon);
    expect(result[row * grid.width + col(-2000)]).toBe(VISIBLE); // west, open ground
    expect(result[row * grid.width + col(500)]).toBe(VISIBLE); // before the wall
    expect(result[row * grid.width + col(1000)]).toBe(VISIBLE); // the wall itself
    expect(result[row * grid.width + col(2000)]).toBe(HIDDEN); // behind it
    // A 100 m mast 2 km out shows above the 50 m wall 1 km out (the line of sight there passes about 51 m up).
    const tall = viewshed(grid, { ...options, targetHeight: 100 }, row, row + 1);
    expect(tall[col(2000)]).toBe(VISIBLE);
  });

  it('cannot run without elevation data at the observer', () => {
    expect(() => gridAround([cell(() => 0)], { lon: 141, lat: 35.5, radius: 1000 })).toThrow('観測点に標高データがありません');
  });
});

describe('the line of sight of a profile', () => {
  const flat = (n: number, length: number, h: (d: number) => number) => Array.from({ length: n + 1 }, (_, i) => ({ distance: (length * i) / n, height: h((length * i) / n) }));

  it('clears flat ground between two points on it, nearby', () => {
    expect(lineOfSight(flat(100, 1000, () => 0), 0, 0)).toBeNull();
  });

  it('is blocked by a ridge, and says where', () => {
    const ridge = flat(100, 1000, (d) => (Math.abs(d - 400) < 15 ? 30 : 0));
    expect(lineOfSight(ridge, 1.6, 1.6)).toBeCloseTo(390, -1);
    // Seen over it from high enough.
    expect(lineOfSight(ridge, 100, 0)).toBeNull();
  });

  it('is blocked by the Earth over a long flat distance, less with refraction', () => {
    // Two eyes 10 m up over 30 km of sea: the bulge in the middle is about 15 m (no refraction).
    const sea = flat(300, 30_000, () => 0);
    expect(lineOfSight(sea, 10, 10, 0)).not.toBeNull();
    expect(lineOfSight(sea, 20, 20, 0)).toBeNull();
    // Drawn in true heights the line sags under the middle by L² / 8R (the bulge of the Earth it passes over).
    expect(sightLineHeight(15_000, 30_000, 10, 10, 0) - 10).toBeCloseTo(-(30_000 ** 2) / (8 * 6371000), 3);
  });
});

describe('buildings in the grid', () => {
  it('raise the cells under their roofs, not those beside', () => {
    const grid = { west: 0, north: 1, dLon: 0.1, dLat: 0.1, width: 11, height: 11, heights: new Float32Array(121).fill(5) };
    // A roof at 20 m over the square 0.3–0.6 × 0.3–0.6 (two triangles), and a wall (no area from above).
    const roof = [0.3, 0.3, 20, 0.6, 0.3, 20, 0.6, 0.6, 20, 0.3, 0.3, 20, 0.6, 0.6, 20, 0.3, 0.6, 20, 0.3, 0.3, 0, 0.6, 0.3, 0, 0.6, 0.3, 20];
    const raised = raiseByTriangles(grid, roof);
    // Cells at 0.3, 0.4, 0.5 and 0.6 in each direction.
    expect(raised).toBe(16);
    const at = (lon: number, lat: number) => grid.heights[Math.round((1 - lat) / 0.1) * 11 + Math.round(lon / 0.1)];
    expect(at(0.4, 0.5)).toBe(20);
    expect(at(0.2, 0.5)).toBe(5);
    expect(at(0.7, 0.4)).toBe(5);
    // Lower shapes leave higher ground alone.
    expect(raiseByTriangles(grid, roof.map((v, i) => (i % 3 === 2 ? 1 : v)))).toBe(0);
  });
});
