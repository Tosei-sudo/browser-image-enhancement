import { describe, expect, it } from 'vitest';
import { addDownlinks, groundStationsOf, planAccess, satellitesFromText, satrecOf, subSatellitePoint, type Opportunity, type SatelliteSpec } from '../src/imaging-plan.js';
import { applyClouds, cloudAt, cloudForecastOf, defaultCloudForecast, fetchClouds, placesFor } from '../src/imaging-plan-weather.js';
import { parseConfig } from '../src/config.js';

const line1 = '1 25544U 98067A   26280.50000000  .00016717  00000-0  10270-3 0  9994';
const line2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49815399432717';
const epoch = Date.UTC(2026, 0, 1) + 279.5 * 86400000;
const iss = (spec: Partial<SatelliteSpec> = {}): SatelliteSpec => ({ ...satellitesFromText(`ISS\n${line1}\n${line2}`, { maxOffNadir: 45, minOffNadir: 0, swath: 10 })[0], ...spec });

describe('ground stations', () => {
  it('reads them from config.json, with a default lowest elevation', () => {
    const problems: string[] = [];
    expect(groundStationsOf([{ name: '勝浦', lon: 140.3, lat: 35.15 }, { lon: 200, lat: 0 }, { name: 'S', lon: 15.4, lat: 78.2, minElevation: 10 }], problems)).toEqual([
      { name: '勝浦', lon: 140.3, lat: 35.15, minElevation: 5 },
      { name: 'S', lon: 15.4, lat: 78.2, minElevation: 10 },
    ]);
    expect(problems).toHaveLength(1);
    const { config } = parseConfig({ groundStations: [{ name: 'A', lon: 1, lat: 2 }], cloudForecast: false });
    expect(config.groundStations).toHaveLength(1);
    expect(config.cloudForecast).toBeNull();
    expect(parseConfig({}).config.cloudForecast).toEqual(defaultCloudForecast);
  });

  it('tells each shot when the satellite next comes over a station', () => {
    const T = epoch + 3600000;
    const below = subSatellitePoint(iss(), T)!;
    const satrec = satrecOf(iss());
    if (typeof satrec === 'string') throw new Error(satrec);
    const op = (time: number) => ({ time, satellite: 0 }) as Opportunity;
    // A station right under the satellite: at once.
    const now = op(T);
    addDownlinks(satrec, [now], [{ name: 'here', lon: below[0], lat: below[1], minElevation: 5 }]);
    expect(now.downlink).toEqual({ time: T, station: 0 });
    // From an hour before, it rises there before T (and within a few minutes of it).
    const earlier = op(T - 3600000);
    addDownlinks(satrec, [earlier], [{ name: 'far', lon: 0, lat: 0, minElevation: 5 }, { name: 'here', lon: below[0], lat: below[1], minElevation: 5 }]);
    expect(earlier.downlink!.time).toBeGreaterThan(earlier.time);
    expect(earlier.downlink!.time).toBeLessThanOrEqual(T);
  });

  it('is worked out by the plan when stations are given', () => {
    const { opportunities } = planAccess([iss()], [{ label: 't', center: [139.7, 35.7], points: [] }], {
      start: epoch,
      end: epoch + 2 * 86400000,
      maxOffNadir: null,
      daylight: 'none',
      minSunElevation: 10,
      stations: [{ name: '勝浦', lon: 140.3, lat: 35.15, minElevation: 5 }],
    });
    expect(opportunities.length).toBeGreaterThan(0);
    // The station is near the target: most shots are sent down at once.
    for (const o of opportunities) expect(o.downlink).toBeDefined();
    expect(opportunities.filter((o) => o.downlink!.time === o.time).length).toBeGreaterThan(0);
  });
});

describe('cloud forecasts', () => {
  const series = { times: [0, 3600000, 7200000], cover: [0, 100, 50] };

  it('reads the cover between hours', () => {
    expect(cloudAt(series, 1800000)).toBe(50);
    expect(cloudAt(series, 7200000)).toBe(50);
    expect(cloudAt(series, 9000000)).toBeNull();
  });

  it('checks config.json', () => {
    const problems: string[] = [];
    expect(cloudForecastOf({ url: 'https://wx.example/v1/forecast', label: '社内' }, problems)).toEqual({ url: 'https://wx.example/v1/forecast', label: '社内' });
    expect(cloudForecastOf(false, problems)).toBeNull();
    expect(cloudForecastOf('x', problems)).toEqual(defaultCloudForecast);
    expect(problems).toHaveLength(1);
  });

  it('asks for the places of optical shots, sharing nearby ones, and fills the shots in', async () => {
    const now = Date.UTC(2026, 9, 22);
    const sats = [iss(), iss({ sar: true })];
    const targets = [
      { label: 'a', center: [139.7, 35.7] as [number, number], points: [] },
      { label: 'b', center: [139.71, 35.71] as [number, number], points: [] },
      { label: 'c', center: [135.5, 34.7] as [number, number], points: [] },
    ];
    const base = { offNadir: 1, incidence: 1, elevation: 89, side: 'left' as const, ascending: true, sunElevation: 30, range: 400, width: 0, strips: 1, length: 0, frames: 1, coverage: 1, window: [0, 0] as [number, number], along: [0, 0] as [number, number], tleAge: 0, orbitRadius: 6800, azimuth: 0, satEcef: [0, 0, 6800] as [number, number, number] };
    const ops: Opportunity[] = [
      { ...base, satellite: 0, target: 0, time: now + 3600000 },
      { ...base, satellite: 0, target: 1, time: now + 5400000 },
      { ...base, satellite: 1, target: 2, time: now + 3600000 },
      { ...base, satellite: 0, target: 2, time: now + 40 * 86400000 },
    ];
    const places = placesFor(ops, sats, targets, now);
    expect(places).toHaveLength(2);
    const asked: string[] = [];
    const fetcher = (async (url: string) => {
      asked.push(url);
      const u = new URL(url);
      const n = u.searchParams.get('latitude')!.split(',').length;
      const one = { hourly: { time: [now / 1000, now / 1000 + 7200], cloud_cover: [20, 60] } };
      return new Response(JSON.stringify(n === 1 ? one : Array.from({ length: n }, () => one)));
    }) as typeof fetch;
    const forecasts = await fetchClouds(defaultCloudForecast, places, fetcher);
    // a and b share a grid cell: one place asked for.
    expect(asked).toHaveLength(1);
    expect(new URL(asked[0]).searchParams.get('hourly')).toBe('cloud_cover');
    expect(applyClouds(ops, sats, targets, forecasts)).toBe(2);
    expect(ops[0].cloud).toBe(40);
    expect(ops[1].cloud).toBe(50);
    expect(ops[2].cloud).toBeUndefined();
    expect(ops[3].cloud).toBeUndefined();
  });
});
