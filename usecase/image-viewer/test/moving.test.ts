import { describe, expect, it } from 'vitest';
import {
  detectFields,
  distanceMetres,
  feedTypeOf,
  feedUrl,
  guessKind,
  historyRows,
  matchDetections,
  movingFeedOf,
  positionAt,
  readRecord,
  recordsOf,
  timeOf,
  trailOf,
  TrackStore,
  type MovingRecord,
} from '../src/moving.js';
import { parseConfig } from '../src/config.js';

const T0 = Date.UTC(2026, 9, 17, 9, 0, 0);
const rec = (id: string, minutes: number, lon: number, lat: number, extra: Partial<MovingRecord> = {}): MovingRecord => ({
  id,
  t: T0 + minutes * 60_000,
  lon,
  lat,
  heading: null,
  course: null,
  speed: null,
  name: null,
  kind: null,
  attrs: {},
  ...extra,
});

describe('reading messages', () => {
  it('reads plain objects, GeoJSON, Esri features, lists under a key and OpenSky states', () => {
    expect(recordsOf({ mmsi: 1, lat: 35, lon: 139 })).toEqual([{ mmsi: 1, lat: 35, lon: 139 }]);
    expect(recordsOf([{ a: 1 }, { a: 2 }, 'x'])).toHaveLength(2);
    const gj = recordsOf({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 7, properties: { name: 'A' }, geometry: { type: 'Point', coordinates: [139.5, 35.2] } }] });
    expect(gj).toEqual([{ name: 'A', _lon: 139.5, _lat: 35.2, id: 7 }]);
    const esri = recordsOf({ attributes: { TRACKID: 'x' }, geometry: { x: 15584728.7, y: 4257087.3, spatialReference: { wkid: 102100 } } });
    expect(esri[0].TRACKID).toBe('x');
    expect(esri[0]._lon as number).toBeCloseTo(140, 3);
    expect(esri[0]._lat as number).toBeCloseTo(35.683, 2);
    expect(recordsOf({ vessels: [{ mmsi: 1 }, { mmsi: 2 }] })).toHaveLength(2);
    const sky = recordsOf({ time: 1, states: [['abc123', 'JAL1  ', 'Japan', 1760000000, 1760000001, 139.7, 35.5, 1000, false, 200, 90]] });
    expect(sky[0]).toMatchObject({ icao24: 'abc123', callsign: 'JAL1', longitude: 139.7, latitude: 35.5, true_track: 90 });
  });

  it('flattens nested messages (aisstream.io) and finds the fields by name', () => {
    const msg = {
      MessageType: 'PositionReport',
      MetaData: { MMSI: 431000001, ShipName: 'HIKARI ', latitude: 35.1, longitude: 139.8, time_utc: '2026-10-17 09:00:00.123456789 +0000 UTC' },
      Message: { PositionReport: { Cog: 45.5, Sog: 12.3, TrueHeading: 511, Latitude: 35.1, Longitude: 139.8 } },
    };
    const [flat] = recordsOf(msg);
    const map = detectFields(Object.keys(flat));
    expect(map).toMatchObject({
      id: 'MetaData.MMSI',
      time: 'MetaData.time_utc',
      lat: 'MetaData.latitude',
      lon: 'MetaData.longitude',
      heading: 'Message.PositionReport.TrueHeading',
      course: 'Message.PositionReport.Cog',
      speed: 'Message.PositionReport.Sog',
      name: 'MetaData.ShipName',
    });
    const r = readRecord(flat, map, 0)!;
    expect(r).toMatchObject({ id: '431000001', t: Date.UTC(2026, 9, 17, 9, 0, 0, 123), heading: null, course: 45.5, speed: 12.3, name: 'HIKARI' });
    expect(guessKind(Object.keys(flat))).toBe('ship');
  });

  it('finds the usual names of ADS-B and MarineCadastre fields, and lets given fields win', () => {
    expect(detectFields(['icao24', 'callsign', 'latitude', 'longitude', 'true_track', 'velocity', 'last_contact'])).toEqual({
      id: 'icao24',
      name: 'callsign',
      lat: 'latitude',
      lon: 'longitude',
      course: 'true_track',
      speed: 'velocity',
      time: 'last_contact',
    });
    expect(guessKind(['icao24', 'callsign', 'baro_altitude'])).toBe('aircraft');
    expect(detectFields(['MMSI', 'BaseDateTime', 'LAT', 'LON', 'SOG', 'COG', 'Heading', 'VesselName'])).toMatchObject({ id: 'MMSI', time: 'BaseDateTime', lat: 'LAT', lon: 'LON', heading: 'Heading', name: 'VesselName' });
    expect(detectFields(['vid', 'lat', 'lon', 'mmsi'], { id: 'vid' })).toMatchObject({ id: 'vid', lat: 'lat' });
    expect(detectFields(['_lon', '_lat', 'id'])).toEqual({ id: 'id', lon: '_lon', lat: '_lat' });
  });

  it('reads times in seconds, ms and text (UTC without a zone), and drops bad positions', () => {
    expect(timeOf(1760691600)).toBe(1760691600000);
    expect(timeOf(1760691600000)).toBe(1760691600000);
    expect(timeOf('2026-10-17T09:00:00')).toBe(T0);
    expect(timeOf('2026-10-17 18:00:00+09:00')).toBe(T0);
    expect(timeOf(42)).toBeNull();
    expect(readRecord({ id: 'a', lat: 91, lon: 0 }, { id: 'id', lat: 'lat', lon: 'lon' }, 0)).toBeNull();
    expect(readRecord({ lat: 1, lon: 0 }, { id: 'id', lat: 'lat', lon: 'lon' }, 0)).toBeNull();
    expect(readRecord({ id: 'a', lat: '1.5', lon: '2', x: 'y' }, { id: 'id', lat: 'lat', lon: 'lon' }, 5)).toMatchObject({ t: 5, lat: 1.5, lon: 2, attrs: { x: 'y' } });
  });

  it('reads a history CSV', () => {
    const csv = 'mmsi,timestamp,lat,lon,sog\n1,2026-10-17T09:00:00Z,35,139,10\n1,2026-10-17T09:10:00Z,35.1,139.1,\n';
    const rows = historyRows(new TextEncoder().encode(csv), 'ais.csv');
    expect(rows).toEqual([
      { mmsi: '1', timestamp: '2026-10-17T09:00:00Z', lat: '35', lon: '139', sog: '10' },
      { mmsi: '1', timestamp: '2026-10-17T09:10:00Z', lat: '35.1', lon: '139.1', sog: null },
    ]);
    expect(() => historyRows(new TextEncoder().encode('{'), 'x.json')).toThrow();
  });
});

describe('tracks', () => {
  it('keeps fixes in time order, replaces a repeated time and caps objects and fixes', () => {
    const store = new TrackStore({ maxObjects: 2, maxFixesPerTrack: 3, maxFixes: 100 });
    store.add(rec('a', 10, 0, 0));
    store.add(rec('a', 0, 0, 0, { name: 'late' }));
    store.add(rec('a', 5, 0, 0));
    store.add(rec('a', 5, 1, 1));
    expect(store.tracks.get('a')!.fixes.map((f) => [f.t - T0, f.lon])).toEqual([
      [0, 0],
      [300_000, 1],
      [600_000, 0],
    ]);
    expect(store.tracks.get('a')!.name).toBe('late');
    store.add(rec('a', 20, 0, 0));
    expect(store.tracks.get('a')!.fixes).toHaveLength(3);
    store.add(rec('b', 0, 0, 0));
    expect(store.add(rec('c', 0, 0, 0))).toBe(false);
    expect(store.dropped).toBe(1);
    expect(store.range()).toEqual([T0, T0 + 20 * 60_000]);
    store.prune(T0 + 6 * 60_000);
    expect(store.tracks.has('b')).toBe(false);
    expect(store.fixCount).toBe(2);
  });

  it('interpolates between fixes (across the antimeridian, headings the short way) and holds the last one', () => {
    const store = new TrackStore();
    store.add(rec('a', 0, 179.5, 10, { heading: 350 }));
    store.add(rec('a', 10, -179.5, 11, { heading: 10, speed: 10 }));
    const track = store.tracks.get('a')!;
    const mid = positionAt(track, T0 + 5 * 60_000, { hold: 60_000 })!;
    expect(mid.interpolated).toBe(true);
    expect(Math.abs(mid.lon)).toBeCloseTo(180, 6);
    expect(mid.lat).toBeCloseTo(10.5);
    expect(mid.dir).toBeCloseTo(0);
    expect(mid.speed).toBe(10);
    expect(positionAt(track, T0 - 1, { hold: 60_000 })).toBeNull();
    expect(positionAt(track, T0 + 10.5 * 60_000, { hold: 60_000 })).toMatchObject({ lon: -179.5, age: 30_000, interpolated: false });
    expect(positionAt(track, T0 + 12 * 60_000, { hold: 60_000 })).toBeNull();
    // A long gap is not joined.
    expect(positionAt(track, T0 + 5 * 60_000, { hold: 60_000, maxGap: 60_000 })).toBeNull();
    const trail = trailOf(track, T0 - 1, T0 + 5 * 60_000, [180, 10.5]);
    expect(trail).toEqual([
      [179.5, 10],
      [180, 10.5],
    ]);
  });
});

describe('matchDetections', () => {
  it('matches each detection to the nearest object where it was then, within the window and the distance', () => {
    const store = new TrackStore();
    // Ship a sails east along 35° N: 139.00 at 09:00, 139.10 at 09:20.
    store.add(rec('a', 0, 139.0, 35, { name: 'A' }));
    store.add(rec('a', 20, 139.1, 35));
    // Ship b lies still, but its last report is at 08:00.
    store.add(rec('b', -60, 139.2, 35));
    const at10 = T0 + 10 * 60_000;
    const results = matchDetections(
      [
        { lon: 139.05, lat: 35.001, t: at10 }, // a, interpolated, ~110 m away
        { lon: 139.2, lat: 35, t: at10 }, // b, but too old for ±10 min
        { lon: 139.05, lat: 35.02, t: at10 }, // too far (2.2 km)
        { lon: 139.0, lat: 35, t: null },
      ],
      store.tracks.values(),
      { window: 10 * 60_000, distance: 500 },
    );
    expect(results[0]).toMatchObject({ id: 'a', name: 'A', dt: 600 });
    expect(results[0]!.distance).toBeCloseTo(111, -1);
    expect(results[1]).toBeNull();
    expect(results[2]).toBeNull();
    expect(results[3]).toBeNull();
    const wide = matchDetections([{ lon: 139.2, lat: 35, t: at10 }], store.tracks.values(), { window: 90 * 60_000, distance: 500 });
    expect(wide[0]).toMatchObject({ id: 'b', distance: 0 });
  });

  it('measures distances on the sphere', () => {
    expect(distanceMetres([0, 0], [1, 0])).toBeCloseTo(111_195, -1);
    expect(distanceMetres([179.9, 0], [-179.9, 0])).toBeCloseTo(22_239, -1);
  });
});

describe('feeds', () => {
  it('tells the kind of feed from its URL and allows ws / wss and http / https only', () => {
    expect(feedTypeOf('wss://stream.example.com/v0/stream')).toBe('websocket');
    expect(feedTypeOf('https://example.com/arcgis/rest/services/Ships/StreamServer')).toBe('esri-stream');
    expect(feedTypeOf('https://example.com/ais/events')).toBe('sse');
    expect(feedTypeOf('https://example.com/ais/positions.json')).toBe('poll');
    expect(feedUrl('wss://a.example/x', 'websocket')).toBe('wss://a.example/x');
    expect(() => feedUrl('https://a.example/x', 'websocket')).toThrow();
    expect(() => feedUrl('javascript:alert(1)', 'poll')).toThrow();
    expect(() => feedUrl('file:///etc/passwd', 'sse')).toThrow();
    expect(() => feedUrl('https://u:p@a.example/x', 'poll')).toThrow();
    expect(feedUrl('./pos.json', 'poll', 'https://site.example/viewer/')).toBe('https://site.example/viewer/pos.json');
  });

  it('reads config.json movingFeeds, dropping the bad ones and saying why', () => {
    const problems: string[] = [];
    expect(movingFeedOf({ label: 'AIS', type: 'websocket', url: 'wss://a/x', kind: 'ship', fields: { id: 'MMSI', foo: 'x' } }, problems, 0)).toEqual({
      label: 'AIS',
      type: 'websocket',
      url: 'wss://a/x',
      kind: 'ship',
      fields: { id: 'MMSI' },
    });
    expect(problems).toHaveLength(1);
    expect(movingFeedOf({ type: 'poll', url: './p.json', interval: 30 }, [], 1)).toEqual({ label: 'フィード 2', type: 'poll', url: './p.json', interval: 30 });
    expect(movingFeedOf({ type: 'websocket', url: 'https://a/x' }, [], 0)).toBeNull();
    expect(movingFeedOf({ type: 'ftp', url: 'ftp://a' }, [], 0)).toBeNull();
    const { config, problems: all } = parseConfig({ movingFeeds: [{ type: 'sse', url: 'https://a/events' }, 3] });
    expect(config.movingFeeds).toEqual([{ label: 'フィード 1', type: 'sse', url: 'https://a/events' }]);
    expect(all).toHaveLength(1);
    expect(parseConfig({ movingFeeds: {} }).problems).toEqual(['movingFeeds は配列で指定']);
    expect(parseConfig({}).config.movingFeeds).toEqual([]);
  });
});
