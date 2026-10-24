import { describe, expect, it } from 'vitest';
import type Point from 'ol/geom/Point.js';
import type Polygon from 'ol/geom/Polygon.js';
import type LineString from 'ol/geom/LineString.js';
import { toLonLat } from 'ol/proj.js';
import { MAX_SHAPES, hasShapes, linkOfShapes, paramsOfLink, readLinkShapes, shapeParamsOf, withoutShapes } from '../src/link-shapes.js';

const read = (query: string) => readLinkShapes(new URLSearchParams(query));
const lonLat = (c: number[]) => toLonLat(c).map((v) => Math.round(v * 1e6) / 1e6);

describe('shapes in a link', () => {
  it('reads points in any coordinate notation, labeled in order', () => {
    const shapes = read(`geom=${encodeURIComponent('35.6812,139.7671')}&label=東京駅&geom=${encodeURIComponent('54SUE8843349290')}&geom=${encodeURIComponent('北緯34度42分 東経135度30分')}&label=&name=現場`);
    expect(shapes.errors).toEqual([]);
    expect(shapes.title).toBe('現場');
    expect(shapes.features).toHaveLength(3);
    expect(lonLat((shapes.features[0].getGeometry() as Point).getCoordinates())).toEqual([139.7671, 35.6812]);
    expect(shapes.features[0].get('label')).toBe('東京駅');
    expect(shapes.features[1].get('label')).toBeUndefined();
    const [lon, lat] = lonLat((shapes.features[2].getGeometry() as Point).getCoordinates());
    expect(lon).toBeCloseTo(135.5, 5);
    expect(lat).toBeCloseTo(34.7, 5);
    expect(shapes.labeled).toBe(true);
  });

  it('reads several points, lines and closed polygons from `;`-separated coordinates', () => {
    const shapes = read('geom=35,139;36,140&line=35,139;35.1,139.1;35.2,139&polygon=35,139;35,139.1;35.1,139.1');
    expect(shapes.errors).toEqual([]);
    expect(shapes.features.map((f) => f.getGeometry()!.getType())).toEqual(['MultiPoint', 'LineString', 'Polygon']);
    const ring = (shapes.features[2].getGeometry() as Polygon).getCoordinates()[0];
    expect(ring).toHaveLength(4);
    expect(ring[0]).toEqual(ring[3]);
    expect((shapes.features[1].getGeometry() as LineString).getCoordinates()).toHaveLength(3);
  });

  it('reads WKT (longitude first) and EWKT in Web Mercator', () => {
    const shapes = read(`geom=${encodeURIComponent('POLYGON((139.7 35.6, 139.8 35.6, 139.8 35.7, 139.7 35.6))')}&geom=${encodeURIComponent('SRID=3857;POINT(15558338 4256426)')}&geom=${encodeURIComponent('MULTILINESTRING((139 35, 140 36),(141 37, 142 38))')}`);
    expect(shapes.errors).toEqual([]);
    expect(shapes.features.map((f) => f.getGeometry()!.getType())).toEqual(['Polygon', 'Point', 'MultiLineString']);
    expect(lonLat((shapes.features[0].getGeometry() as Polygon).getCoordinates()[0][1])).toEqual([139.8, 35.6]);
    expect((shapes.features[1].getGeometry() as Point).getCoordinates()).toEqual([15558338, 4256426]);
  });

  it('reads GeoJSON with its plain properties as attributes and its name as the label', () => {
    const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'A', height: 12.5, '<b>': 'x', nested: { a: 1 } }, geometry: { type: 'Point', coordinates: [139, 35] } }] };
    const shapes = read(`geojson=${encodeURIComponent(JSON.stringify(fc))}`);
    expect(shapes.errors).toEqual([]);
    expect(shapes.features[0].get('label')).toBe('A');
    expect(shapes.features[0].get('height')).toBe(12.5);
    expect(shapes.features[0].get('<b>')).toBeUndefined();
    expect(shapes.features[0].get('nested')).toBeUndefined();
    expect(shapes.fields.map((f) => f.name)).toEqual(['label', 'name', 'height']);
  });

  it('says what it could not read and keeps the rest', () => {
    const shapes = read(`geom=nowhere&geom=${encodeURIComponent('POINT(200 35)')}&geom=${encodeURIComponent('SRID=2451;POINT(0 0)')}&geom=${encodeURIComponent('POINT(1 2); alert(1)<script>')}&line=35,139&geojson={&geom=35,139&label=a&label=b&label=c&label=d&label=e&label=f&label=ok`);
    expect(shapes.features).toHaveLength(1);
    expect(shapes.features[0].get('label')).toBe('ok');
    expect(shapes.errors).toHaveLength(6);
    expect(shapes.errors.join('\n')).toMatch(/座標として読み込み不可[\s\S]*範囲外[\s\S]*SRID=2451[\s\S]*使用不可の文字[\s\S]*2 点以上[\s\S]*JSON/);
  });

  it('limits the number of shapes, the length of values and cleans names', () => {
    const many = Array.from({ length: MAX_SHAPES + 5 }, () => 'geom=35,139').join('&');
    const shapes = read(`${many}&name=${encodeURIComponent('a‮b\nc')}&color=f00&zoom=30`);
    expect(shapes.features).toHaveLength(MAX_SHAPES);
    expect(shapes.errors.at(-1)).toMatch(/多すぎ/);
    expect(shapes.title).toBe('a b c');
    expect(shapes.color).toBe('#ff0000');
    expect(shapes.zoom).toBeNull();
    expect(read(`geom=${'1'.repeat(200_001)}`).errors[0]).toMatch(/長すぎ/);
    expect(read('geom=35,139&color=red;x&zoom=12').color).toBeNull();
    expect(read('geom=35,139&zoom=12').zoom).toBe(12);
  });

  it('takes only the shape parameters of a web+imageviewer: link', () => {
    expect([...paramsOfLink('web+imageviewer:geom=35,139&url=https://evil/x.tif&label=a')]).toEqual([['geom', '35,139'], ['label', 'a']]);
    expect([...paramsOfLink('web+imageviewer://show?polygon=1,2;3,4;5,6#x')]).toEqual([['polygon', '1,2;3,4;5,6']]);
    expect([...paramsOfLink('https://example.com/?geom=1,2')]).toEqual([]);
    const params = shapeParamsOf(`?service=x&link=${encodeURIComponent('web+imageviewer:?geom=35,139')}`);
    expect(hasShapes(params)).toBe(true);
    expect([...params]).toEqual([['geom', '35,139']]);
    expect(withoutShapes('?service=x&geom=1,2&label=a&link=web%2Bimageviewer%3Ageom%3D1')).toBe('?service=x');
  });

  it('makes a link that reads back as the same shapes', () => {
    const shapes = read(`polygon=35,139;35,139.1;35.1,139.1&label=区域&geom=35.5,139.5`);
    shapes.features.forEach((f, i) => f.set('title', i ? '' : '区域'));
    const link = linkOfShapes('https://viewer.example/app/?service=s&geom=old#view=1,2,3', shapes.features, { name: '共有', labelField: 'title' })!;
    const url = new URL(link);
    expect(url.searchParams.get('service')).toBe('s');
    expect(url.searchParams.getAll('label')).toEqual(['区域']);
    const back = readLinkShapes(shapeParamsOf(url.search));
    expect(back.title).toBe('共有');
    expect(back.features.map((f) => f.getGeometry()!.getType())).toEqual(['Polygon', 'Point']);
    expect(back.features[0].get('label')).toBe('区域');
    expect(lonLat((back.features[1].getGeometry() as Point).getCoordinates())).toEqual([139.5, 35.5]);
    expect(linkOfShapes('https://viewer.example/', shapes.features, {}, 50)).toBeNull();
  });
});
