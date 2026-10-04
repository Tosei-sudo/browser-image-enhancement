import { describe, expect, it } from 'vitest';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import { fromLonLat } from 'ol/proj.js';
import { gpkg } from './fixtures.js';
import { decodeGeometry, encodeGeometry, readGeoPackage, rows } from '../src/geopackage.js';
import { readVectorFiles } from '../src/vector-files.js';
import { writeShapefile } from '../src/vector-write.js';

const wgs84 = { id: 4326, organization: 'EPSG', code: 4326, definition: 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]' };
// JGD2011 / Japan Plane Rectangular CS IX: not built into OpenLayers, read from the file's WKT.
const plane9 = {
  id: 6677,
  organization: 'EPSG',
  code: 6677,
  definition:
    'PROJCS["JGD2011 / Japan Plane Rectangular CS IX",GEOGCS["JGD2011",DATUM["Japanese_Geodetic_Datum_2011",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",36],PARAMETER["central_meridian",139.833333333333],PARAMETER["scale_factor",0.9999],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1]]',
};

describe('GeoPackage geometry blobs', () => {
  it('round-trip with an envelope', () => {
    const polygon = new Polygon([[[0, 0], [2, 0], [2, 3], [0, 0]]]);
    const blob = encodeGeometry(polygon, 4326);
    expect([...blob.subarray(0, 4)]).toEqual([0x47, 0x50, 0, 0x03]);
    expect(new DataView(blob.buffer).getFloat64(8 + 24, true)).toBe(3);
    expect((decodeGeometry(blob) as Polygon).getCoordinates()).toEqual(polygon.getCoordinates());
  });
});

describe('readGeoPackage', () => {
  it('reads features, attributes and dates into the map projection, BLOBs left out of the table', async () => {
    const bytes = await gpkg('sites', wgs84, 'POINT', [
      [encodeGeometry(new Point([139.7, 35.7]), 4326), '東京', 100, '2024-05-01'],
      [null, null, null, null],
    ]);
    const [file] = await readVectorFiles([{ name: 'data/sites.gpkg', bytes }]);
    expect(file.title).toBe('sites');
    expect(file.format).toBe('GeoPackage');
    expect(file.geometryType).toBe('Point');
    expect(file.fields.map((f) => [f.name, f.type, f.editable])).toEqual([
      ['fid', 'oid', false],
      ['NAME', 'string', true],
      ['POP', 'integer', true],
      ['DAY', 'date', true],
    ]);
    expect(file.fields[1].length).toBe(20);
    const [a, b] = file.features;
    expect([a.getId(), a.get('NAME'), a.get('POP'), a.get('DAY')]).toEqual([1, '東京', 100, Date.UTC(2024, 4, 1)]);
    expect(a.get('PIC')).toEqual(new Uint8Array([1, 2]));
    const [x, y] = (a.getGeometry() as Point).getCoordinates();
    const [ex, ey] = fromLonLat([139.7, 35.7]);
    expect(x).toBeCloseTo(ex, 3);
    expect(y).toBeCloseTo(ey, 3);
    expect(b.getGeometry()).toBeUndefined();
  });

  it('reprojects with the WKT the file carries', async () => {
    const bytes = await gpkg('plane', plane9, 'POINT', [[encodeGeometry(new Point([0, 0]), 6677), 'origin', 1, null]]);
    const [file] = await readGeoPackage(bytes, 'plane');
    expect(file.projection).toBe('EPSG:6677');
    const [x, y] = (file.features[0].getGeometry() as Point).getCoordinates();
    const [ex, ey] = fromLonLat([139 + 50 / 60, 36]);
    expect(x).toBeCloseTo(ex, 0);
    expect(y).toBeCloseTo(ey, 0);
  });

  it('writes back in its own CRS (export in 元の座標系)', async () => {
    const bytes = await gpkg('plane', plane9, 'POINT', [[encodeGeometry(new Point([1000, 2000]), 6677), 'p', 1, null]]);
    const [file] = await readGeoPackage(bytes, 'plane');
    expect(file.writeCrs).toMatchObject({ projection: 'EPSG:6677', epsg: 6677, wkt: plane9.definition });
    const files = writeShapefile('plane', file.features, file.fields, file.writeCrs);
    expect(new TextDecoder().decode(files.find((f) => f.name === 'plane.prj')!.bytes)).toBe(plane9.definition);
    const view = new DataView(files[0].bytes.buffer);
    expect(view.getFloat64(100 + 12, true)).toBeCloseTo(1000, 3);
    expect(view.getFloat64(100 + 20, true)).toBeCloseTo(2000, 3);
  });

  it('keeps the spatial index right when a feature is added (the R-tree triggers call ST_ functions)', async () => {
    const bytes = await gpkg('sites', wgs84, 'POINT', [[encodeGeometry(new Point([1, 2]), 4326), 'a', 1, null]]);
    const [file] = await readGeoPackage(bytes, 'sites');
    const { db } = file.gpkg!;
    db.run('INSERT INTO sites (geom, NAME) VALUES (?, ?)', [encodeGeometry(new Point([5, 6]), 4326), 'b']);
    expect(rows(db, 'SELECT id, minx, maxy FROM rtree_sites_geom ORDER BY id')).toEqual([
      { id: 1, minx: 1, maxy: 2 },
      { id: 2, minx: 5, maxy: 6 },
    ]);
  });

  it('says when the file is not a GeoPackage', async () => {
    await expect(readGeoPackage(new TextEncoder().encode('not sqlite'), 'bad')).rejects.toThrow(/GeoPackage/);
  });
});
