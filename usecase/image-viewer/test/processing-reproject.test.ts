import { beforeAll, describe, expect, it } from 'vitest';
import proj4 from 'proj4';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import LineString from 'ol/geom/LineString.js';
import { fromLonLat, get as getProjection, transform } from 'ol/proj.js';
import { setProjectionCodeLookup } from 'ol/proj/proj4.js';
import { field } from '../src/processing/common.js';
import { crsPresets, registerJapaneseCrs, reproject, targetCrs } from '../src/processing/reproject.js';

const tokyoStation = [139.767125, 35.681236];

beforeAll(() => {
  registerJapaneseCrs();
  // No network in tests: codes that are not built in are unknown.
  setProjectionCodeLookup(async (code) => {
    throw new Error(`no definition for ${code}`);
  });
});

describe('registerJapaneseCrs', () => {
  it('registers every preset', () => {
    expect(crsPresets).toHaveLength(2 + 3 + 19 + 5 + 6);
    for (const { code } of crsPresets) expect(getProjection(code), code).not.toBeNull();
  });

  it('puts Tokyo Station in plane rectangular zone IX (origin 36°N 139°50′E)', () => {
    const [y, x] = proj4('EPSG:4326', 'EPSG:6677', tokyoStation);
    // About 35.4 km south and 6.0 km west of the origin.
    expect(x).toBeCloseTo(-35_363.2, 0);
    expect(y).toBeCloseTo(-5_992.9, 0);
    // Through the map projection as well.
    const [e, n] = transform(fromLonLat(tokyoStation), 'EPSG:3857', 'EPSG:6677');
    expect(e).toBeCloseTo(y, 3);
    expect(n).toBeCloseTo(x, 3);
  });

  it('has each zone origin at 0, 0', () => {
    expect(proj4('EPSG:4326', 'EPSG:6669', [129.5, 33]).map((v) => Math.abs(v))).toEqual([expect.closeTo(0, 6), expect.closeTo(0, 6)]);
    expect(proj4('EPSG:4326', 'EPSG:6678', [140 + 50 / 60, 40]).map((v) => Math.abs(v))).toEqual([expect.closeTo(0, 6), expect.closeTo(0, 6)]);
    expect(proj4('EPSG:4326', 'EPSG:6687', [154, 26]).map((v) => Math.abs(v))).toEqual([expect.closeTo(0, 6), expect.closeTo(0, 6)]);
  });

  it('shifts the Tokyo datum like the GSI approximation (about 12″)', () => {
    const [lon, lat] = proj4('EPSG:4326', 'EPSG:4301', tokyoStation);
    expect(lat - tokyoStation[1]).toBeCloseTo(-0.00324, 4);
    expect(lon - tokyoStation[0]).toBeCloseTo(0.00323, 4);
  });

  it('round trips through UTM and the plane zones', () => {
    for (const code of ['EPSG:6677', 'EPSG:6691', 'EPSG:32654', 'EPSG:4301', 'EPSG:6668']) {
      const back = proj4(code, 'EPSG:4326', proj4('EPSG:4326', code, tokyoStation));
      // The datum shift is undone by iteration: within a few millimetres.
      expect(back[0], code).toBeCloseTo(tokyoStation[0], 7);
      expect(back[1], code).toBeCloseTo(tokyoStation[1], 7);
    }
  });
});

describe('targetCrs', () => {
  it('accepts codes with or without EPSG:', async () => {
    const a = await targetCrs('EPSG:6677');
    const b = await targetCrs('6677');
    expect(a).toEqual(b);
    expect(a.epsg).toBe(6677);
    expect(a.projection).toBe('EPSG:6677');
    expect(a.name).toContain('IX');
    expect(a.wkt).toContain('JGD_2011_Japan_Zone_9');
    expect(a.wkt).toContain('PARAMETER["Central_Meridian",139.8333333');
  });

  it('uses the shared WGS 84 and Web Mercator definitions', async () => {
    expect((await targetCrs('4326')).wkt).toContain('GCS_WGS_1984');
    expect((await targetCrs('EPSG:3857')).projection).toBe('EPSG:3857');
  });

  it('rejects unknown codes and non-codes in Japanese', async () => {
    await expect(targetCrs('EPSG:999999')).rejects.toThrow('見つかりません');
    await expect(targetCrs('Tokyo')).rejects.toThrow('EPSG コード');
  });

  it('takes the WKT of other known codes from the lookup', async () => {
    proj4.defs('EPSG:2451', '+proj=tmerc +lat_0=36 +lon_0=139.8333333333333 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs');
    registerJapaneseCrs();
    const crs = await targetCrs('2451', async (code) => `WKT ${code}`);
    expect(crs.wkt).toBe('WKT EPSG:2451');
    expect((await targetCrs('2451')).wkt).toBeNull();
  });
});

describe('reproject', () => {
  it('keeps map coordinates, sets the CRS and drops what cannot be converted', async () => {
    const crs = await targetCrs('6677');
    const near = new Feature({ geometry: new Point(fromLonLat(tokyoStation)), name: '東京駅' });
    const line = new Feature({ geometry: new LineString([fromLonLat([139.7, 35.6]), fromLonLat([139.8, 35.7])]), name: '線' });
    // A quarter of the way round the earth transverse Mercator has no answer.
    const far = new Feature({ geometry: new Point(fromLonLat([50, 0])), name: 'far' });
    const result = reproject({ title: '駅', features: [near, line, far], fields: [field('name', 'string')] }, crs);
    expect(result.title).toBe('駅_EPSG6677');
    expect(result.crs).toBe(crs);
    expect(result.features.map((f) => f.get('name'))).toEqual(['東京駅', '線']);
    expect(result.features[0]).not.toBe(near);
    expect((result.features[0].getGeometry() as Point).getCoordinates()).toEqual(near.getGeometry()!.getCoordinates());
    expect(result.notes!.join('\n')).toContain('1 個');
    expect(result.fields.map((f) => f.name)).toEqual(['name']);
  });
});
