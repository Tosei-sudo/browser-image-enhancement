import { describe, expect, it } from 'vitest';
import { ecefAt, planAccess, satellitesFromText, type Opportunity, type PlanTarget, type SatelliteSpec } from '../src/imaging-plan.js';
import { relate, repeatPairs, stereoPairs } from '../src/imaging-plan-pairs.js';
import { boxOf, cellTargets, gridCells, hoursText, revisitColor, revisitStats } from '../src/imaging-plan-revisit.js';

const line1 = '1 25544U 98067A   26280.50000000  .00016717  00000-0  10270-3 0  9994';
const line2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49815399432717';
const epoch = Date.UTC(2026, 0, 1) + 279.5 * 86400000;
const iss = (spec: Partial<SatelliteSpec> = {}): SatelliteSpec => ({ ...satellitesFromText(`ISS\n${line1}\n${line2}`, { maxOffNadir: 45, minOffNadir: 0, swath: 10 })[0], ...spec });
const target: PlanTarget = { label: 't', center: [0, 0], points: [] };

/** An opportunity of a satellite at `satEcef` over the target at (0, 0). */
const op = (time: number, satEcef: [number, number, number], extra: Partial<Opportunity> = {}): Opportunity =>
  ({ satellite: 0, target: 0, time, offNadir: 20, incidence: 22, elevation: 60, side: 'right', ascending: true, sunElevation: 30, range: 600, width: 0, strips: 1, length: 0, frames: 1, coverage: 1, window: [0, 0], along: [0, 0], tleAge: 0, azimuth: 90, satEcef, orbitRadius: 6900, ...extra }) as Opportunity;

describe('how two shots relate', () => {
  it('measures the convergence angle, B/H and baseline', () => {
    const [x] = ecefAt([0, 0]);
    // 500 km up, 500 km to either side: each look 45° from vertical, 90° apart.
    const pair = relate(op(0, [x + 500, 0, 500]), op(86400000, [x + 500, 0, -500]), target);
    expect(pair.convergence).toBeCloseTo(90, 1);
    expect(pair.bh).toBeCloseTo(2, 2);
    expect(pair.days).toBeCloseTo(1);
    // The baseline across the first line of sight: 1000 km × sin 45°, in metres.
    expect(pair.baseline).toBeCloseTo(1000 * Math.SQRT1_2 * 1000, -2);
  });

  it('puts the earlier shot first', () => {
    const [x] = ecefAt([0, 0]);
    const pair = relate(op(5, [x + 500, 0, 0]), op(1, [x + 500, 0, 100]), target);
    expect(pair.a.time).toBe(1);
  });
});

describe('stereo pairs', () => {
  const T = epoch + 3600000;
  const { opportunities } = planAccess([iss()], [{ label: 'tokyo', center: [139.7, 35.7], points: [] }], { start: T, end: T + 4 * 86400000, maxOffNadir: null, daylight: 'none', minSunElevation: 10 });

  it('pairs passes whose looks are far enough apart, within the days asked for', () => {
    expect(opportunities.length).toBeGreaterThan(3);
    const pairs = stereoPairs(opportunities, [iss()], [{ label: 'tokyo', center: [139.7, 35.7], points: [] }], { minAngle: 15, maxAngle: 60, maxDays: 2, sameSeries: true });
    expect(pairs.length).toBeGreaterThan(0);
    for (const p of pairs) {
      expect(p.convergence).toBeGreaterThanOrEqual(15);
      expect(p.convergence).toBeLessThanOrEqual(60);
      expect(p.days).toBeLessThanOrEqual(2);
      expect(p.b.time).toBeGreaterThan(p.a.time);
    }
    const none = stereoPairs(opportunities, [iss()], [{ label: 'tokyo', center: [139.7, 35.7], points: [] }], { minAngle: 89, maxAngle: 90, maxDays: 2, sameSeries: true });
    expect(none).toHaveLength(0);
  });

  it('does not pair an optical shot with a SAR one', () => {
    const [x] = ecefAt([0, 0]);
    const sats = [iss(), iss({ sar: true })];
    const ops = [op(0, [x + 500, 0, 300]), op(3600000, [x + 500, 0, -300], { satellite: 1 })];
    expect(stereoPairs(ops, sats, [target], { minAngle: 1, maxAngle: 90, maxDays: 7, sameSeries: false })).toHaveLength(0);
    expect(stereoPairs([ops[0], { ...ops[1], satellite: 0 }], sats, [target], { minAngle: 1, maxAngle: 90, maxDays: 7, sameSeries: false })).toHaveLength(1);
  });
});

describe('repeat pairs for interferometry', () => {
  const [x] = ecefAt([0, 0]);
  const sats = [iss({ sar: true }), iss({ sar: true, id: 'other', name: 'other' })];
  const day = 86400000;

  it('chains the returns of one satellite on the same track', () => {
    const ops = [
      op(0, [x + 500, 0, 300]),
      op(day, [x + 500, 0, -300], { incidence: 40 }), // another track: steeper look
      op(11 * day, [x + 500, 0.1, 300]),
      op(22 * day, [x + 500, 0.2, 300], { ascending: false }), // going the other way
      op(22 * day + 1000, [x + 500, 0.2, 300], { azimuth: 270 }), // looking from the other side
      op(33 * day, [x + 500, 0.3, 300]),
    ];
    const pairs = repeatPairs(ops, sats, [target]);
    expect(pairs.map((p) => [p.a.time / day, Math.round(p.b.time / day)])).toEqual([
      [0, 11],
      [11, 33],
    ]);
    // 100 m apart across the line of sight.
    expect(pairs[0].baseline).toBeGreaterThan(90);
    expect(pairs[0].baseline).toBeLessThan(110);
    expect(repeatPairs(ops, sats, [target], { maxIncidence: 1, maxAzimuth: 2, maxBaseline: 50, sameSeries: false })).toHaveLength(0);
  });

  it('keeps satellites apart unless the series is asked for', () => {
    const ops = [op(0, [x + 500, 0, 300]), op(day, [x + 500, 0, 300], { satellite: 1 })];
    expect(repeatPairs(ops, sats, [target])).toHaveLength(0);
    expect(repeatPairs(ops, sats, [target], { maxIncidence: 1, maxAzimuth: 2, maxBaseline: null, sameSeries: true })).toHaveLength(1);
    // Optical satellites give none.
    expect(repeatPairs(ops, [iss(), iss()], [target])).toHaveLength(0);
  });
});

describe('revisit map', () => {
  it('cuts the box around the targets into cells', () => {
    const box = boxOf([{ label: 'a', center: [139, 35], points: [] }]);
    expect(box).toEqual([138.75, 34.75, 139.25, 35.25]);
    const cells = gridCells(box, 4);
    expect(cells).toHaveLength(16);
    expect(cells[0].center[0]).toBeCloseTo(138.8125);
    expect(cells[0].center[1]).toBeCloseTo(35.1875);
    expect(cellTargets(cells)[15].label).toBe('セル 16');
  });

  it('counts the chances and the longest wait of each cell', () => {
    const h = 3600000;
    const ops = [op(10 * h, [0, 0, 0]), op(10 * h + 30000, [0, 0, 0], { satellite: 1 }), op(30 * h, [0, 0, 0]), op(40 * h, [0, 0, 0], { target: 2 })];
    const stats = revisitStats(ops, 3, 0, 48 * h);
    expect(stats[0]).toEqual({ count: 2, meanGap: 20, maxGap: 20 });
    expect(stats[1]).toEqual({ count: 0, meanGap: null, maxGap: 48 });
    expect(stats[2]).toEqual({ count: 1, meanGap: null, maxGap: 40 });
    expect(revisitColor(stats[0], 0, 48)).toEqual(expect.arrayContaining([expect.any(Number)]));
    expect(revisitColor(stats[1], 0, 48)).toEqual([148, 163, 184]);
    expect(revisitColor({ count: 1, meanGap: null, maxGap: 10 }, 10, 48)).toEqual([22, 163, 74]);
    expect(revisitColor({ count: 1, meanGap: null, maxGap: 48 }, 10, 48)).toEqual([220, 38, 38]);
    expect(hoursText(5.25)).toBe('5.3 時間');
    expect(hoursText(50)).toBe('2 日 2 時間');
    expect(hoursText(null)).toBe('—');
  });
});
