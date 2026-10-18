import { describe, expect, it } from 'vitest';
import { catalogOf } from '../src/catalog.js';
import { addAreas, checkWatch, joinAreas, sinceCondition, watchQuery, type CatalogWatch, type EsriAsk } from '../src/catalog-watch.js';

const catalog = catalogOf(
  { label: 'カタログ', url: 'https://svc/FeatureServer/0', fields: { id: 'IMG_ID', acquired: 'ACQ', registered: 'REG', sensor: 'SENSOR', angle: 'ANGLE', source: 'URL' }, where: "STATUS = 'OK'" },
  [],
  0,
)!;
const created = Date.UTC(2026, 9, 10);
const watch = (over: Partial<CatalogWatch> = {}): CatalogWatch => ({
  id: 'w1',
  name: '東京',
  catalog,
  types: { ACQ: 'esriFieldTypeDate', REG: 'esriFieldTypeDate' },
  conditions: { sensor: 'S1', maxAngle: 20, azimuthFrom: null, azimuthTo: null, where: '' },
  areas: [{ kind: 'points', points: [[139.7, 35.6]] }],
  enabled: true,
  created,
  lastChecked: null,
  seen: [],
  ...over,
});
const feature = (id: string, acq = 0) => ({ attributes: { OBJECTID: id.length, IMG_ID: id, ACQ: acq, SENSOR: 'S1', URL: `https://x/${id}.tif` }, geometry: { rings: [[[0, 0], [0, 1], [1, 1], [0, 0]]] } });
const answering = (ids: string[], calls: Array<Record<string, string>> = []): EsriAsk => async (_url, params) => {
  calls.push(params);
  return { objectIdFieldName: 'OBJECTID', features: ids.map((id, i) => feature(id, i)) };
};

describe('sinceCondition', () => {
  it('writes the time for the field type', () => {
    const t = Date.UTC(2026, 9, 1, 2, 3, 4);
    expect(sinceCondition('F', 'esriFieldTypeDate', t)).toBe("F >= TIMESTAMP '2026-10-01 02:03:04'");
    expect(sinceCondition('F', 'esriFieldTypeDateOnly', t)).toBe("F >= DATE '2026-10-01'");
    expect(sinceCondition('F', 'esriFieldTypeDouble', t)).toBe(`F >= ${t}`);
    expect(sinceCondition('F', 'esriFieldTypeString', t)).toBe("F >= '2026-10-01'");
  });
});

describe('watchQuery', () => {
  it('ANDs the catalog, the conditions and the newness (by registration, 3 days back), over the point', () => {
    const q = watchQuery(watch(), created);
    expect(q.where).toBe("(STATUS = 'OK') AND SENSOR = 'S1' AND ANGLE <= 20 AND REG >= TIMESTAMP '2026-10-07 00:00:00'");
    expect(q.geometryType).toBe('esriGeometryPoint');
    expect(JSON.parse(q.geometry)).toEqual({ x: 139.7, y: 35.6, spatialReference: { wkid: 4326 } });
    expect(q.spatialRel).toBe('esriSpatialRelIntersects');
  });
  it('asks several points as a multipoint, a polygon, or anywhere', () => {
    const many = watchQuery(watch({ areas: [{ kind: 'points', points: [[139.7, 35.6], [135.5, 34.7]] }] }), null);
    expect(many.geometryType).toBe('esriGeometryMultipoint');
    expect(JSON.parse(many.geometry).points).toEqual([[139.7, 35.6], [135.5, 34.7]]);
    expect(watchQuery(watch({ areas: [{ kind: 'polygon', rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }] }), null).geometryType).toBe('esriGeometryPolygon');
    expect(watchQuery(watch({ areas: [] }), null).geometry).toBeUndefined();
  });
});

describe('checkWatch', () => {
  it('first notes what is there, then notices only the new images', async () => {
    const first = await checkWatch(watch(), answering(['A', 'B']), created + 1000);
    expect(first.notices).toEqual([]);
    expect(first.watch.seen).toEqual(['A', 'B']);
    expect(first.watch.lastChecked).toBe(created + 1000);

    const calls: Array<Record<string, string>> = [];
    const second = await checkWatch(first.watch, answering(['A', 'B', 'C', 'D'], calls), created + 2000);
    expect(second.notices.map((n) => n.imageId)).toEqual(['D', 'C']);
    expect(second.notices[0]).toMatchObject({ id: 'w1|D', watchName: '東京', catalogLabel: 'カタログ', read: false, sensor: 'S1' });
    expect(second.watch.seen).toEqual(['A', 'B', 'C', 'D']);
    expect(calls[0].orderByFields).toBe('REG DESC');
  });

  it('keeps the error and the last check when the catalog cannot be asked', async () => {
    const failing: EsriAsk = async () => {
      throw new Error('つながりません');
    };
    const before = watch({ lastChecked: created, seen: ['A'] });
    const result = await checkWatch(before, failing, created + 5000);
    expect(result.notices).toEqual([]);
    expect(result.watch.lastError).toBe('つながりません');
    expect(result.watch.lastChecked).toBe(created);
    expect(result.watch.lastTried).toBe(created + 5000);
    const fixed = await checkWatch(result.watch, answering(['A', 'B']), created + 9000);
    expect(fixed.watch.lastError).toBeUndefined();
    expect(fixed.notices.map((n) => n.imageId)).toEqual(['B']);
  });

  it('asks again plainly when ordering is refused', async () => {
    const calls: Array<Record<string, string>> = [];
    const old: EsriAsk = async (_url, params) => {
      calls.push(params);
      if (params.orderByFields) throw new Error('not supported');
      return { features: [feature('A')] };
    };
    const result = await checkWatch(watch({ lastChecked: created }), old, created + 1);
    expect(calls).toHaveLength(2);
    expect(result.notices.map((n) => n.imageId)).toEqual(['A']);
  });

  it('asks each area (points, then polygons) and notices an image once', async () => {
    const calls: Array<Record<string, string>> = [];
    const areas = joinAreas([{ kind: 'points', points: [[1, 1]] }], [{ kind: 'polygon', rings: [[[0, 0], [0, 2], [2, 2], [0, 0]]] }, { kind: 'points', points: [[2, 2]] }]);
    expect(areas.map((a) => a.kind)).toEqual(['points', 'polygon']);
    const result = await checkWatch(watch({ areas, lastChecked: created, seen: [] }), answering(['A', 'B'], calls), created + 1);
    expect(calls.map((c) => c.geometryType)).toEqual(['esriGeometryMultipoint', 'esriGeometryPolygon']);
    expect(result.notices.map((n) => n.imageId).sort()).toEqual(['A', 'B']);
  });

  it('adds a point to a watch, noting the images already there', async () => {
    const before = watch({ lastChecked: created, seen: ['A'] });
    const after = await addAreas(before, [{ kind: 'points', points: [[135.5, 34.7]] }], answering(['A', 'X']), created + 1);
    expect(after.areas).toEqual([{ kind: 'points', points: [[139.7, 35.6], [135.5, 34.7]] }]);
    expect(after.seen).toEqual(['A', 'X']);
    expect(after.lastChecked).toBe(created);
    const next = await checkWatch(after, answering(['A', 'X', 'Y']), created + 2);
    expect(next.notices.map((n) => n.imageId)).toEqual(['Y']);
  });
});

describe('areasOf', () => {
  it('joins points into one set and polygons into one polygon, outer rings clockwise', async () => {
    const { areasOf } = await import('../src/watch-areas.js');
    const { LineString, Point, Polygon } = await import('ol/geom.js');
    const square = new Polygon([[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]); // anticlockwise
    const areas = areasOf([new Point([139.7, 35.6]), square, new Point([135.5, 34.7]), new LineString([[2, 2], [3, 4]])], 'EPSG:4326');
    expect(areas[0]).toEqual({ kind: 'points', points: [[139.7, 35.6], [135.5, 34.7]] });
    expect(areas[1].kind).toBe('polygon');
    const rings = (areas[1] as { rings: number[][][] }).rings;
    expect(rings).toHaveLength(2);
    // Shoelace: clockwise rings have a negative signed area.
    const signed = (r: number[][]) => r.slice(1).reduce((sum, [x, y], i) => sum + (r[i][0] * y - x * r[i][1]), 0);
    expect(rings.every((r) => signed(r) < 0)).toBe(true);
  });
});
