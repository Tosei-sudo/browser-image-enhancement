import { describe, expect, it } from 'vitest';
import { planAccess, satellitesFromText, subSatellitePoint, type PlanOptions, type SatelliteSpec } from '../src/imaging-plan.js';
import { circleTarget, destination, refineShots, sampleTargets, shipAt, shipOf, shipPlan, shipWindow, uncertaintyAt, type ShipState } from '../src/imaging-plan-moving.js';
import { distanceMetres, type Track } from '../src/moving.js';

const line1 = '1 25544U 98067A   26280.50000000  .00016717  00000-0  10270-3 0  9994';
const line2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49815399432717';
const epoch = Date.UTC(2026, 0, 1) + 279.5 * 86400000;
const iss = (spec: Partial<SatelliteSpec> = {}): SatelliteSpec => ({ ...satellitesFromText(`ISS\n${line1}\n${line2}`, { maxOffNadir: 45, minOffNadir: 0, swath: 10 })[0], ...spec });
const T = epoch + 3600000;
const below = subSatellitePoint(iss(), T)!;
const h = 3600000;

describe('dead reckoning a ship', () => {
  it('reads the last report of a track', () => {
    const track: Track = { id: '431', name: 'MARU', kind: 'ship', attrs: {}, heading: null, course: 90, fixes: [{ t: 0, lon: 1, lat: 2, dir: 80, speed: 3 }, { t: 5, lon: 1.1, lat: 2, dir: 85, speed: 12 }] };
    expect(shipOf(track)).toEqual({ id: '431', name: 'MARU', t: 5, lon: 1.1, lat: 2, course: 90, speed: 12 });
    expect(shipOf({ ...track, fixes: [] })).toBeNull();
  });

  it('carries the ship on along its course at its speed', () => {
    const ship: ShipState = { id: 'a', name: 'a', t: 0, lon: 139, lat: 35, course: 0, speed: 10 };
    // 10 knots for 3 hours: 55.56 km north.
    const at = shipAt(ship, 3 * h);
    expect(at[0]).toBeCloseTo(139, 6);
    expect(distanceMetres([139, 35], at) / 1000).toBeCloseTo(55.56, 0);
    expect(shipAt({ ...ship, speed: null }, 3 * h)).toEqual([139, 35]);
    expect(destination([179.9, 0], 90, 50)[0]).toBeLessThan(-179);
  });

  it('grows the circle with the time since the report', () => {
    const ship: ShipState = { id: 'a', name: 'a', t: 0, lon: 139, lat: 35, course: 0, speed: 10 };
    expect(uncertaintyAt(ship, 0)).toBe(0.5);
    expect(uncertaintyAt(ship, 10 * h)).toBeCloseTo(0.5 + 10 * (1.852 + 0.5));
    const circle = circleTarget(ship, 2 * h);
    expect(circle.points).toHaveLength(24);
    expect(circle.cells!.length).toBeGreaterThan(50);
    expect(circle.uncertainty).toBeCloseTo(uncertaintyAt(ship, 2 * h));
    expect(circle.guessed).toBe(2 * h);
    for (const p of circle.points) expect(distanceMetres(circle.center, p) / 1000).toBeCloseTo(circle.uncertainty!, 1);
  });

  it('samples each ship every hour up to the horizon', () => {
    const ships: ShipState[] = [
      { id: 'a', name: 'a', t: 0, lon: 139, lat: 35, course: 0, speed: 10 },
      { id: 'b', name: 'b', t: -70 * h, lon: 135, lat: 34, course: 90, speed: 5 },
    ];
    const span = shipWindow(ships, { start: 0, end: 10 * 24 * h });
    expect(span).toEqual({ start: 0, end: 72 * h });
    const { targets, samples } = sampleTargets(ships, span.start, span.end);
    // a: 0…72 h (73 places); b: 0…2 h, its horizon.
    expect(samples.filter((s) => s.ship === 0)).toHaveLength(73);
    expect(samples.filter((s) => s.ship === 1).map((s) => s.t)).toEqual([0, h, 2 * h]);
    expect(targets[1].center[1]).toBeGreaterThan(35);
  });
});

describe('planning a ship', () => {
  it('aims the pass at where the ship will be at its moment', () => {
    // A ship that sails north at 12 knots and will be 150 km east of the track at T.
    const meet = [below[0] + 150 / (111.32 * Math.cos((below[1] * Math.PI) / 180)), below[1]] as [number, number];
    const ship: ShipState = { id: 's', name: 'SHIP', t: T - 5 * h, lon: 0, lat: 0, course: 0, speed: 12 };
    [ship.lon, ship.lat] = destination(meet, 180, 12 * 1.852 * 5);
    const options: PlanOptions = { start: T - 3 * h, end: T + 3 * h, maxOffNadir: null, daylight: 'none', minSunElevation: 10 };
    const { targets, samples } = sampleTargets([ship], options.start, options.end);
    const first = planAccess([iss()], targets, options);
    const shots = refineShots(first, samples, [ship], [iss()], options);
    const shot = shots.find((s) => Math.abs(s.op.time - T) < 10 * 60000)!;
    expect(shot).toBeDefined();
    expect(distanceMetres(shot.target.center, meet)).toBeLessThan(5000);
    expect(shot.target.uncertainty).toBeCloseTo(uncertaintyAt(ship, shot.op.time), 3);
    expect(shot.op.coverage).toBeGreaterThan(0);
    // One shot per pass, however many hourly places saw it.
    expect(shots.filter((s) => Math.abs(s.op.time - T) < 10 * 60000)).toHaveLength(1);
    const plan = shipPlan(shots, first);
    expect(plan.targets).toHaveLength(shots.length);
    expect(plan.opportunities.map((o) => o.target)).toEqual(shots.map((_, i) => i));
  });
});
