import { describe, expect, it } from 'vitest';
import { DEFAULT_UNCERTAINTY } from '../src/imaging-plan-moving.js';
import { guessTargetFields, predictedPlaces, predictedTrack, targetsOf, type Report } from '../src/moving-target.js';

const t0 = Date.UTC(2026, 9, 24, 0, 0, 0);
const report = (attributes: Record<string, unknown>, lonLat: [number, number]): Report => ({ attributes, lonLat });

describe('guessTargetFields', () => {
  it('finds the usual names and takes the heading for a missing course', () => {
    const f = guessTargetFields(['mmsi', 'timestamp', 'heading', 'sog', 'shipname']);
    expect(f.id).toBe('mmsi');
    expect(f.time).toBe('timestamp');
    expect(f.course).toBe('heading');
    expect(f.speed).toBe('sog');
  });
});

describe('targetsOf', () => {
  const fields = { id: 'TRACK_NO', time: 'OBS_TIME', course: 'HDG', speed: 'SPD', name: 'NAME' };

  it('takes each target at its last report and converts the speed to knots', () => {
    const reports = [
      report({ TRACK_NO: 'A', OBS_TIME: new Date(t0).toISOString(), HDG: 90, SPD: 18.52, NAME: 'Alpha' }, [139, 35]),
      report({ TRACK_NO: 'A', OBS_TIME: new Date(t0 + 3600000).toISOString(), HDG: 45, SPD: 37.04, NAME: 'Alpha' }, [139.2, 35]),
      report({ TRACK_NO: 7, OBS_TIME: t0, HDG: 511, SPD: 0 }, [140, 36]),
    ];
    const targets = targetsOf(reports, fields, 'kmh', DEFAULT_UNCERTAINTY, t0);
    expect(targets).toHaveLength(2);
    const a = targets.find((t) => t.id === 'A')!;
    expect(a.t).toBe(t0 + 3600000);
    expect(a.course).toBe(45);
    expect(a.speed).toBeCloseTo(20, 6);
    expect(a.name).toBe('Alpha');
    expect(a.lon).toBe(139.2);
    const b = targets.find((t) => t.id === '7')!;
    expect(b.course).toBeNull(); // 511: not available
    expect(b.name).toBe('7');
  });

  it('derives the course and speed from the last two reports when missing', () => {
    // 1 degree of latitude north (about 111.2 km) in 6 hours.
    const reports = [report({ TRACK_NO: 'X', OBS_TIME: t0 }, [139, 35]), report({ TRACK_NO: 'X', OBS_TIME: t0 + 6 * 3600000 }, [139, 36])];
    const [x] = targetsOf(reports, { id: 'TRACK_NO', time: 'OBS_TIME' }, 'kn', DEFAULT_UNCERTAINTY);
    expect(x.course).toBeCloseTo(0, 3);
    expect(x.speed).toBeCloseTo(111.195 / 1.852 / 6, 1);
  });

  it('leaves out reports without an id', () => {
    expect(targetsOf([report({ SPD: 3 }, [0, 0])], fields, 'kn', DEFAULT_UNCERTAINTY)).toEqual([]);
  });
});

describe('predictedPlaces', () => {
  it('grows the circles with the time since the report, by the model', () => {
    const model = { base: 1, share: 0, perHour: 2 };
    const [target] = targetsOf([report({ id: 'S', time: t0, course: 0, speed: 10 }, [139, 35])], { id: 'id', time: 'time', course: 'course', speed: 'speed' }, 'kn', model);
    const places = predictedPlaces([target], -Infinity, 12, 6);
    expect(places.map((p) => (p.t - t0) / 3600000)).toEqual([0, 6, 12]);
    expect(places.map((p) => p.radius)).toEqual([1, 13, 25]);
    // Northward at 10 kn: 12 h is 222.24 km, about 2 degrees.
    expect(places[2].center[1]).toBeCloseTo(35 + 222.24 / 111.195, 2);
    expect(places[0].ring[0]).toEqual(places[0].ring[places[0].ring.length - 1]);
    expect(predictedTrack(target, 12)).toHaveLength(13);
  });
});
