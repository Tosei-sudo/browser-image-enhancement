import { describe, expect, it } from 'vitest';
import {
  groundRange,
  lookSideOf,
  passShapes,
  planAccess,
  sampleSatellites,
  satelliteCatalogOf,
  satelliteOf,
  satellitesFromText,
  subSatellitePoint,
  sunElevation,
  tleEpoch,
  tleLines,
  type PlanOptions,
  type SatelliteSpec,
} from '../src/imaging-plan.js';
import { parseConfig } from '../src/config.js';

// An ISS-like orbit (51.6°, about 420 km) with its epoch on 2026-10-07 12:00 UTC.
const line1 = '1 25544U 98067A   26280.50000000  .00016717  00000-0  10270-3 0  9994';
const line2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49815399432717';
const epoch = Date.UTC(2026, 0, 1) + 279.5 * 86400000;
const iss = (spec: Partial<SatelliteSpec> = {}): SatelliteSpec => ({ ...satellitesFromText(`ISS\n${line1}\n${line2}`, { maxOffNadir: 45, minOffNadir: 0, swath: 10 })[0], ...spec });
const around = (t: number, minutes = 30): PlanOptions => ({ start: t - minutes * 60000, end: t + minutes * 60000, maxOffNadir: null, daylight: 'none', minSunElevation: 10 });

/** A point `km` east of another, on the same parallel. */
const east = ([lon, lat]: [number, number], km: number): [number, number] => [lon + km / (111.32 * Math.cos((lat * Math.PI) / 180)), lat];

describe('TLE and catalog attributes', () => {
  it('reads TLE lines with or without a name line', () => {
    expect(tleLines(`ISS (ZARYA)\n${line1}\n${line2}`)).toEqual({ name: 'ISS (ZARYA)', tle1: line1, tle2: line2 });
    expect(tleLines(`${line1}\r\n${line2}`)).toEqual({ name: '', tle1: line1, tle2: line2 });
    expect(tleLines('nothing')).toBeNull();
    expect(tleEpoch(iss())).toBeCloseTo(epoch, -3);
  });

  it('maps catalog attributes by role, with defaults and units', () => {
    const problems: string[] = [];
    const catalog = satelliteCatalogOf(
      {
        label: '衛星',
        url: 'https://example.com/arcgis/rest/services/Sats/FeatureServer/0?x=1',
        fields: { name: 'SAT_NAME', tle1: 'L1', tle2: 'L2', maxOffNadir: 'MAX_ANGLE', swath: 'SWATH_M', lookSide: 'LOOK', kind: 'SENSOR' },
        swathUnit: 'm',
        defaults: { maxOffNadir: 25 },
      },
      problems,
      0,
    )!;
    expect(problems).toEqual([]);
    expect(catalog.url).toBe('https://example.com/arcgis/rest/services/Sats/FeatureServer/0');
    expect(catalog.defaults).toEqual({ maxOffNadir: 25, minOffNadir: 0, swath: 10 });
    const sat = satelliteOf({ SAT_NAME: 'SAR-1', L1: line1, L2: line2, MAX_ANGLE: 40, SWATH_M: 30000, LOOK: 'R', SENSOR: 'SAR' }, catalog) as SatelliteSpec;
    expect(sat).toMatchObject({ name: 'SAR-1', maxOffNadir: 40, swath: 30, length: 30, lookSide: 'right', sar: true });
    // Empty specifications fall back to the defaults (in km).
    const plain = satelliteOf({ SAT_NAME: 'OPT-1', L1: line1, L2: line2, MAX_ANGLE: null, SWATH_M: '' }, catalog) as SatelliteSpec;
    expect(plain).toMatchObject({ maxOffNadir: 25, swath: 10, lookSide: 'both', sar: false });
    expect(satelliteOf({ SAT_NAME: 'X' }, catalog)).toBe('X: TLE がありません');
  });

  it('reads one field holding both lines', () => {
    const catalog = satelliteCatalogOf({ url: 'https://e.com/a/FeatureServer/2', fields: { tle: 'TLE' } }, [], 0)!;
    expect(satelliteOf({ TLE: `0 ISS\n${line1}\n${line2}` }, catalog)).toMatchObject({ name: 'ISS', tle1: line1 });
  });

  it('refuses catalogs it cannot use', () => {
    const problems: string[] = [];
    expect(satelliteCatalogOf({ url: 'https://e.com/a/FeatureServer', fields: { tle: 'T' } }, problems, 0)).toBeNull();
    expect(satelliteCatalogOf({ url: 'https://e.com/a/FeatureServer/0', fields: { tle1: 'A' } }, problems, 1)).toBeNull();
    expect(problems).toHaveLength(2);
  });

  it('is read from config.json', () => {
    const { config, problems } = parseConfig({ satelliteCatalogs: [{ url: 'https://e.com/a/FeatureServer/0', fields: { tle: 'TLE', name: 'NAME' } }, 'bad'] });
    expect(config.satelliteCatalogs).toHaveLength(1);
    expect(problems).toEqual(['satelliteCatalogs[1] がオブジェクトではありません']);
  });

  it('reads the look side in English, letters and Japanese', () => {
    expect(['right', 'R', '右', 'left', 'l', '左', '', 'both', null].map(lookSideOf)).toEqual(['right', 'right', 'right', 'left', 'left', 'left', 'both', 'both', 'both']);
  });

  it('reads several pasted satellites', () => {
    const sats = satellitesFromText(`A\n${line1}\n${line2}\n${line1}\n${line2}`, { maxOffNadir: 20, minOffNadir: 0, swath: 5, sar: true });
    expect(sats.map((s) => [s.name, s.maxOffNadir, s.swath, s.sar])).toEqual([
      ['A', 20, 5, true],
      ['NORAD 25544', 20, 5, true],
    ]);
  });
});

describe('planning', () => {
  const T = epoch + 3600000;
  const below = subSatellitePoint(iss(), T)!;

  it('finds the pass straight over a point at the moment the satellite is overhead', () => {
    const { opportunities, problems } = planAccess([iss()], [{ label: 'a', center: below, points: [] }], around(T));
    expect(problems).toEqual([]);
    const op = opportunities.find((o) => Math.abs(o.time - T) < 60000)!;
    expect(Math.abs(op.time - T)).toBeLessThan(2000);
    expect(op.offNadir).toBeLessThan(0.5);
    expect(op.elevation).toBeGreaterThan(89);
    expect(op.range).toBeGreaterThan(380);
    expect(op.range).toBeLessThan(460);
  });

  it('tells the side and the angle of a point off the track', () => {
    const target = east(below, 150);
    const op = planAccess([iss()], [{ label: 'b', center: target, points: [] }], around(T)).opportunities.find((o) => Math.abs(o.time - T) < 600000)!;
    // The pass goes north-east here: a point to the east is on the right, and nearer than 150 km to the track.
    expect(op.ascending).toBe(true);
    expect(op.side).toBe('right');
    expect(op.offNadir).toBeGreaterThan(8);
    expect(op.offNadir).toBeLessThan(20);
    expect(op.incidence).toBeGreaterThan(op.offNadir);
  });

  it('leaves out passes beyond the angle, on the wrong side, or in the dark', () => {
    const target = east(below, 150);
    const ops = (sat: SatelliteSpec, options = around(T)) => planAccess([sat], [{ label: 'b', center: target, points: [] }], options).opportunities.filter((o) => Math.abs(o.time - T) < 600000);
    expect(ops(iss({ maxOffNadir: 5 }))).toHaveLength(0);
    expect(ops(iss(), { ...around(T), maxOffNadir: 5 })).toHaveLength(0);
    expect(ops(iss({ lookSide: 'left' }))).toHaveLength(0);
    expect(ops(iss({ lookSide: 'right' }))).toHaveLength(1);
    expect(ops(iss({ minOffNadir: 25 }))).toHaveLength(0);
    // The Sun is up there: daylight passes stay; a demand for a Sun higher than it is drops them, except for SAR.
    const sun = sunElevation(target, T);
    expect(sun).toBeGreaterThan(10);
    expect(ops(iss(), { ...around(T), daylight: 'optical', minSunElevation: sun + 5 })).toHaveLength(0);
    expect(ops(iss({ sar: true }), { ...around(T), daylight: 'optical', minSunElevation: sun + 5 })).toHaveLength(1);
  });

  it('finds the passes of a week in time order', () => {
    const { opportunities } = planAccess([iss()], [{ label: 'tokyo', center: [139.7, 35.7], points: [] }], { start: epoch, end: epoch + 7 * 86400000, maxOffNadir: null, daylight: 'none', minSunElevation: 10 });
    expect(opportunities.length).toBeGreaterThan(5);
    expect(opportunities.every((o, i) => i === 0 || o.time > opportunities[i - 1].time)).toBe(true);
    expect(opportunities.every((o) => o.offNadir <= 45)).toBe(true);
  });

  it('counts the scenes side by side that cover a wide area', () => {
    // A box 60 km wide across the track (roughly: the track is inclined), round the overhead point.
    const [lon, lat] = below;
    const box: Array<[number, number]> = [east([lon, lat - 0.05], -30), east([lon, lat - 0.05], 30), east([lon, lat + 0.05], 30), east([lon, lat + 0.05], -30)];
    const op = planAccess([iss({ swath: 12 })], [{ label: 'box', center: below, points: box }], around(T)).opportunities.find((o) => Math.abs(o.time - T) < 60000)!;
    expect(op.width).toBeGreaterThan(30);
    expect(op.width).toBeLessThan(65);
    expect(op.strips).toBe(Math.ceil(op.width / 12));
    const shapes = passShapes(iss({ swath: 12 }), { label: 'box', center: below, points: box }, op)!;
    expect(shapes.scenes).toHaveLength(op.strips);
    expect(shapes.reach).toHaveLength(2);
    expect(shapes.track.length).toBeGreaterThan(50);
    // The satellite is above the target at the moment.
    expect(Math.hypot(shapes.position[0] - lon, shapes.position[1] - lat)).toBeLessThan(0.1);
    // The scenes together cover the box's middle.
    const lons = shapes.scenes.flat().map((c) => c[0]);
    expect(Math.min(...lons)).toBeLessThan(lon);
    expect(Math.max(...lons)).toBeGreaterThan(lon);
  });

  it('reports satellites whose TLE does not read', () => {
    const bad = iss({ name: 'BAD', tle1: '1 garbage', tle2: '2 garbage' });
    expect(planAccess([bad], [{ label: 'a', center: below, points: [] }], around(T)).problems).toEqual(['BAD: TLE を読めません']);
  });

  it('knows how far a satellite reaches', () => {
    expect(groundRange(0, 6371 + 500)).toBeCloseTo(0);
    // 30° off nadir from 500 km: about 295 km away on the ground.
    expect(groundRange(30, 6371 + 500)).toBeGreaterThan(280);
    expect(groundRange(30, 6371 + 500)).toBeLessThan(310);
  });

  it('has two sample satellites that find passes over Tokyo', () => {
    const samples = sampleSatellites();
    expect(samples.map((s) => [s.name, s.sar, s.lookSide])).toEqual([
      ['サンプル光学衛星', false, 'both'],
      ['サンプルSAR衛星', true, 'right'],
    ]);
    const { opportunities, problems } = planAccess(samples, [{ label: 'tokyo', center: [139.7, 35.68], points: [] }], { start: epoch, end: epoch + 14 * 86400000, maxOffNadir: null, daylight: 'optical', minSunElevation: 10 });
    expect(problems).toEqual([]);
    const optical = opportunities.filter((o) => o.satellite === 0);
    const sar = opportunities.filter((o) => o.satellite === 1);
    expect(optical.length).toBeGreaterThan(0);
    expect(sar.length).toBeGreaterThan(0);
    // The optical one only by day, the SAR one only looking right within its angles.
    for (const o of optical) expect(o.sunElevation).toBeGreaterThanOrEqual(10);
    for (const o of sar) expect([o.side, o.offNadir >= 20, o.offNadir <= 45]).toEqual(['right', true, true]);
  });
});
