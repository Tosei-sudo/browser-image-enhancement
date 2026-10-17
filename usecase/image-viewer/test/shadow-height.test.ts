import { describe, expect, it } from 'vitest';
import { heightFromShadow, shadowAzimuth, snapToRay, stepToward, sunFromGdalMetadata } from '../src/shadow-height.js';
import { sunAngles } from '../src/imaging-plan.js';

const xml = (items: Record<string, string>) => `<GDALMetadata>${Object.entries(items).map(([k, v]) => `<Item name="${k}">${v}</Item>`).join('')}</GDALMetadata>`;

describe('shadow height', () => {
  it('reads the Sun from the items satellite products write', () => {
    expect(sunFromGdalMetadata(xml({ SUN_ELEVATION: '54.3', SUN_AZIMUTH: '141.2' }))).toEqual({ elevation: 54.3, azimuth: 141.2, item: 'SUN_ELEVATION' });
    expect(sunFromGdalMetadata(xml({ MEANSUNEL: '60.1', MEANSUNAZ: '170.5' }))).toMatchObject({ elevation: 60.1, azimuth: 170.5 });
    expect(sunFromGdalMetadata(xml({ sun_elevation: '33', sun_azimuth: '200' }))).toMatchObject({ elevation: 33, azimuth: 200 });
    expect(sunFromGdalMetadata(xml({ NITF_USE00A_SUN_EL: '45.5', NITF_USE00A_SUN_AZ: '123.0' }))).toMatchObject({ elevation: 45.5, azimuth: 123 });
    // A zenith angle, and no azimuth.
    expect(sunFromGdalMetadata(xml({ MEAN_SOLAR_ZENITH_ANGLE: '30' }))).toMatchObject({ elevation: 60, azimuth: null });
    // NITF's "unknown", and nothing at all.
    expect(sunFromGdalMetadata(xml({ NITF_USE00A_SUN_EL: '999.9' }))).toBeNull();
    expect(sunFromGdalMetadata(xml({ AREA_OR_POINT: 'Area' }))).toBeNull();
  });

  it('works out the height from the length and the elevation', () => {
    expect(heightFromShadow(10, 45)).toBeCloseTo(10);
    expect(heightFromShadow(30, 30)).toBeCloseTo(17.32, 2);
    expect(shadowAzimuth(150)).toBe(330);
    expect(shadowAzimuth(300)).toBe(120);
  });

  it('snaps the tip onto the direction of the shadow, never behind the foot', () => {
    expect(snapToRay([0, 0], [0, 1], [3, 5])).toEqual([0, 5]);
    expect(snapToRay([10, 10], [1, 1], [12, 10])).toEqual([11, 11]);
    expect(snapToRay([0, 0], [0, 1], [3, -5])).toEqual([0, 0]);
  });

  it('steps toward an azimuth', () => {
    const [lon, lat] = stepToward([139.7, 35.7], 90, 1000);
    expect(lat).toBeCloseTo(35.7, 6);
    expect(lon).toBeGreaterThan(139.7);
    const north = stepToward([0, 0], 0, 111_320);
    expect(north[1]).toBeCloseTo(1, 6);
  });

  it('computes where the Sun is from a time and a place', () => {
    // Tokyo at noon on the June solstice: nearly overhead, a little west of south.
    const tokyo = sunAngles([139.69, 35.69], Date.UTC(2024, 5, 21, 3, 0));
    expect(tokyo.elevation).toBeGreaterThan(76);
    expect(tokyo.elevation).toBeLessThan(78.5);
    expect(tokyo.azimuth).toBeGreaterThan(175);
    expect(tokyo.azimuth).toBeLessThan(215);
    // Greenwich at noon at the March equinox: about 90° − 51.5°, due south.
    const greenwich = sunAngles([0, 51.48], Date.UTC(2024, 2, 20, 12, 0));
    expect(greenwich.elevation).toBeCloseTo(38.5, 0);
    expect(Math.abs(greenwich.azimuth - 180)).toBeLessThan(5);
    // Morning in Tokyo: in the east.
    expect(sunAngles([139.69, 35.69], Date.UTC(2024, 5, 20, 22, 0)).azimuth).toBeLessThan(100);
  });
});
