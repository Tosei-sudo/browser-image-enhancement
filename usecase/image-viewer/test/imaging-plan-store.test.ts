import { describe, expect, it } from 'vitest';
import { addShots, betweenCondition, defaultPlanFields, deletePlan, listPlans, loadShots, planStoreOf, progressText, shotFeatures, trackShots, updateShots } from '../src/imaging-plan-store.js';
import { satellitesFromText, type Opportunity, type PlanTarget } from '../src/imaging-plan.js';
import { catalogOf } from '../src/catalog.js';
import { parseConfig } from '../src/config.js';
import { fakeEsri } from './plan-store-fake.js';

const planUrl = 'https://gis.example/arcgis/rest/services/Plans/FeatureServer/0';
const catalogUrl = 'https://gis.example/arcgis/rest/services/Images/FeatureServer/0';
const line1 = '1 25544U 98067A   26280.50000000  .00016717  00000-0  10270-3 0  9994';
const line2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49815399432717';
const sat = (name: string) => ({ ...satellitesFromText(`${name}\n${line1}\n${line2}`, { maxOffNadir: 45, minOffNadir: 0, swath: 10 })[0], id: name });
const sats = [sat('WorldView-3'), sat('SAR-1')];
const targets: PlanTarget[] = [
  { label: '東京', center: [139.7, 35.7], points: [] },
  { label: '大阪', center: [135.5, 34.7], points: [] },
];
const T0 = Date.UTC(2026, 9, 10, 1, 0);
const base = { offNadir: 10, incidence: 11, elevation: 79, side: 'left' as const, ascending: false, sunElevation: 30, range: 500, width: 0, strips: 1, length: 0, frames: 1, coverage: 1, window: [0, 0] as [number, number], along: [0, 0] as [number, number], tleAge: 1, orbitRadius: 6800, azimuth: 0, satEcef: [0, 0, 6800] as [number, number, number] };
const ops: Opportunity[] = [
  { ...base, satellite: 0, target: 0, time: T0 },
  { ...base, satellite: 1, target: 1, time: T0 + 86400000 },
  { ...base, satellite: 0, target: 1, time: T0 + 20 * 86400000 },
];
const box = (lon: number, lat: number) => [[[lon - 0.05, lat - 0.05], [lon + 0.05, lat - 0.05], [lon + 0.05, lat + 0.05], [lon - 0.05, lat + 0.05], [lon - 0.05, lat - 0.05]]];
const ringsOf = (op: Opportunity) => box(...targets[op.target].center);

describe('plan stores', () => {
  it('reads planStores from config.json, with default field names', () => {
    const problems: string[] = [];
    const store = planStoreOf({ label: '計画', url: planUrl, fields: { status: 'STATE' }, catalog: '画像' }, problems, 0)!;
    expect(store.fields).toEqual({ ...defaultPlanFields, status: 'STATE' });
    expect(store.matchMinutes).toBe(30);
    expect(store.missAfterDays).toBe(3);
    expect(planStoreOf({ url: 'https://x/MapServer' }, problems, 1)).toBeNull();
    expect(problems).toHaveLength(1);
    expect(parseConfig({ planStores: [{ url: planUrl }] }).config.planStores).toHaveLength(1);
  });

  it('saves, lists, follows up and deletes a plan', async () => {
    const store = planStoreOf({ url: planUrl }, [], 0)!;
    const images = [
      // Taken 10 minutes after the Tokyo shot, over it, by the planned satellite.
      { attributes: { IMAGE_ID: 'WV3-001', ACQ: T0 + 600000, SENSOR: 'WV-3 / WorldView3' }, box: [139.6, 35.6, 139.8, 35.8] as [number, number, number, number] },
      { attributes: { IMAGE_ID: 'OTHER', ACQ: T0 + 600000, SENSOR: 'Pleiades' }, box: [139.6, 35.6, 139.8, 35.8] as [number, number, number, number] },
      // Over Osaka, but a week late.
      { attributes: { IMAGE_ID: 'LATE', ACQ: T0 + 8 * 86400000, SENSOR: 'SAR-1' }, box: [135.4, 34.6, 135.6, 34.8] as [number, number, number, number] },
    ];
    const fake = fakeEsri(planUrl, catalogUrl, images);
    const features = shotFeatures(ops, sats, targets, ringsOf, { id: 'P1', name: '十月の計画' }, store.fields, T0 - 86400000);
    expect(features).toHaveLength(3);
    expect(features[0].attributes).toMatchObject({ PLAN_ID: 'P1', SHOT_TIME: T0, SATELLITE: 'WorldView-3', STATUS: '予定', PASS_DIR: '南行' });
    expect(await addShots(store, fake.ask, features)).toEqual({ saved: 3, failed: [] });
    // Outer rings go clockwise.
    const ring = fake.shots[0].geometry.rings[0];
    expect(ring[1][1]).toBeGreaterThan(ring[0][1]);

    const plans = await listPlans(store, fake.ask);
    expect(plans).toEqual([expect.objectContaining({ id: 'P1', name: '十月の計画', shots: 3, first: T0, statuses: { 予定: 3 } })]);
    const shots = await loadShots(store, fake.ask, 'P1');
    expect(shots.map((s) => s.target)).toEqual(['東京', '大阪', '大阪']);

    const catalog = catalogOf({ label: '画像', url: catalogUrl, fields: { id: 'IMAGE_ID', acquired: 'ACQ', sensor: 'SENSOR', source: 'URL' } }, [], 0)!;
    const now = T0 + 5 * 86400000;
    const changes = await trackShots(store, catalog, { ACQ: 'esriFieldTypeDate' }, fake.ask, shots, now);
    // Tokyo: the satellite's own image, not the other one; Osaka: nothing within 30 minutes and 3 days gone; the last shot is ahead.
    expect(changes).toEqual([
      { objectId: shots[0].objectId, status: '撮像済み', imageId: 'WV3-001' },
      { objectId: shots[1].objectId, status: '未撮像' },
    ]);
    expect(await updateShots(store, fake.ask, changes)).toBe(2);
    const after = await listPlans(store, fake.ask);
    expect(after[0].statuses).toEqual({ 撮像済み: 1, 未撮像: 1, 予定: 1 });
    expect(progressText(after[0].statuses)).toBe('撮像済み 1 / 2（50%）・未撮像 1・予定 1');

    await deletePlan(store, fake.ask, 'P1');
    expect(await listPlans(store, fake.ask)).toEqual([]);
  });

  it('writes time conditions for the field type', () => {
    expect(betweenCondition('T', 'esriFieldTypeDate', 0, 60000)).toBe("T >= TIMESTAMP '1970-01-01 00:00:00' AND T <= TIMESTAMP '1970-01-01 00:01:00'");
    expect(betweenCondition('T', 'esriFieldTypeDouble', 0.5, 10.2)).toBe('T >= 0 AND T <= 11');
  });
});
