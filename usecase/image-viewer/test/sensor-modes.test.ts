import { describe, expect, it } from 'vitest';
import { coverPlan, planAccess, platformKey, sampleSatellites, satelliteCatalogOf, satelliteLabel, satelliteOf, satellitesFromText, subSatellitePoint, type PlanOptions, type PlanTarget, type SatelliteSpec } from '../src/imaging-plan.js';
import { sampleSensorModes, sensorCatalogOf, sensorModeOf, withModes, type SensorMode } from '../src/sensor-modes.js';
import { timelineRows } from '../src/imaging-plan-timeline.js';
import { parseConfig } from '../src/config.js';

// An ISS-like orbit (51.6°, about 420 km) with its epoch on 2026-10-07 12:00 UTC.
const line1 = '1 25544U 98067A   26280.50000000  .00016717  00000-0  10270-3 0  9994';
const line2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49815399432717';
const epoch = Date.UTC(2026, 0, 1) + 279.5 * 86400000;
const iss = (spec: Partial<SatelliteSpec> = {}): SatelliteSpec => ({ ...satellitesFromText(`ISS\n${line1}\n${line2}`, { maxOffNadir: 45, minOffNadir: 0, swath: 10 })[0], ...spec });

const sarModes: SensorMode[] = [
  { sensor: 'ISS', mode: 'ストリップマップ', minOffNadir: 15, maxOffNadir: 30, swath: 30, length: 50, resolution: 3 },
  { sensor: 'ISS', mode: 'スポットライト', minOffNadir: 10, maxOffNadir: 40, swath: 5, resolution: 0.5, primary: true },
  { sensor: 'ISS', mode: 'スキャンSAR', minOffNadir: 20, maxOffNadir: 45, swath: 100, length: 100, scenesPerPass: 3, resolution: 15 },
];

describe('sensor catalogs', () => {
  it('reads modes written in config.json, with what a sensor says for all its modes', () => {
    const problems: string[] = [];
    const catalog = sensorCatalogOf(
      {
        label: 'センサー',
        swathUnit: 'm',
        sensors: [
          { sensor: 'ICEYE', kind: 'SAR', lookSide: 'right', minInterval: 5, modes: [{ mode: 'Strip', swath: 30000, length: 50000, maxOffNadir: 30 }, { name: 'Spot', swath: 5000, lookSide: 'both', default: true, primary: 'はい' }] },
          { sensor: 'WorldView', kind: 'optical', maxOffNadir: 30 },
          { modes: [] },
        ],
      },
      problems,
      0,
    )!;
    expect(problems).toEqual(['sensorCatalogs[0].sensors[2] に sensor（センサー名）がありません']);
    expect(catalog.modes).toEqual([
      { sensor: 'ICEYE', mode: 'Strip', sar: true, swath: 30, length: 50, maxOffNadir: 30, minInterval: 5, lookSide: 'right' },
      { sensor: 'ICEYE', mode: 'Spot', sar: true, swath: 5, minInterval: 5, lookSide: 'both', primary: true },
      { sensor: 'WorldView', mode: '', sar: false, maxOffNadir: 30 },
    ]);
  });

  it('maps a table of modes by role, and says what is wrong', () => {
    const problems: string[] = [];
    const table = sensorCatalogOf({ url: 'https://example.com/arcgis/rest/services/Sensors/FeatureServer/1', fields: { sensor: 'SENSOR', mode: 'MODE', swath: 'SWATH_KM', resolution: 'RES_M', kind: 'TYPE', primary: 'IS_DEFAULT' } }, problems, 1)!;
    expect(problems).toEqual([]);
    expect(table.url).toBe('https://example.com/arcgis/rest/services/Sensors/FeatureServer/1');
    expect(sensorModeOf({ SENSOR: 'ICEYE', MODE: 'Spot', SWATH_KM: 5, RES_M: '0.5', TYPE: 'SAR', IS_DEFAULT: 1 }, table)).toEqual({ sensor: 'ICEYE', mode: 'Spot', sar: true, swath: 5, resolution: 0.5, primary: true });
    expect(sensorModeOf({ MODE: 'Spot' }, table)).toBeNull();
    expect(sensorCatalogOf({ url: 'https://example.com/x' }, problems, 2)).toBeNull();
    expect(sensorCatalogOf({ url: 'https://example.com/arcgis/rest/services/S/FeatureServer/1', fields: { mode: 'MODE' } }, problems, 3)).toBeNull();
    expect(problems).toEqual(['sensorCatalogs[2] は sensors（モードの一覧）か、…/FeatureServer/1 のようなテーブルの url を書いてください', 'sensorCatalogs[3] に fields.sensor（センサー名の属性）がありません']);
    // In config.json, next to the satellite catalogs, which keep their old form.
    const config = parseConfig({
      satelliteCatalogs: [{ url: 'https://example.com/arcgis/rest/services/Sat/FeatureServer/0', fields: { tle: 'TLE', sensor: 'SENSOR' } }],
      sensorCatalogs: [{ sensors: [{ sensor: 'ICEYE', modes: [{ mode: 'Spot' }] }] }],
    }).config;
    expect(config.satelliteCatalogs[0].fields.sensor).toBe('SENSOR');
    expect(config.sensorCatalogs[0].modes).toEqual([{ sensor: 'ICEYE', mode: 'Spot' }]);
  });
});

describe('satellites by mode', () => {
  it('lists a satellite once per mode of its sensor, the mode’s values in place of its own', () => {
    const sats = withModes([iss({ minInterval: 7 }), iss({ name: 'Other', id: '99999', series: 'Other' })], sarModes);
    expect(sats.map((s) => [s.name, s.mode, s.primary])).toEqual([
      ['ISS', 'ストリップマップ', false],
      ['ISS', 'スポットライト', true],
      ['ISS', 'スキャンSAR', false],
      ['Other', undefined, undefined],
    ]);
    const [strip, spot, scan] = sats;
    expect([strip.minOffNadir, strip.maxOffNadir, strip.swath, strip.length, strip.resolution]).toEqual([15, 30, 30, 50, 3]);
    // A length left out is the mode's width; what the mode leaves out is the satellite's.
    expect([spot.swath, spot.length, spot.minInterval, spot.lookSide]).toEqual([5, 5, 7, 'both']);
    expect(scan.scenesPerPass).toBe(3);
    expect(new Set(sats.slice(0, 3).map(platformKey)).size).toBe(1);
    expect(satelliteLabel(spot)).toBe('ISS（スポットライト）');
    expect(satelliteLabel(sats[3])).toBe('Other');
    // The first mode is the usual one when none is marked.
    expect(withModes([iss()], sarModes.map((m) => ({ ...m, primary: undefined }))).map((s) => s.primary)).toEqual([true, false, false]);
  });

  it('finds the sensor by the satellite’s sensor, series or name', () => {
    expect(withModes([iss({ name: 'X1', series: 'ISS' })], sarModes)).toHaveLength(3);
    expect(withModes([iss({ name: 'X1', series: 'X', sensor: 'iss ' })], sarModes)).toHaveLength(3);
    expect(withModes([iss({ name: 'X1', series: 'X' })], sarModes)).toHaveLength(1);
  });

  it('reads catalogs of one record per satellite and mode', () => {
    const catalog = satelliteCatalogOf({ url: 'https://example.com/arcgis/rest/services/Sat/FeatureServer/0', fields: { name: 'NAME', id: 'ID', tle: 'TLE', mode: 'MODE', swath: 'SWATH', sensor: 'SENSOR', resolution: 'RES' } }, [], 0)!;
    const rows = [
      { NAME: 'ISS', ID: 'A', TLE: `${line1}\n${line2}`, MODE: 'Wide', SWATH: 100, SENSOR: 'S', RES: 10 },
      { NAME: 'ISS', ID: 'A', TLE: `${line1}\n${line2}`, MODE: 'Fine', SWATH: 10, SENSOR: 'S', RES: '1' },
    ].map((r) => satelliteOf(r, catalog) as SatelliteSpec);
    expect(rows.map((s) => [s.mode, s.swath, s.sensor, s.resolution])).toEqual([
      ['Wide', 100, 'S', 10],
      ['Fine', 10, 'S', 1],
    ]);
    // No sensor catalog: they stay as they are, the first the usual one; a sensor catalog's mode of the same name fills in.
    expect(withModes(rows, []).map((s) => [s.mode, s.primary])).toEqual([
      ['Wide', true],
      ['Fine', false],
    ]);
    expect(withModes(rows, [{ sensor: 'S', mode: 'fine', maxOffNadir: 12 }]).map((s) => s.maxOffNadir)).toEqual([30, 12]);
  });

  it('gives the sample SAR satellite three modes', () => {
    const sats = withModes(sampleSatellites(), sampleSensorModes());
    expect(sats.map((s) => satelliteLabel(s))).toEqual(['サンプル光学衛星', 'サンプルSAR衛星（ストリップマップ）', 'サンプルSAR衛星（スポットライト）', 'サンプルSAR衛星（スキャンSAR）']);
    expect(sats.map((s) => s.primary)).toEqual([undefined, true, false, false]);
  });
});

describe('planning by mode', () => {
  const T = epoch + 3600000;
  const below = subSatellitePoint(iss(), T)!;
  const options: PlanOptions = { start: T - 30 * 60000, end: T + 30 * 60000, maxOffNadir: null, daylight: 'none', minSunElevation: 10 };

  it('finds the same passes for a mode as for the satellite planned alone', () => {
    // A place 420 km east: about 36° off nadir, within the spotlight and ScanSAR modes, not stripmap.
    const target: PlanTarget = { label: 'side', center: [below[0] + 420 / (111.32 * Math.cos((below[1] * Math.PI) / 180)), below[1]], points: [] };
    const sats = withModes([iss()], sarModes);
    const together = planAccess(sats, [target], options).opportunities;
    const alone = sats.map((sat) => planAccess([sat], [target], options).opportunities);
    expect(together.map((o) => sats[o.satellite].mode)).toEqual(sats.filter((_, s) => alone[s].length).map((s) => s.mode));
    for (const op of together) expect(op.time).toBe(alone[op.satellite][0].time);
    expect(together.map((o) => sats[o.satellite].mode)).toEqual(['スポットライト', 'スキャンSAR']);
    expect(together[0].offNadir).toBeGreaterThan(30);
  });

  it('takes a pass in one mode, sharing the satellite’s interval across its modes', () => {
    const a: PlanTarget = { label: 'a', center: below, points: [] };
    const b: PlanTarget = { label: 'b', center: subSatellitePoint(iss(), T + 50000)!, points: [] };
    const sats = withModes([iss({ minInterval: 10 })], sarModes.map((m) => ({ ...m, minOffNadir: 0 })));
    const { opportunities } = planAccess(sats, [a, b], { ...options, end: T + 2 * 86400000 });
    // Every mode sees both places on the first pass.
    expect(opportunities.filter((o) => o.time < T + 120000)).toHaveLength(6);
    const plans = coverPlan(opportunities, [a, b], sats);
    // a in the sharpest mode; b not a minute later in another mode, but after the satellite's 10 minutes.
    expect(sats[plans[0].steps[0].satellite].mode).toBe('スポットライト');
    expect(plans[1].done! - plans[0].done!).toBeGreaterThanOrEqual(10 * 60000);
    expect(plans[1].blocked).toBeGreaterThan(0);
    // The timeline has one row for the satellite.
    expect(timelineRows([...plans[0].steps, ...plans[1].steps], sats)).toHaveLength(1);
  });

  it('covers an area with the mode that takes most of it', () => {
    // A strip 60 km wide straight below: ScanSAR (100 km) takes it all at once, spotlight (5 km) a sliver.
    const dLon = 30 / (111.32 * Math.cos((below[1] * Math.PI) / 180));
    const cells: Array<[number, number]> = [];
    for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) cells.push([below[0] - dLon + (2 * dLon * (i + 0.5)) / 12, below[1] - 0.25 + (0.5 * (j + 0.5)) / 12]);
    const area: PlanTarget = { label: 'area', center: below, points: cells.filter((_, k) => k % 11 === 0), cells };
    const sats = withModes([iss()], sarModes.map((m) => ({ ...m, minOffNadir: 0 })));
    const { opportunities } = planAccess(sats, [area], options);
    const [plan] = coverPlan(opportunities, [area], sats, 0.9);
    expect(plan.steps).toHaveLength(1);
    expect(sats[plan.steps[0].satellite].mode).toBe('スキャンSAR');
  });
});
