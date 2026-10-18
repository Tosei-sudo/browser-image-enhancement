import { describe, expect, it } from 'vitest';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import { fromLonLat, toLonLat } from 'ol/proj.js';
import { MAX_VALUE } from '../src/link-shapes.js';
import { featuresToGeoJson, featuresToWkt, readPastedText, tableShapes, type Pasted, type PastedShapes, type PastedTable } from '../src/paste.js';
import { webMercator } from '../src/vector-write.js';
import { isShareId, safeFileName } from '../src/share-target.js';

const lonLat = (c: number[]) => toLonLat(c).map((v) => Math.round(v * 1e6) / 1e6);
function shapes(p: Pasted): PastedShapes {
  if (p.kind !== 'shapes') throw new Error(`not shapes: ${JSON.stringify(p)}`);
  return p;
}
function table(p: Pasted): PastedTable {
  if (p.kind !== 'table') throw new Error(`not a table: ${JSON.stringify(p)}`);
  return p;
}

describe('pasted text', () => {
  it('reads GeoJSON features with their properties', () => {
    const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: '東京駅', n: 3 }, geometry: { type: 'Point', coordinates: [139.7671, 35.6812] } }] };
    const s = shapes(readPastedText(JSON.stringify(fc, null, 2)));
    expect(s.what).toBe('GeoJSON');
    expect(s.features).toHaveLength(1);
    expect(s.features[0].get('n')).toBe(3);
    expect(s.features[0].get('label')).toBe('東京駅');
    expect(lonLat((s.features[0].getGeometry() as Point).getCoordinates())).toEqual([139.7671, 35.6812]);
    // A bare geometry too.
    expect(shapes(readPastedText('{"type":"LineString","coordinates":[[139,35],[140,36]]}')).features[0].getGeometry()!.getType()).toBe('LineString');
  });

  it('says what is wrong with JSON that is not GeoJSON', () => {
    expect(readPastedText('{"a":1}')).toMatchObject({ kind: 'none', message: expect.stringContaining('GeoJSON ではない') });
    expect(readPastedText('{oops')).toMatchObject({ kind: 'none', message: expect.stringContaining('JSON') });
  });

  it('reads WKT one per line, EWKT, and one geometry over several lines', () => {
    const s = shapes(readPastedText('POINT(139.7 35.6)\nSRID=3857;POINT(15558338 4256426)\nLINESTRING(139 35, 140 36)'));
    expect(s.what).toBe('WKT');
    expect(s.features.map((f) => f.getGeometry()!.getType())).toEqual(['Point', 'Point', 'LineString']);
    const multi = shapes(readPastedText('POLYGON((\n139.7 35.6,\n139.8 35.6,\n139.8 35.7,\n139.7 35.6\n))'));
    expect(multi.features).toHaveLength(1);
    expect(multi.features[0].getGeometry()!.getType()).toBe('Polygon');
  });

  it('reads coordinates in any notation, one point per line', () => {
    const s = shapes(readPastedText('35.6812, 139.7671\n54SUE8843349290\n北緯34度42分 東経135度30分\n35.0\t139.0'));
    expect(s.what).toBe('座標');
    expect(s.features).toHaveLength(4);
    expect(s.features.every((f) => f.getGeometry()!.getType() === 'Point')).toBe(true);
    expect(lonLat((s.features[3].getGeometry() as Point).getCoordinates())).toEqual([139, 35]);
  });

  it('reads a tab-separated table from Excel with latitude and longitude columns', () => {
    const t = table(readPastedText('名前\t緯度\t経度\n東京駅\t35.6812\t139.7671\n大阪駅\t34.7025\t135.4959\n不明\t\t\n'));
    expect(t.geographic).toBe(true);
    expect([t.x, t.y]).toEqual(['経度', '緯度']);
    const s = shapes(tableShapes(t));
    expect(s.features).toHaveLength(2);
    expect(s.features[1].get('名前')).toBe('大阪駅');
    expect(lonLat((s.features[0].getGeometry() as Point).getCoordinates())).toEqual([139.7671, 35.6812]);
    expect(s.errors.join()).toContain('1 件を飛ばしました');
    // English names, CSV.
    const csv = table(readPastedText('id,lon,lat\n1,139,35\n'));
    expect([csv.x, csv.y, csv.geographic]).toEqual(['lon', 'lat', true]);
  });

  it('asks the CRS of X / Y columns, suggesting WGS 84 only for degrees', () => {
    const t = table(readPastedText('X\tY\n-5000\t-30000\n-5100\t-30100'));
    expect(t.geographic).toBe(false);
    expect(t.suggested).toBeNull();
    const s = shapes(tableShapes(t, webMercator));
    expect(s.features).toHaveLength(2);
    expect((s.features[0].getGeometry() as Point).getCoordinates()).toEqual([-5000, -30000]);
    expect(table(readPastedText('x,y\n139,35')).suggested).toBe('EPSG:4326');
  });

  it('reads a table with a WKT column, keeping the other columns', () => {
    const s = shapes(readPastedText('id\tWKT\n1\tPOINT(139 35)\n2\tPOLYGON((139 35, 140 35, 140 36, 139 35))\n3\tnot wkt'));
    expect(s.features).toHaveLength(2);
    expect(s.features[1].get('id')).toBe(2);
    expect(s.features[1].get('WKT')).toBeUndefined();
    expect(s.fields.map((f) => f.name)).toEqual(['id']);
    expect(s.errors.join()).toContain('1 件');
  });

  it('reads viewer links with shapes, and leaves other URLs to be asked', () => {
    const s = shapes(readPastedText(`https://example.com/viewer/?geom=${encodeURIComponent('35.68,139.76')}&label=a`));
    expect(s.what).toBe('リンクの図形');
    expect(s.features[0].get('label')).toBe('a');
    expect(shapes(readPastedText('web+imageviewer:geom=35,139')).features).toHaveLength(1);
    expect(readPastedText('https://example.com/image.tif')).toEqual({ kind: 'url', url: 'https://example.com/image.tif' });
    // Not something to open.
    expect(readPastedText('javascript:alert(1)').kind).toBe('none');
  });

  it('keeps to the limits of shapes in a link', () => {
    expect(readPastedText('x'.repeat(MAX_VALUE + 1))).toMatchObject({ kind: 'none', message: expect.stringContaining('長すぎます') });
    const many = Array.from({ length: 1500 }, (_, i) => `POINT(${(i % 360) - 180} 0)`).join('\n');
    const s = shapes(readPastedText(many));
    expect(s.features).toHaveLength(1000);
    expect(s.errors.join()).toContain('1,000 個まで');
    expect(readPastedText('').kind).toBe('none');
    expect(readPastedText('hello world').kind).toBe('none');
  });
});

describe('copied features', () => {
  const point = new Feature({ geometry: new Point(fromLonLat([139.76712345678, 35.68123456789])), name: '東京駅', when: new Date(Date.UTC(2024, 0, 2)), bad: NaN, nested: { a: 1 } });
  const polygon = new Feature({ geometry: new Polygon([[fromLonLat([139, 35]), fromLonLat([140, 35]), fromLonLat([140, 36]), fromLonLat([139, 35])]]), name: '区域' });

  it('writes GeoJSON in WGS 84 with 7 decimals and plain attributes', () => {
    const out = featuresToGeoJson([point, polygon]);
    if ('error' in out) throw new Error(out.error);
    const fc = JSON.parse(out.text);
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features[0].geometry.coordinates).toEqual([139.7671235, 35.6812346]);
    expect(fc.features[0].properties).toEqual({ name: '東京駅', when: '2024-01-02T00:00:00.000Z', bad: null });
    expect(fc.features[1].geometry.type).toBe('Polygon');
    // Pasted back, the same shapes.
    const back = shapes(readPastedText(out.text));
    expect(back.features).toHaveLength(2);
    expect(back.features[1].get('name')).toBe('区域');
  });

  it('keeps the order of the given fields', () => {
    const out = featuresToGeoJson([point], [{ name: 'name', alias: 'name', type: 'string', editable: true, nullable: true }]);
    if ('error' in out) throw new Error(out.error);
    expect(JSON.parse(out.text).features[0].properties).toEqual({ name: '東京駅' });
  });

  it('writes WKT one geometry per line, read back as pasted', () => {
    const out = featuresToWkt([point, new Feature(), polygon]);
    if ('error' in out) throw new Error(out.error);
    expect(out.count).toBe(2);
    expect(out.text.split('\n')[0]).toBe('POINT(139.7671235 35.6812346)');
    expect(shapes(readPastedText(out.text)).features.map((f) => f.getGeometry()!.getType())).toEqual(['Point', 'Polygon']);
    expect(featuresToWkt([new Feature()])).toEqual({ error: expect.any(String) });
  });
});

describe('shared to the app', () => {
  it('takes only the ids the service worker gives', () => {
    expect(isShareId('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(true);
    expect(isShareId('../../config.json')).toBe(false);
    expect(isShareId(null)).toBe(false);
  });

  it('names files without folders or control characters', () => {
    expect(safeFileName('C:\\x\\..\\a.tif', 0)).toBe('a.tif');
    expect(safeFileName('dir/b\u0000.kml', 0)).toBe('b.kml');
    expect(safeFileName('..', 1)).toBe('共有されたファイル2');
    expect(safeFileName(3, 0)).toBe('共有されたファイル1');
  });
});
