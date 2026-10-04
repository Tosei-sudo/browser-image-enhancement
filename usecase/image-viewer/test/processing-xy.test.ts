import { describe, expect, it } from 'vitest';
import Feature from 'ol/Feature.js';
import type Point from 'ol/geom/Point.js';
import { toLonLat } from 'ol/proj.js';
import { coordinateValue, xyToPoints } from '../src/processing/xy-to-points.js';
import { registerJapaneseCrs, targetCrs } from '../src/processing/reproject.js';
import { wgs84 } from '../src/vector-write.js';
import type { Field } from '../src/services/index.js';

registerJapaneseCrs();

const fields: Field[] = ['name', 'x', 'y'].map((name) => ({ name, alias: name, type: 'string', editable: false, nullable: true }));
const rows = (values: Array<[string, unknown, unknown]>) => values.map(([name, x, y]) => new Feature({ name, x, y }));

describe('coordinateValue', () => {
  it('reads numbers and numeric text, full-width too', () => {
    expect(coordinateValue(139.5)).toBe(139.5);
    expect(coordinateValue(' 35.68 ')).toBe(35.68);
    expect(coordinateValue('１３９．７')).toBe(139.7);
    expect(coordinateValue('-12,345.5')).toBe(-12345.5);
    expect(coordinateValue('abc')).toBeNull();
    expect(coordinateValue(null)).toBeNull();
  });
});

describe('xyToPoints', () => {
  it('makes points from longitude / latitude with the attributes, skipping bad rows', () => {
    const result = xyToPoints(
      { title: 'stations', fields, features: rows([['東京', '139.767125', '35.681236'], ['空', '', '35'], ['逆', '35.68', '139.76']]) },
      { xField: 'x', yField: 'y', crs: wgs84 },
    );
    expect(result.title).toBe('stations_ポイント');
    expect(result.features).toHaveLength(1);
    const [lon, lat] = toLonLat((result.features[0].getGeometry() as Point).getCoordinates());
    expect(lon).toBeCloseTo(139.767125, 9);
    expect(lat).toBeCloseTo(35.681236, 9);
    expect(result.features[0].get('name')).toBe('東京');
    expect(result.notes!.join()).toContain('数値でない行 1 件');
    expect(result.notes!.join()).toContain('X と Y が逆かもしれません');
  });

  it('reads plane rectangular coordinates (zone IX) and keeps the CRS for export', async () => {
    const crs = await targetCrs('EPSG:6677');
    // Tokyo Station: X (north) −35363.2 m, Y (east) −5992.9 m; X here is east.
    const result = xyToPoints({ title: 't', fields, features: rows([['東京', -5992.9, -35363.2]]) }, { xField: 'x', yField: 'y', crs });
    const [lon, lat] = toLonLat((result.features[0].getGeometry() as Point).getCoordinates());
    expect(lon).toBeCloseTo(139.767125, 4);
    expect(lat).toBeCloseTo(35.681236, 4);
    expect(result.crs).toBe(crs);
  });
});
