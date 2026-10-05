import { describe, expect, it } from 'vitest';
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import { fromLonLat } from 'ol/proj.js';
import type { Field } from '../src/services/index.js';
import { readGeoPackage, rows } from '../src/geopackage.js';
import { readVectorFiles, unzipFiles } from '../src/vector-files.js';
import { webMercator, writeGeoJson, writeGeoPackage, writeShapefile, zipFiles } from '../src/vector-write.js';
import { singleSpec, type VectorStyleSpec } from '../src/vector-style.js';

/** A style graduated by POP and labelled by 名称, shown at 1:50,000 and closer. */
function style(): VectorStyleSpec {
  return {
    ...singleSpec('#ff0000'),
    mode: 'graduated',
    field: 'POP',
    classes: [
      { min: 0, max: 50, color: '#fee5d9', visible: true },
      { min: 50, max: 100, color: '#a50f15', visible: true },
    ],
    label: { ...singleSpec('#ff0000').label, field: '名称' },
    minScale: 50000,
  };
}

const fields: Field[] = [
  { name: 'OBJECTID', alias: 'OBJECTID', type: 'oid', editable: false, nullable: false },
  { name: '名称', alias: '名称', type: 'string', editable: true, nullable: true },
  { name: 'POP', alias: 'POP', type: 'integer', editable: true, nullable: true },
  { name: 'AREA', alias: 'AREA', type: 'double', editable: true, nullable: true },
  { name: 'DAY', alias: 'DAY', type: 'date', editable: true, nullable: true },
];

function features(): Feature[] {
  return [
    new Feature({ geometry: new Point(fromLonLat([139.7, 35.7])), OBJECTID: 1, 名称: '東京', POP: 100, AREA: 1.25, DAY: Date.UTC(2024, 4, 1) }),
    new Feature({ geometry: new Point(fromLonLat([135.5, 34.7])), OBJECTID: 2, 名称: null, POP: null, AREA: null, DAY: null }),
  ];
}

const lonLat = (f: Feature) => (f.getGeometry() as Point).getCoordinates();

describe('writeGeoJson', () => {
  it('writes WGS 84 with ISO dates, and reads back', async () => {
    const text = writeGeoJson(features(), fields);
    const json = JSON.parse(text);
    expect(json.crs).toBeUndefined();
    expect(json.features[0].geometry.coordinates[0]).toBeCloseTo(139.7, 6);
    expect(json.features[0].properties).toEqual({ OBJECTID: 1, 名称: '東京', POP: 100, AREA: 1.25, DAY: '2024-05-01T00:00:00.000Z' });
    const [file] = await readVectorFiles([{ name: 'a.geojson', bytes: new TextEncoder().encode(text) }]);
    expect(lonLat(file.features[0])[0]).toBeCloseTo(lonLat(features()[0])[0], 2);
  });

  it('names another CRS in the crs member', () => {
    const json = JSON.parse(writeGeoJson(features(), fields, webMercator));
    expect(json.crs.properties.name).toBe('urn:ogc:def:crs:EPSG::3857');
    expect(json.features[0].geometry.coordinates[0]).toBeCloseTo(lonLat(features()[0])[0], 2);
  });
});

describe('writeShapefile', () => {
  it('writes points with UTF-8 attributes, a .prj and a .cpg, and reads back', async () => {
    const files = writeShapefile('sites', features(), fields);
    expect(files.map((f) => f.name)).toEqual(['sites.shp', 'sites.shx', 'sites.dbf', 'sites.prj', 'sites.cpg']);
    const [file] = await readVectorFiles([{ name: 'sites.zip', bytes: zipFiles(files) }]);
    expect(file.encoding).toBe('utf-8');
    const [a, b] = file.features;
    expect([a.get('名称'), a.get('POP'), a.get('AREA'), a.get('DAY')]).toEqual(['東京', 100, 1.25, Date.UTC(2024, 4, 1)]);
    // A .dbf has no null text: it reads back empty.
    expect([b.get('名称'), b.get('POP')]).toEqual(['', null]);
    expect(lonLat(a)[0]).toBeCloseTo(lonLat(features()[0])[0], 2);
  });

  it('cuts long names to 10 bytes, keeping them unique', async () => {
    const long: Field[] = [
      { name: 'population_2020', alias: '', type: 'integer', editable: true, nullable: true },
      { name: 'population_2025', alias: '', type: 'integer', editable: true, nullable: true },
    ];
    const f = new Feature({ geometry: new Point([0, 0]), population_2020: 1, population_2025: 2 });
    const [file] = await readVectorFiles([{ name: 'x.zip', bytes: zipFiles(writeShapefile('x', [f], long)) }]);
    expect(file.features[0].getProperties()).toMatchObject({ population: 1, populati_1: 2 });
  });

  it('splits geometry kinds into one Shapefile each; polygons with clockwise outer rings', async () => {
    const square = new Polygon([[[0, 0], [100000, 0], [100000, 100000], [0, 100000], [0, 0]]]);
    const mixed = [new Feature({ geometry: square, N: 'poly' }), new Feature({ geometry: new LineString([[0, 0], [1000, 1000]]), N: 'line' })];
    const files = writeShapefile('m', mixed, [{ name: 'N', alias: 'N', type: 'string', editable: true, nullable: true }]);
    expect(files.filter((f) => f.name.endsWith('.shp')).map((f) => f.name)).toEqual(['m_polygon.shp', 'm_line.shp']);
    const read = await readVectorFiles(files);
    expect(read.map((r) => [r.title, r.features[0].getGeometry()!.getType(), r.features[0].get('N')])).toEqual([
      ['m_polygon', 'Polygon', 'poly'],
      ['m_line', 'LineString', 'line'],
    ]);
    // shpjs makes clockwise .shp rings counter-clockwise (GeoJSON) again: an outer ring, not a hole.
    expect((read[0].features[0].getGeometry() as Polygon).getArea()).toBeGreaterThan(0);
  });
});

describe('styles in files', () => {
  it('writes a .qml beside each Shapefile, naming the columns as written', () => {
    const long: Field[] = [{ name: 'POPULATION_TOTAL', alias: 'P', type: 'integer', editable: true, nullable: true }];
    const f = new Feature({ geometry: new Point([0, 0]), POPULATION_TOTAL: 5 });
    const files = writeShapefile('x', [f], long, undefined, { ...style(), field: 'POPULATION_TOTAL', label: { ...style().label, field: null } });
    const qml = files.find((x) => x.name === 'x.qml');
    expect(qml).toBeDefined();
    const text = new TextDecoder().decode(qml!.bytes);
    expect(text).toContain('type="graduatedSymbol" attr="POPULATION"');
    expect(text).toContain('class="SimpleMarker"');
    expect(text).toContain('minScale="50000"');
    expect(writeShapefile('x', [f], long).some((x) => x.name.endsWith('.qml'))).toBe(false);
  });

  it('writes the style into layer_styles of a GeoPackage, as QGIS reads it', async () => {
    const bytes = await writeGeoPackage('sites', features(), fields, undefined, style());
    const [file] = await readGeoPackage(bytes, 'sites');
    const db = file.gpkg!.db;
    const [row] = rows(db, 'SELECT f_table_name, f_geometry_column, useAsDefault, styleQML FROM layer_styles');
    expect([row.f_table_name, row.f_geometry_column, row.useAsDefault]).toEqual(['sites', 'geom', 1]);
    expect(String(row.styleQML)).toContain('<text-style fieldName="名称"');
    expect(file.styleQml).toBe(row.styleQML);
    // layer_styles is a table of attributes, not of features.
    expect(rows(db, "SELECT data_type FROM gpkg_contents WHERE table_name = 'layer_styles'")).toEqual([{ data_type: 'attributes' }]);
  });
});

describe('zipFiles', () => {
  it('makes a .zip the reader opens', async () => {
    const files = await unzipFiles(zipFiles([{ name: 'フォルダ/a.txt', bytes: new TextEncoder().encode('hello') }]));
    expect(files.map((f) => [f.name, new TextDecoder().decode(f.bytes)])).toEqual([['フォルダ/a.txt', 'hello']]);
  });
});

describe('writeGeoPackage', () => {
  it('writes a table with typed columns and a spatial index, and reads back', async () => {
    const bytes = await writeGeoPackage('sites', features(), fields);
    const [file] = await readGeoPackage(bytes, 'sites');
    expect(file.fields.map((f) => [f.name, f.type])).toEqual([
      ['fid', 'oid'],
      ['OBJECTID', 'integer'],
      ['名称', 'string'],
      ['POP', 'integer'],
      ['AREA', 'double'],
      ['DAY', 'date'],
    ]);
    expect(file.geometryType).toBe('Point');
    const [a] = file.features;
    expect([a.get('名称'), a.get('POP'), a.get('AREA'), a.get('DAY')]).toEqual(['東京', 100, 1.25, Date.UTC(2024, 4, 1)]);
    expect(lonLat(a)[0]).toBeCloseTo(lonLat(features()[0])[0], 2);
    const db = file.gpkg!.db;
    expect(rows(db, 'SELECT type FROM pragma_table_info(?) WHERE name = ?', ['sites', 'DAY'])).toEqual([{ type: 'DATE' }]);
    expect(rows(db, 'SELECT count(*) AS n FROM rtree_sites_geom')).toEqual([{ n: 2 }]);
    // Editing keeps the index right through the triggers.
    db.run('DELETE FROM sites WHERE fid = 1');
    expect(rows(db, 'SELECT count(*) AS n FROM rtree_sites_geom')).toEqual([{ n: 1 }]);
  });
});
