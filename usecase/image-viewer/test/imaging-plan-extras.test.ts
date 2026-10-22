import { describe, expect, it } from 'vitest';
import { planAccess, satellitesFromText, shiftScene, subSatellitePoint, trackPlace, type PlanOptions, type PlanTarget, type SatelliteSpec } from '../src/imaging-plan.js';
import { planIcs, shotsOf } from '../src/imaging-plan-remind.js';
import { timelineRows } from '../src/imaging-plan-timeline.js';

// The ISS-like orbit of imaging-plan.test.ts (epoch 2026-10-07 12:00 UTC).
const line1 = '1 25544U 98067A   26280.50000000  .00016717  00000-0  10270-3 0  9994';
const line2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49815399432717';
const epoch = Date.UTC(2026, 0, 1) + 279.5 * 86400000;
const iss = (spec: Partial<SatelliteSpec> = {}): SatelliteSpec => ({ ...satellitesFromText(`ISS\n${line1}\n${line2}`, { maxOffNadir: 45, minOffNadir: 0, swath: 10 })[0], ...spec });
const around = (t: number, minutes = 30): PlanOptions => ({ start: t - minutes * 60000, end: t + minutes * 60000, maxOffNadir: null, daylight: 'none', minSunElevation: 10 });
const east = ([lon, lat]: [number, number], km: number): [number, number] => [lon + km / (111.32 * Math.cos((lat * Math.PI) / 180)), lat];
const T = epoch + 3600000;
const below = subSatellitePoint(iss(), T)!;

describe('conditions on the shots', () => {
  const target = east(below, 150);
  const ops = (options: Partial<PlanOptions>, sat = iss()) =>
    planAccess([sat], [{ label: 'b', center: target, points: [] }], { ...around(T), ...options }).opportunities.filter((o) => Math.abs(o.time - T) < 600000);

  it('keeps shots within the incidence angles asked for', () => {
    const [op] = ops({});
    expect(op.incidence).toBeGreaterThan(10);
    expect(ops({ minIncidence: op.incidence - 1, maxIncidence: op.incidence + 1 })).toHaveLength(1);
    expect(ops({ minIncidence: op.incidence + 1 })).toHaveLength(0);
    expect(ops({ maxIncidence: op.incidence - 1 })).toHaveLength(0);
  });

  it('keeps passes going the way asked for, looking to the side asked for', () => {
    // A northbound pass with the point on its right.
    expect(ops({ pass: 'ascending' })).toHaveLength(1);
    expect(ops({ pass: 'descending' })).toHaveLength(0);
    expect(ops({ side: 'right' })).toHaveLength(1);
    expect(ops({ side: 'left' })).toHaveLength(0);
    // A satellite that only looks left has nothing left when right is asked for.
    expect(ops({ side: 'right' }, iss({ lookSide: 'left' }))).toHaveLength(0);
  });

  it('narrows the cells of an area to the incidences asked for', () => {
    // A strip 200 km wide east of the track: the far half needs larger angles.
    const cells: Array<[number, number]> = [];
    for (let i = 0; i < 40; i++) for (let j = 0; j < 5; j++) cells.push([east(below, 20 + i * 5)[0], below[1] - 0.1 + j * 0.05]);
    const area: PlanTarget = { label: 'strip', center: east(below, 120), points: [cells[0], cells[cells.length - 1]], cells };
    const at = (o: Partial<PlanOptions>) => planAccess([iss({ swath: 400, length: 400 })], [area], { ...around(T), ...o }).opportunities.find((x) => Math.abs(x.time - T) < 600000)!;
    const all = at({});
    const near = at({ maxIncidence: 15 });
    expect(near.coverage).toBeLessThan(all.coverage);
    expect(near.incidence).toBeLessThanOrEqual(15);
  });
});

describe('moving a scene by hand', () => {
  const target = east(below, 150);
  const sat = iss();
  const t: PlanTarget = { label: 'b', center: target, points: [] };
  const [op] = planAccess([sat], [t], around(T)).opportunities.filter((o) => Math.abs(o.time - T) < 600000);

  it('finds a place in the orbit frame', () => {
    const [x] = trackPlace(sat, op.time, target)!;
    // Right of the track: negative across.
    expect(x).toBeLessThan(0);
    expect((op.window[0] + op.window[1]) / 2).toBeCloseTo(x, 4);
  });

  it('moves the scene across the track with the angles following, and off the point', () => {
    const away = shiftScene(op, sat, t, -0.003, 0, {});
    expect(away.adjusted).toBe(true);
    expect(away.offNadir).toBeGreaterThan(op.offNadir);
    expect(away.coverage).toBe(0);
    const back = shiftScene(away, sat, t, 0.003, 0, {});
    // The point's own angle is on the ellipsoid; the scene's on a sphere: alike within a fraction of a degree.
    expect(back.offNadir).toBeCloseTo(op.offNadir, 0);
    expect(back.coverage).toBe(1);
  });

  it('stays within what the satellite can reach', () => {
    const far = shiftScene(op, sat, t, -1, 0, {});
    expect(far.offNadir).toBeCloseTo(45, 0);
    const capped = shiftScene(op, sat, t, -1, 0, { maxOffNadir: 20 });
    expect(capped.offNadir).toBeCloseTo(20, 0);
    // Only right: dragging to the left stops at the track.
    const left = shiftScene(op, sat, t, 1, 0, { side: 'right' });
    expect(left.side).toBe('right');
    expect(left.offNadir).toBeLessThan(0.5);
  });

  it('moves it along the track', () => {
    const later = shiftScene(op, sat, t, 0, 0.01, {});
    expect(later.along[0]).toBeCloseTo(op.along[0] + 0.01, 6);
    expect(later.coverage).toBe(0);
  });
});

describe('calendar and timeline', () => {
  const sats = [iss({ name: 'A, 1', id: 'A1', leadTime: 24 }), iss({ name: 'B', id: 'B' })];
  const targets: PlanTarget[] = [
    { label: '東京', center: [139.7, 35.7], points: [] },
    { label: '横浜', center: [139.6, 35.4], points: [] },
  ];
  const base = { offNadir: 10, incidence: 11, elevation: 79, side: 'left' as const, ascending: true, sunElevation: 30, range: 500, width: 0, strips: 1, length: 0, frames: 1, coverage: 1, window: [0, 0] as [number, number], along: [0, 0] as [number, number], tleAge: 1, orbitRadius: 6800, azimuth: 0, satEcef: [0, 0, 6800] as [number, number, number] };
  const ops = [
    { ...base, satellite: 0, target: 0, time: Date.UTC(2026, 9, 23, 1, 0), shot: 1, shotTargets: 2 },
    { ...base, satellite: 0, target: 1, time: Date.UTC(2026, 9, 23, 1, 0, 3), shot: 1, shotTargets: 2 },
    { ...base, satellite: 1, target: 1, time: Date.UTC(2026, 9, 24, 2, 0), shot: 2, shotTargets: 1 },
  ];

  it('takes a shared scene once', () => {
    const shots = shotsOf(ops, sats, targets);
    expect(shots).toHaveLength(2);
    expect(shots[0].targets).toEqual(['東京', '横浜']);
  });

  it('writes an iCalendar file with an event and alarm per shot', () => {
    const ics = planIcs(ops, sats, targets, 30, Date.UTC(2026, 9, 22));
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain('DTSTART:20261023T010000Z');
    expect(ics).toContain('TRIGGER:-PT30M');
    // Commas escaped; long lines folded at 75 octets.
    expect(ics).toContain('A\\, 1');
    for (const line of ics.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('puts each satellite with shots in a row', () => {
    const rows = timelineRows(ops, sats);
    expect(rows.map((r) => r.satellite)).toEqual([0, 1]);
    expect(rows[0].ops).toHaveLength(2);
  });
});
