import { describe, expect, it } from 'vitest';
import { planAccess, satellitesFromText, subSatellitePoint, type PlanOptions, type SatelliteSpec } from '../src/imaging-plan.js';
import { attitude, ecefOf, satellitePass3d, type Xyz } from '../src/imaging-plan-3d.js';

// The ISS-like orbit of imaging-plan.test.ts (51.6°, about 420 km), epoch 2026-10-07 12:00 UTC.
const line1 = '1 25544U 98067A   26280.50000000  .00016717  00000-0  10270-3 0  9994';
const line2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49815399432717';
const epoch = Date.UTC(2026, 0, 1) + 279.5 * 86400000;
const iss = (): SatelliteSpec => satellitesFromText(`ISS\n${line1}\n${line2}`, { maxOffNadir: 45, minOffNadir: 0, swath: 10 })[0];
const around = (t: number): PlanOptions => ({ start: t - 1800000, end: t + 1800000, maxOffNadir: null, daylight: 'none', minSunElevation: 10 });

const sub = (a: Xyz, b: Xyz): Xyz => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Xyz, b: Xyz) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Xyz): Xyz => a.map((c) => c / Math.hypot(...a)) as Xyz;

describe('imaging passes in 3D', () => {
  const T = epoch + 3600000;
  const below = subSatellitePoint(iss(), T)!;
  // A point 150 km east of the track: the satellite looks right, some 15° off nadir.
  const target: [number, number] = [below[0] + 150 / (111.32 * Math.cos((below[1] * Math.PI) / 180)), below[1]];
  const targets = [{ label: 'b', center: target, points: [] }];
  const op = planAccess([iss()], targets, around(T)).opportunities.find((o) => Math.abs(o.time - T) < 600000)!;
  const pass = satellitePass3d(iss(), targets[0], op, true)!;

  it('raises the orbit to its height, centred on the moment', () => {
    expect(pass.orbit.length).toBe(73);
    for (const h of pass.heights) {
      expect(h).toBeGreaterThan(380_000);
      expect(h).toBeLessThan(460_000);
    }
    // The middle of the orbit is where the satellite is at the moment.
    expect(Math.hypot(...sub(pass.orbit[36], pass.position))).toBeLessThan(1);
    // Over the ground track: the satellite's direction from the centre is that of its sub-satellite point.
    const sat = subSatellitePoint(iss(), op.time)!;
    const ground = unit(ecefOf(sat[0], sat[1]));
    expect(dot(unit(pass.position), ground)).toBeGreaterThan(Math.cos((0.3 * Math.PI) / 180));
    // About 7.6 km/s over the ground.
    expect(Math.hypot(...pass.velocity)).toBeGreaterThan(7000);
    expect(Math.hypot(...pass.velocity)).toBeLessThan(7800);
  });

  it('aims at the scenes, at the angle the plan found', () => {
    expect(pass.scenes.length).toBe(1);
    const toAim = unit(sub(pass.aim, pass.position));
    const down = unit(pass.position).map((c) => -c) as Xyz;
    const offNadir = (Math.acos(dot(toAim, down)) * 180) / Math.PI;
    // The plan works on a sphere, the 3D view on the ellipsoid: within a couple of degrees.
    expect(Math.abs(offNadir - op.offNadir)).toBeLessThan(2);
    // The middle of the scene is at the target (a point), as near as the plan's spherical Earth places the scene.
    expect(Math.hypot(...sub(pass.aim, ecefOf(target[0], target[1])))).toBeLessThan(25_000);
  });

  it('turns the satellite so its sensor (−z) faces the aim and x follows the track', () => {
    const { x, y, z } = attitude(pass);
    for (const a of [x, y, z]) expect(Math.hypot(...a)).toBeCloseTo(1, 9);
    expect(dot(x, y)).toBeCloseTo(0, 9);
    expect(dot(y, z)).toBeCloseTo(0, 9);
    expect(dot(x, z)).toBeCloseTo(0, 9);
    expect(dot(z, unit(sub(pass.aim, pass.position)))).toBeCloseTo(-1, 9);
    expect(dot(x, unit(pass.velocity))).toBeGreaterThan(0.9);
    // Right-handed: x × y = z.
    const c: Xyz = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    expect(dot(c, z)).toBeCloseTo(1, 9);
  });
});
