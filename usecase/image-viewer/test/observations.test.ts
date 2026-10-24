import { describe, expect, it } from 'vitest';
import {
  carriedInto,
  carryOvers,
  EsriObservationStore,
  flows,
  nextName,
  observationsCsv,
  observationStoreOf,
  vocabularyOf,
  type Observation,
} from '../src/observations.js';

const day = (d: number) => Date.UTC(2026, 9, d, 1);
let n = 0;
const obs = (o: Partial<Observation>): Observation => ({
  id: `o${++n}`,
  imageId: 'img',
  imageName: 'img.tif',
  imageTime: day(1),
  objectId: 'A',
  objectName: '船舶-1',
  kind: '船舶',
  activity: '停泊',
  present: true,
  note: '',
  lon: 139.7,
  lat: 35.6,
  createdAt: day(20),
  updatedAt: day(20),
  deletedAt: null,
  ...o,
});

describe('flows', () => {
  it('orders a thing by image time, not by when it was recorded, and splits it where it changed', () => {
    // Recorded newest first: the flow is still in image-time order.
    const records = [
      obs({ imageId: 'd5', imageTime: day(5), createdAt: day(20), activity: '航行', lon: 139.8 }),
      obs({ imageId: 'd1', imageTime: day(1), createdAt: day(21) }),
      obs({ imageId: 'd3', imageTime: day(3), createdAt: day(22) }),
      obs({ imageId: 'd7', imageTime: day(7), createdAt: day(23), present: false, activity: '' }),
      obs({ imageId: 'd2', imageTime: day(2), createdAt: day(24), deletedAt: day(25) }),
    ];
    const [flow] = flows(records);
    expect(flow.observations.map((o) => o.imageId)).toEqual(['d1', 'd3', 'd5', 'd7']);
    expect(flow.first).toBe(day(1));
    expect(flow.last).toBe(day(7));
    expect(flow.seen).toBe(3);
    expect(flow.present).toBe(false);
    expect(flow.steps.map((s) => [s.activity, s.present, s.count])).toEqual([
      ['停泊', true, 2],
      ['航行', true, 1],
      ['', false, 1],
    ]);
    // 0.1° of longitude at 35.6°N is about 9 km.
    expect(flow.steps[1].moved).toBeGreaterThan(8000);
    expect(flow.distance).toBeGreaterThan(8000);
  });

  it('starts a new step where a thing moved, even doing the same', () => {
    const [flow] = flows([obs({ imageTime: day(1), imageId: 'a' }), obs({ imageTime: day(2), imageId: 'b', lon: 139.71 })]);
    expect(flow.steps).toHaveLength(2);
  });
});

describe('carryOvers', () => {
  const records = [
    obs({ objectId: 'A', objectName: 'A', imageId: 'd1', imageTime: day(1) }),
    obs({ objectId: 'A', objectName: 'A', imageId: 'd3', imageTime: day(3), activity: '航行' }),
    obs({ objectId: 'B', objectName: 'B', imageId: 'd1', imageTime: day(1) }),
    obs({ objectId: 'B', objectName: 'B', imageId: 'd2', imageTime: day(2), present: false }),
    obs({ objectId: 'C', objectName: 'C', imageId: 'd9', imageTime: day(9), lon: 140.5 }),
  ];

  it('offers each thing by its nearest earlier record, else a later one, unless it had gone', () => {
    const at4 = carryOvers(records, { id: 'd4', time: day(4) });
    expect(at4.map((c) => [c.from.objectId, c.side, c.from.activity])).toEqual([
      ['A', 'before', '航行'],
      ['C', 'after', '停泊'],
    ]);
    // An image between: A's day-1 record, and B still there then.
    const at1half = carryOvers(records, { id: 'x', time: day(1) + 3600000 });
    expect(at1half.map((c) => c.from.objectId)).toEqual(['A', 'B', 'C']);
  });

  it('leaves out what is already recorded in the image, and what is outside it', () => {
    expect(carryOvers(records, { id: 'd3', time: day(3) }).map((c) => c.from.objectId)).toEqual(['C']);
    expect(carryOvers(records, { id: 'd4', time: day(4) }, (lon) => lon < 140).map((c) => c.from.objectId)).toEqual(['A']);
  });

  it('copies a carried thing into an image with fresh ids and times', () => {
    const copy = carriedInto(records[1], { id: 'd4', name: 'd4.tif', time: day(4) }, day(30));
    expect(copy).toMatchObject({ objectId: 'A', imageId: 'd4', imageName: 'd4.tif', imageTime: day(4), createdAt: day(30), updatedAt: day(30), deletedAt: null, activity: '航行' });
    expect(copy.id).not.toBe(records[1].id);
  });
});

describe('names, CSV and config', () => {
  it('numbers new things by kind', () => {
    expect(nextName('船舶', ['船舶-1', '船舶-3', '車両-9'])).toBe('船舶-4');
    expect(nextName('', [])).toBe('モノ-1');
  });

  it('writes CSV with a BOM, quoted where needed', () => {
    const csv = observationsCsv([obs({ note: 'a, "b"' })]);
    expect(csv.startsWith('\ufeff観測ID,モノID,モノ')).toBe(true);
    expect(csv).toContain('"a, ""b"""');
  });

  it('reads observationStores and the vocabulary', () => {
    const problems: string[] = [];
    const store = observationStoreOf({ label: '観測', url: 'https://x/FeatureServer/2', fields: { kind: 'TYPE', bogus: 'X' }, softDelete: false, activities: ['入港', ''] }, problems, 0)!;
    expect(store.fields.kind).toBe('TYPE');
    expect(store.fields.id).toBe('OBS_ID');
    expect(store.softDelete).toBe(false);
    expect(store.activities).toEqual(['入港']);
    expect(problems).toEqual(['observationStores[0] の fields.bogus は使用不可の役割']);
    expect(observationStoreOf({ url: 'https://x/MapServer/2' }, problems, 1)).toBeNull();
    expect(vocabularyOf({ kinds: ['艦艇'] }, problems).kinds).toEqual(['艦艇']);
  });
});

describe('EsriObservationStore', () => {
  /** A point layer in memory. */
  function fakeLayer(fieldNames: string[], types: Record<string, string> = {}) {
    const rows: Array<{ attributes: Record<string, unknown>; geometry: { x: number; y: number } }> = [];
    let next = 1;
    const asked: string[] = [];
    const ask = async (url: string, params: Record<string, string>) => {
      asked.push(url.replace('https://x/FeatureServer/0', ''));
      if (url.endsWith('/0')) return { objectIdField: 'OBJECTID', fields: ['OBJECTID', ...fieldNames].map((name) => ({ name, type: name === 'OBJECTID' ? 'esriFieldTypeOID' : (types[name] ?? 'esriFieldTypeString') })) };
      if (url.endsWith('/applyEdits')) {
        const adds = JSON.parse(params.adds) as typeof rows;
        const updates = JSON.parse(params.updates) as typeof rows;
        const addResults = adds.map((f) => {
          const objectId = next++;
          rows.push({ ...f, attributes: { ...f.attributes, OBJECTID: objectId } });
          return { success: true, objectId };
        });
        for (const u of updates) Object.assign(rows.find((r) => r.attributes.OBJECTID === u.attributes.OBJECTID)!, { attributes: { ...u.attributes }, geometry: u.geometry });
        return { addResults, updateResults: updates.map(() => ({ success: true })) };
      }
      if (url.endsWith('/deleteFeatures')) {
        const ids = params.objectIds.split(',').map(Number);
        rows.splice(0, rows.length, ...rows.filter((r) => !ids.includes(r.attributes.OBJECTID as number)));
        return { deleteResults: [] };
      }
      if (url.endsWith('/query')) return { features: rows.map((r) => ({ attributes: { ...r.attributes }, geometry: { ...r.geometry } })) };
      throw new Error(url);
    };
    return { rows, ask, asked };
  }
  const all = ['OBS_ID', 'IMAGE_ID', 'IMAGE_NAME', 'IMAGE_TIME', 'OBJECT_ID', 'OBJECT_NAME', 'KIND', 'ACTIVITY', 'PRESENT', 'NOTE', 'CREATED_AT', 'UPDATED_AT', 'DELETED_AT'];
  const dates = { IMAGE_TIME: 'esriFieldTypeDate', CREATED_AT: 'esriFieldTypeDate', UPDATED_AT: 'esriFieldTypeDate', DELETED_AT: 'esriFieldTypeDate', PRESENT: 'esriFieldTypeSmallInteger' };

  it('adds, updates (by object id), reads back and marks deleted records', async () => {
    const layer = fakeLayer(all, dates);
    const config = observationStoreOf({ url: 'https://x/FeatureServer/0' }, [], 0)!;
    const store = new EsriObservationStore(config, layer.ask);
    const a = obs({ id: 'r1', present: false, note: '見当たらない' });
    await store.save([a]);
    expect(layer.rows[0].attributes).toMatchObject({ OBS_ID: 'r1', PRESENT: 0, IMAGE_TIME: day(1), OBJECTID: 1 });
    expect(layer.rows[0].geometry).toMatchObject({ x: 139.7, y: 35.6 });
    await store.save([{ ...a, note: '直した', lon: 139.75 }]);
    expect(layer.rows).toHaveLength(1);
    expect(layer.rows[0].attributes.NOTE).toBe('直した');
    // A new store (another person) reads it back, and can update it.
    const other = new EsriObservationStore(config, layer.ask);
    const [read] = await other.load();
    expect(read).toMatchObject({ id: 'r1', present: false, note: '直した', lon: 139.75, imageTime: day(1), deletedAt: null });
    const [marked] = await other.remove([read], day(30));
    expect(marked.deletedAt).toBe(day(30));
    expect(layer.rows).toHaveLength(1);
    expect(layer.rows[0].attributes.DELETED_AT).toBe(day(30));
  });

  it('writes only the fields the layer has, and deletes features when it cannot mark them', async () => {
    const layer = fakeLayer(['OBS_ID', 'OBJECT_ID', 'ACTIVITY', 'IMAGE_TIME']);
    const store = new EsriObservationStore(observationStoreOf({ url: 'https://x/FeatureServer/0' }, [], 0)!, layer.ask);
    const a = obs({ id: 'r2' });
    await store.save([a]);
    expect(Object.keys(layer.rows[0].attributes).sort()).toEqual(['ACTIVITY', 'IMAGE_TIME', 'OBJECTID', 'OBJECT_ID', 'OBS_ID']);
    // A date in a text field is written as ISO text, and read back.
    expect(layer.rows[0].attributes.IMAGE_TIME).toBe(new Date(day(1)).toISOString());
    expect((await store.load())[0].imageTime).toBe(day(1));
    expect(await store.remove([a])).toEqual([]);
    expect(layer.rows).toHaveLength(0);
  });

  it('says which required field is missing', async () => {
    const layer = fakeLayer(['OBS_ID']);
    const store = new EsriObservationStore(observationStoreOf({ label: '観測', url: 'https://x/FeatureServer/0' }, [], 0)!, layer.ask);
    await expect(store.load()).rejects.toThrow('観測 に属性 OBJECT_ID なし');
  });
});
