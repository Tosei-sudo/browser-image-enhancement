import { describe, expect, it } from 'vitest';
import { fromLonLat } from 'ol/proj.js';
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
