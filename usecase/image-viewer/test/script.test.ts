import { describe, expect, it } from 'vitest';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import { fromLonLat } from 'ol/proj.js';
import { cleanProperties, featuresCsv, fileName, inferFields, readFeatures, readFields, writeFeatures } from '../src/script/convert.js';
import { suggestionsAt } from '../src/script/suggest.js';
import { workerSource } from '../src/script/sandbox.js';

describe('what crosses between a script and the viewer', () => {
  it('keeps only plain attribute values', () => {
    expect(cleanProperties({ a: 1, b: 'x', c: null, d: new Date(0), e: { f: 1 }, g: NaN, geometry: 1, ['__proto__']: 1 })).toEqual({ a: 1, b: 'x', c: null, d: 0, e: '{"f":1}', g: null });
    expect(() => cleanProperties([1])).toThrow('オブジェクト');
  });

  it('reads GeoJSON in longitude / latitude into the map projection and back', () => {
    const [item] = readFeatures({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [139.7, 35.7] }, properties: { n: 1 } }] }, 'EPSG:3857');
    const xy = (item.geometry as Point).getCoordinates();
    expect(xy[0]).toBeCloseTo(fromLonLat([139.7, 35.7])[0], 6);
    const f = new Feature({ geometry: item.geometry!, n: 1 });
    const fc = writeFeatures([f], 'EPSG:3857');
    expect(fc.features[0].id).toMatch(/^f\d+$/);
    expect((fc.features[0].geometry as { coordinates: number[] }).coordinates[0]).toBeCloseTo(139.7, 9);
    expect(writeFeatures([f], 'EPSG:3857').features[0].id).toBe(fc.features[0].id);
  });

  it('refuses what is not GeoJSON, saying which feature', () => {
    expect(() => readFeatures([{ type: 'Feature', geometry: { type: 'Point', coordinates: ['a', 1] }, properties: {} }], 'EPSG:3857')).toThrow('1 件目');
    expect(() => readFeatures([{ type: 'Feature', geometry: { type: 'Circle' } }], 'EPSG:3857')).toThrow('GeoJSON のジオメトリ');
  });

  it('infers and checks fields', () => {
    const fields = inferFields([new Feature({ a: 1, b: 1.5, c: 'x' }), new Feature({ a: 2, b: 2, c: null })]);
    expect(fields.map((f) => [f.name, f.type])).toEqual([['a', 'integer'], ['b', 'double'], ['c', 'string']]);
    expect(readFields(['x', { name: 'y', type: 'double' }]).map((f) => f.type)).toEqual(['string', 'double']);
    expect(() => readFields([{ name: 'z', type: 'blob' }])).toThrow('type');
  });

  it('writes CSV with longitude / latitude for points, WKT otherwise, formulas defused', () => {
    const point = new Feature({ geometry: new Point(fromLonLat([139.7, 35.7])), name: '=cmd' });
    const csv = featuresCsv([point], [{ name: 'name', alias: 'name', type: 'string', editable: true, nullable: true }], 'EPSG:3857');
    expect(csv.startsWith('﻿name,経度,緯度\r\n\'=cmd,139.7')).toBe(true);
    const square = new Feature({ geometry: new Polygon([[fromLonLat([0, 0]), fromLonLat([1, 0]), fromLonLat([1, 1]), fromLonLat([0, 0])]]) });
    expect(featuresCsv([square], [], 'EPSG:3857')).toContain('POLYGON((0 0');
  });

  it('makes safe file names', () => {
    expect(fileName('../a/b:c.csv', 'x', ['csv'])).toBe('b_c.csv');
    expect(fileName('run.exe', 'x', ['csv', 'txt'])).toBe('run.exe.csv');
    expect(fileName(undefined, 'layer', ['geojson'])).toBe('layer.geojson');
  });
});

describe('suggestions', () => {
  it('offers the functions of viewer. and geo.', () => {
    const r = suggestionsAt('await viewer.fea', 16, []);
    expect(r?.from).toBe(13);
    expect(r?.items[0]).toMatchObject({ insert: 'features(' });
    expect(suggestionsAt('geo.', 4, [])!.items.every((i) => i.label.startsWith('geo.'))).toBe(true);
  });

  it('offers layer names inside the quotes of a call', () => {
    const text = "viewer.features('pa";
    expect(suggestionsAt(text, text.length, ['parcels', 'roads', "it's"])!.items.map((i) => i.insert)).toEqual(['parcels']);
    const t2 = "viewer.features('";
    expect(suggestionsAt(t2, t2.length, ["it's"])!.items[0].insert).toBe("it\\'s");
  });

  it('stays quiet in comments, strings and short words', () => {
    expect(suggestionsAt('// viewer.fe', 12, [])).toBeNull();
    expect(suggestionsAt("print('viewer.fe", 16, [])).toBeNull();
    expect(suggestionsAt('p', 1, [])).toBeNull();
    expect(suggestionsAt('p', 1, [], true)?.items.some((i) => i.insert === 'print(')).toBe(true);
  });
});

describe('the worker source', () => {
  it('puts the script after the runtime, with the line offset it reports from', () => {
    const { source, offset } = workerSource('print(1)', ['layers'], ['area']);
    expect(source.split('\n')[offset]).toBe('print(1)');
    expect(source).toContain(`const USER_LINE_OFFSET = ${offset};`);
    expect(source).toContain('const VIEWER_METHODS = ["layers"]');
  });
});
