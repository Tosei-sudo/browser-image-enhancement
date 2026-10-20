import { describe, expect, it } from 'vitest';
import { groundRange, sampleSatellites, subSatellitePoint } from '../src/imaging-plan.js';
import { bandRings, reachAngles, sampleAt, satelliteTrack, stepFor, track3d, wrapLine, wrapPolygon } from '../src/satellite-track.js';
import { tickMinutes } from '../src/satellite-track-panel.js';

const [optical, sar] = sampleSatellites();
const t0 = Date.UTC(2026, 9, 8, 0, 0);
/** Great-circle distance, km. */
const km = ([a, b]: [number, number], [c, d]: [number, number]) => {
  const r = Math.PI / 180;
  const h = Math.sin(((d - b) * r) / 2) ** 2 + Math.cos(b * r) * Math.cos(d * r) * Math.sin(((c - a) * r) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
};

describe('reachAngles', () => {
  it('is one band across the nadir for a satellite looking both ways', () => {
    expect(reachAngles(optical)).toEqual([{ side: 'both', inner: -20, outer: 20 }]);
    expect(reachAngles(optical, 10)).toEqual([{ side: 'both', inner: -10, outer: 10 }]);
  });
  it('keeps the smallest angle and the side', () => {
    expect(reachAngles(sar)).toEqual([{ side: 'right', inner: -20, outer: -45 }]);
    expect(reachAngles({ ...sar, lookSide: 'both' }).map((a) => a.side)).toEqual(['left', 'right']);
    // A limit below the smallest angle leaves an empty band, not a reversed one.
    expect(reachAngles(sar, 10)).toEqual([{ side: 'right', inner: -10, outer: -10 }]);
  });
});

describe('satelliteTrack', () => {
  it('follows the sub-satellite point and reaches as far as the off-nadir angle', () => {
    const track = satelliteTrack(optical, t0, t0 + 30 * 60000, { step: 30 })!;
    expect(track.times.length).toBe(61);
    expect(track.times[0]).toBe(t0);
    expect(track.times.at(-1)).toBe(t0 + 30 * 60000);
    const mid = 30;
    const at = subSatellitePoint(optical, track.times[mid])!;
    expect(km(track.track[mid], at)).toBeLessThan(0.01);
    expect(track.heights[mid]).toBeGreaterThan(700_000);
    expect(track.heights[mid]).toBeLessThan(900_000);
    expect(track.bands).toHaveLength(1);
    const band = track.bands[0];
    const reach = groundRange(20, 6371 + track.heights[mid] / 1000);
    // Both edges about as far from the track as the angle reaches (the Earth's flattening and height make a few km).
    for (const edge of [band.inner, band.outer]) expect(Math.abs(km(edge[mid], track.track[mid]) - reach)).toBeLessThan(15);
    expect(track.offNadir).toEqual({ min: 20, max: 20 });
  });

  it('draws a SAR band only on its side, from its smallest angle', () => {
    const track = satelliteTrack(sar, t0, t0 + 10 * 60000, { step: 60 })!;
    expect(track.bands).toHaveLength(1);
    const [band] = track.bands;
    const i = 5;
    const near = km(band.inner[i], track.track[i]);
    const far = km(band.outer[i], track.track[i]);
    expect(near).toBeGreaterThan(200);
    expect(far).toBeGreaterThan(near + 300);
    expect(track.offNadir).toEqual({ min: 20, max: 45 });
  });

  it('cuts the reach of optical satellites at night when asked, never of SAR ones', () => {
    const day = satelliteTrack(optical, t0, t0 + 200 * 60000, { minSun: 10 })!;
    expect(day.open.some((o) => !o)).toBe(true);
    expect(day.open.some((o) => o)).toBe(true);
    // Two orbits: two stretches of daylight.
    expect(day.bands.length).toBe(2);
    expect(day.bands.reduce((n, b) => n + b.inner.length, 0)).toBeLessThan(day.times.length);
    expect(day.bands.every((b) => b.inner.length === b.outer.length)).toBe(true);
    const radar = satelliteTrack(sar, t0, t0 + 100 * 60000, { minSun: 10 })!;
    expect(radar.open.every(Boolean)).toBe(true);
  });

  it('chooses the step from the period, and finds the sample of a moment', () => {
    expect(stepFor(60_000)).toBe(10);
    expect(stepFor(7 * 86400000)).toBe(60);
    const track = satelliteTrack(optical, t0, t0 + 600000, { step: 10 })!;
    expect(track.times[sampleAt(track, t0 + 300000)]).toBe(t0 + 300000);
    expect(satelliteTrack({ ...optical, tle1: 'x', tle2: 'y' }, t0, t0 + 1)).toBeNull();
  });

  it('gives the 3D view the orbit at height, the reach and the satellite at the moment', () => {
    const track = satelliteTrack(optical, t0, t0 + 600000, { step: 10 })!;
    const t = track3d(track, '#e11d48', { index: 30, label: 'x' });
    expect(t.orbit).toHaveLength(track.times.length);
    expect(Math.hypot(...t.orbit[30])).toBeGreaterThan(6_900_000);
    expect(t.reach.length).toBeGreaterThan(0);
    expect(Math.hypot(...t.at!.velocity)).toBeGreaterThan(6000);
    expect(t.at!.position).toEqual(t.orbit[30]);
  });
});

describe('wrapLine and wrapPolygon', () => {
  it('cuts a line at the antimeridian with a point on it each side', () => {
    const pieces = wrapLine([
      [170, 0],
      [178, 2],
      [-178, 4],
      [-170, 6],
    ]);
    expect(pieces).toHaveLength(2);
    expect(pieces[0].at(-1)![0]).toBeCloseTo(180);
    expect(pieces[0].at(-1)![1]).toBeCloseTo(3);
    expect(pieces[1][0][0]).toBeCloseTo(-180);
    expect(pieces[1][0][1]).toBeCloseTo(3);
    for (const p of pieces) for (const [lon] of p) expect(Math.abs(lon)).toBeLessThanOrEqual(180 + 1e-9);
    expect(wrapLine([[0, 0], [10, 10]])).toEqual([[[0, 0], [10, 10]]]);
  });

  it('clips a ring across the antimeridian into one on each side', () => {
    const parts = wrapPolygon([
      [175, 0],
      [-175, 0],
      [-175, 5],
      [175, 5],
      [175, 0],
    ]);
    expect(parts).toHaveLength(2);
    for (const ring of parts) {
      expect(ring[0]).toEqual(ring.at(-1));
      const lons = ring.map(([lon]) => lon);
      expect(Math.max(...lons) - Math.min(...lons)).toBeCloseTo(5);
    }
  });

  it('makes rings of a band that cover each stretch once', () => {
    const track = satelliteTrack(optical, t0, t0 + 100 * 60000, { step: 20 })!;
    const rings = bandRings(track.bands[0], 30);
    expect(rings.length).toBe(Math.ceil((track.times.length - 1) / 30));
    for (const ring of rings) expect(ring[0]).toEqual(ring.at(-1));
    // A full orbit crosses the antimeridian: all pieces stay within the world.
    for (const ring of rings.flatMap(wrapPolygon)) for (const [lon] of ring) expect(Math.abs(lon)).toBeLessThanOrEqual(180 + 1e-9);
  });
});

describe('tickMinutes', () => {
  it('keeps the time marks few', () => {
    expect(tickMinutes(30)).toBe(1);
    expect(tickMinutes(200)).toBe(5);
    expect(tickMinutes(1440)).toBe(30);
    expect(tickMinutes(7 * 1440)).toBe(360);
  });
});
