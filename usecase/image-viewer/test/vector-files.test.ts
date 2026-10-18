import { describe, expect, it } from 'vitest';
import { fromLonLat } from 'ol/proj.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import type Geometry from 'ol/geom/Geometry.js';
import { parseShp } from 'shpjs';
import { ascii, dbf, shp, tokyoSjis, utf8, zip } from './fixtures.js';
import { dbfEncoding, readGeoJson, readShapefile, readVectorFiles } from '../src/vector-files.js';

describe('dbfEncoding', () => {
  const fields = [{ name: 'NAME', length: 10 }];
  it('follows the .cpg, also Windows code page numbers', () => {
    const file = dbf(fields, [[utf8('東京')]]);
    expect(dbfEncoding(file, 'UTF-8')).toBe('utf-8');
    expect(dbfEncoding(file, '932')).toBe('shift_jis');
    expect(dbfEncoding(file, 'ANSI 1252')).toBe('windows-1252');
  });

  it('without a .cpg: the language driver, else UTF-8 when the text is valid UTF-8, else Shift_JIS', () => {
    expect(dbfEncoding(dbf(fields, [[ascii('abc')]], 0x13))).toBe('shift_jis');
    expect(dbfEncoding(dbf(fields, [[utf8('東京')]]))).toBe('utf-8');
    expect(dbfEncoding(dbf(fields, [[tokyoSjis]]))).toBe('shift_jis');
  });
});

describe('readShapefile', () => {
  it('reads points and Shift_JIS attributes without a .cpg, into the map projection', () => {
    const file = readShapefile('sites', {
      shp: shp([[139.7, 35.7], [135.5, 34.7]]),
      dbf: dbf([{ name: 'NAME', length: 10 }, { name: 'POP', type: 'N', length: 8 }], [[tokyoSjis, ascii('100')], [ascii('Osaka'), ascii('20')]]),
    });
    expect(file.format).toBe('Shapefile');
    expect(file.encoding).toBe('shift_jis');
    expect(file.features.map((f) => f.get('NAME'))).toEqual(['東京', 'Osaka']);
    expect(file.features.map((f) => f.get('POP'))).toEqual([100, 20]);
    expect(file.fields.map((f) => [f.name, f.type])).toEqual([['NAME', 'string'], ['POP', 'double']]);
    const [x, y] = (file.features[0].getGeometry() as unknown as { getCoordinates(): number[] }).getCoordinates();
    const [ex, ey] = fromLonLat([139.7, 35.7]);
    expect(x).toBeCloseTo(ex, 3);
    expect(y).toBeCloseTo(ey, 3);
  });

  it('asks for the .prj when the coordinates are not longitude / latitude', () => {
    expect(() => readShapefile('plane', { shp: shp([[-5000, 30000]]) })).toThrow(/\.prj/);
  });

  it('reprojects with the .prj', () => {
    const prj = 'PROJCS["WGS_1984_UTM_Zone_54N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",141.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';
    const file = readShapefile('utm', { shp: shp([[500000, 3900000]]), prj });
    expect(file.crs).toBe('WGS_1984_UTM_Zone_54N');
    const [x] = (file.features[0].getGeometry() as unknown as { getCoordinates(): number[] }).getCoordinates();
    expect(x).toBeCloseTo((141 * Math.PI * 6378137) / 180, -1);
  });
});

/** A .shp of `type` (1 point, 3 line, 5 polygon, 8 multipoint; +10 with z): one record per shape, each a list of parts of [x, y]. */
function shpOf(type: number, shapes: Array<Array<Array<[number, number]>> | null>): Uint8Array<ArrayBuffer> {
  const z = type > 10;
  const base = type % 10;
  const records = shapes.map((parts) => {
    if (!parts) return new Uint8Array(4);
    const points = parts.flat();
    if (base === 1) {
      const r = new DataView(new ArrayBuffer(z ? 36 : 20));
      r.setInt32(0, type, true);
      r.setFloat64(4, points[0][0], true);
      r.setFloat64(12, points[0][1], true);
      return new Uint8Array(r.buffer);
    }
    const head = base === 8 ? 40 : 44 + parts.length * 4;
    const zBytes = z ? 16 + points.length * 8 + 16 + points.length * 8 : 0;
    const r = new DataView(new ArrayBuffer(head + points.length * 16 + zBytes));
    r.setInt32(0, type, true);
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((v, i) => r.setFloat64(4 + i * 8, v, true));
    if (base === 8) r.setInt32(36, points.length, true);
    else {
      r.setInt32(36, parts.length, true);
      r.setInt32(40, points.length, true);
      let start = 0;
      parts.forEach((p, i) => {
        r.setInt32(44 + i * 4, start, true);
        start += p.length;
      });
    }
    points.forEach(([x, y], i) => {
      r.setFloat64(head + i * 16, x, true);
      r.setFloat64(head + i * 16 + 8, y, true);
    });
    return new Uint8Array(r.buffer);
  });
  const out = new Uint8Array(100 + records.reduce((n, r) => n + 8 + r.length, 0));
  const v = new DataView(out.buffer);
  v.setInt32(0, 9994);
  v.setInt32(24, out.length / 2);
  v.setInt32(28, 1000, true);
  v.setInt32(32, type, true);
  let at = 100;
  records.forEach((r, i) => {
    v.setInt32(at, i + 1);
    v.setInt32(at + 4, r.length / 2);
    out.set(r, at + 8);
    at += 8 + r.length;
  });
  return out;
}

describe('readShapefile geometries', () => {
  const square = (x: number, y: number, size: number, clockwise = true): Array<[number, number]> => {
    const ring: Array<[number, number]> = [[x, y], [x, y + size], [x + size, y + size], [x + size, y], [x, y]];
    return clockwise ? ring : ring.reverse();
  };
  const shapes: Record<string, [number, Array<Array<Array<[number, number]>> | null>]> = {
    point: [1, [[[[139, 35]]], [[[140, 36]]]]],
    pointZ: [11, [[[[139, 35]]]]],
    multipoint: [8, [[[[139, 35], [139.5, 35.5]]], [[[140, 36]]]]],
    line: [3, [[[[139, 35], [139.5, 35.5], [140, 35]]], [[[139, 35], [139.1, 35.1]], [[139.2, 35.2], [139.3, 35.3]]]]],
    lineZ: [13, [[[[139, 35], [139.5, 35.5]]]]],
    polygon: [5, [[square(139, 35, 1)], [square(139, 35, 1), square(139.2, 35.2, 0.2, false)], [square(139, 35, 1), square(141, 35, 1)], null]],
    polygonZ: [15, [[square(139, 35, 1), square(139.2, 35.2, 0.2, false)]]],
    // Written the other way round: outer rings counter-clockwise, holes clockwise.
    reversed: [5, [[square(139, 35, 1, false), square(139.2, 35.2, 0.2, true)], [square(139, 35, 1, false), square(141, 35, 1, false)]]],
  };
  const geojson = new GeoJSON();
  for (const [name, [type, list]] of Object.entries(shapes)) {
    it(`reads ${name} as shpjs did`, () => {
      const bytes = shpOf(type, list);
      const file = readShapefile(name, { shp: bytes });
      const expected = parseShp(bytes).map((g) => (g ? (geojson.readGeometry(g, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' }) as Geometry) : null));
      const actual = file.features.map((f) => f.getGeometry() ?? null);
      expect(actual.map((g) => g?.getType() ?? null)).toEqual(expected.map((g) => g?.getType() ?? null));
      actual.forEach((g, i) => {
        const e = expected[i];
        if (!g || !e) return expect(g).toBe(e);
        // x / y only, every ring as in the file.
        const xy = (geometry: Geometry) => {
          const c = geometry as unknown as { getFlatCoordinates(): number[]; getStride(): number };
          return c.getFlatCoordinates().filter((_, k) => k % c.getStride() < 2);
        };
        const [a, b] = [xy(g), xy(e)];
        // Reversed rings come back the other way round from shpjs: compare as sets of rings.
        expect(a.length).toBe(b.length);
        expect([...a].sort()).toEqual([...b].sort());
      });
    });
  }

  it('puts a hole in the outer ring around it, not the first whose box holds it', () => {
    // Two outer rings whose boxes overlap: an L shape, and a square sticking out of its box with the hole in it.
    const l: Array<[number, number]> = [[0, 0], [0, 3], [1, 3], [1, 1], [3, 1], [3, 0], [0, 0]];
    const file = readShapefile('l', { shp: shpOf(5, [[l, square(2, 2, 1.5), square(2.2, 2.2, 0.2, false)]]) });
    const polygons = (file.features[0].getGeometry() as unknown as { getPolygons(): Array<{ getLinearRingCount(): number }> }).getPolygons();
    expect(polygons.map((p) => p.getLinearRingCount())).toEqual([1, 2]);
  });
});

describe('readGeoJson', () => {
  it('reads features with their properties', async () => {
    const text = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'a', n: 1 } }] });
    const file = await readGeoJson(text, 'points');
    expect(file.features).toHaveLength(1);
    expect(file.fields.map((f) => f.name)).toEqual(['name', 'n']);
  });

  it('says when a file is not JSON', async () => {
    await expect(readGeoJson('nope', 'bad')).rejects.toThrow(/JSON/);
  });
});

describe('readVectorFiles', () => {
  it('pairs a .shp with its .dbf by name', async () => {
    const files = await readVectorFiles([
      { name: 'a.shp', bytes: shp([[1, 2]]) },
      { name: 'a.dbf', bytes: dbf([{ name: 'ID', length: 4 }], [[ascii('7')]]) },
    ]);
    expect(files.map((f) => [f.title, f.features[0].get('ID')])).toEqual([['a', '7']]);
  });

  it('opens a .zip, in folders, with its .cpg', async () => {
    const files = await readVectorFiles([
      {
        name: 'data.zip',
        bytes: zip([
          { name: 'data/a.shp', bytes: shp([[1, 2]]) },
          { name: 'data/a.dbf', bytes: dbf([{ name: 'NAME', length: 10 }], [[utf8('東京')]]) },
          { name: 'data/a.cpg', bytes: new TextEncoder().encode('UTF-8') },
          { name: '__MACOSX/data/._a.shp', bytes: new Uint8Array(4) },
        ]),
      },
    ]);
    expect(files.map((f) => [f.title, f.encoding, f.features[0].get('NAME')])).toEqual([['a', 'utf-8', '東京']]);
  });

  it('asks for the .shp when only the .dbf is given', async () => {
    await expect(readVectorFiles([{ name: 'a.dbf', bytes: dbf([{ name: 'ID', length: 4 }], []) }])).rejects.toThrow(/a\.shp/);
  });
});
