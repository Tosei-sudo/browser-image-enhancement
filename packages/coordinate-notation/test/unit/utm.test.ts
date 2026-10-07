import proj4 from 'proj4';
import { describe, expect, it } from 'vitest';
import { fromUtm, toUtm } from '../../src/utm.js';

function utmProj(zone: number, north: boolean): string {
  return `+proj=utm +zone=${zone}${north ? '' : ' +south'} +datum=WGS84 +units=m +no_defs`;
}

describe('UTM', () => {
  // Across each zone and a little beyond its edges (Norway/Svalbard zones are wider), pole to pole.
  const points: Array<[number, number]> = [];
  for (let lat = -80; lat <= 84; lat += 7.3) for (let dLon = -4.5; dLon <= 4.5; dLon += 1.5) points.push([135 + dLon, lat]);

  it('matches proj4 to the millimetre', () => {
    for (const lonLat of points) {
      const north = lonLat[1] >= 0;
      const ours = toUtm(lonLat, 54, north);
      const theirs = proj4('EPSG:4326', utmProj(54, north), lonLat);
      expect(Math.abs(ours[0] - theirs[0])).toBeLessThan(1e-3);
      expect(Math.abs(ours[1] - theirs[1])).toBeLessThan(1e-3);
    }
  });

  it('round-trips', () => {
    for (const lonLat of points) {
      const north = lonLat[1] >= 0;
      const back = fromUtm(toUtm(lonLat, 54, north), 54, north);
      expect(back[0]).toBeCloseTo(lonLat[0], 9);
      expect(back[1]).toBeCloseTo(lonLat[1], 9);
    }
  });
});
