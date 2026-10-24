/**
 * Imaging plans kept in an Esri feature service (`config.json`'s
 * `planStores`): each planned shot is one polygon feature (its scenes) with
 * the plan's id and name, the moment, the satellite, the target, its angles
 * and a status. Plans saved by anyone using the same layer can be opened
 * again, and followed up: once a shot's moment has passed, the image catalog
 * is asked for an image taken then over its scenes, and the shot is marked
 * 「撮像済み」 with the image's id, or 「未撮像」 when none came within the
 * days allowed.
 *
 * Plain computation and requests (through an injected `ask`), free of the
 * page, so the tests drive it without a server.
 */
import type { CatalogConfig } from './catalog.js';
import { quote, timeOf, utcText, type FieldTypes } from './catalog-query.js';
import type { Opportunity, PlanTarget, SatelliteSpec } from './imaging-plan.js';
import { shotsOf } from './imaging-plan-remind.js';

/** Attribute names of the plan layer, by role. */
export interface PlanStoreFields {
  planId: string;
  planName: string;
  shotTime: string;
  satellite: string;
  satelliteId: string;
  /** The imaging mode the shot is planned in (written when the layer has it). */
  mode: string;
  target: string;
  offNadir: string;
  incidence: string;
  pass: string;
  side: string;
  status: string;
  imageId: string;
  created: string;
}

/** The names used when `config.json` does not map a role. */
export const defaultPlanFields: PlanStoreFields = {
  planId: 'PLAN_ID',
  planName: 'PLAN_NAME',
  shotTime: 'SHOT_TIME',
  satellite: 'SATELLITE',
  satelliteId: 'SATELLITE_ID',
  mode: 'MODE',
  target: 'TARGET',
  offNadir: 'OFF_NADIR',
  incidence: 'INCIDENCE',
  pass: 'PASS_DIR',
  side: 'LOOK_SIDE',
  status: 'STATUS',
  imageId: 'IMAGE_ID',
  created: 'CREATED_AT',
};

/** One entry of `config.json`'s `planStores`. */
export interface PlanStoreConfig {
  label: string;
  /** A polygon feature layer (`…/FeatureServer/0`) that can be edited. */
  url: string;
  token?: string;
  fields: PlanStoreFields;
  /** The image catalog (its label in `imageCatalogs`) asked whether shots were taken; the first one when absent. */
  catalog?: string;
  /** How far (minutes) an image's time may be from the shot's and still be it. */
  matchMinutes: number;
  /** Days after a shot with no image before it counts as 「未撮像」. */
  missAfterDays: number;
}

/** The statuses of a shot. */
export const STATUSES = ['予定', '撮像済み', '未撮像', '取消'] as const;
export type ShotStatus = (typeof STATUSES)[number];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The store of one `planStores` entry; null (with the reason in `problems`) when it cannot be used. */
export function planStoreOf(value: unknown, problems: string[], index: number): PlanStoreConfig | null {
  const at = `planStores[${index}]`;
  if (!isRecord(value)) return (problems.push(`${at} はオブジェクトで指定`), null);
  const { label, url, token, fields, catalog, matchMinutes, missAfterDays } = value;
  if (typeof url !== 'string' || !/\/FeatureServer\/\d+\/?$/i.test(url.split('?', 1)[0])) return (problems.push(`${at} の url は編集できる …/FeatureServer/0 のようなレイヤーの URL で指定`), null);
  const mapped = { ...defaultPlanFields };
  if (isRecord(fields)) {
    for (const key of Object.keys(defaultPlanFields) as Array<keyof PlanStoreFields>) {
      const v = fields[key];
      if (typeof v === 'string' && /^[\w.]+$/.test(v)) mapped[key] = v;
      else if (v !== undefined) problems.push(`${at} の fields.${key} は属性名で指定`);
    }
  }
  const number = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);
  return {
    label: typeof label === 'string' && label ? label : `計画の保存先 ${index + 1}`,
    url: url.split('?', 1)[0].replace(/\/+$/, ''),
    ...(typeof token === 'string' && token ? { token } : {}),
    fields: mapped,
    ...(typeof catalog === 'string' && catalog ? { catalog } : {}),
    matchMinutes: number(matchMinutes, 30),
    missAfterDays: number(missAfterDays, 3),
  };
}

/** Asks an Esri layer for JSON (POST); throws with the reason when it cannot. */
export type StoreAsk = (url: string, params: Record<string, string>, token?: string) => Promise<unknown>;

/** A shot as the layer holds it. */
export interface SavedShot {
  objectId: number;
  planId: string;
  planName: string;
  time: number;
  satellite: string;
  satelliteId: string;
  target: string;
  offNadir: number | null;
  incidence: number | null;
  pass: string;
  side: string;
  status: ShotStatus;
  imageId: string;
  created: number | null;
  /** The scenes, longitude / latitude rings. */
  rings: number[][][];
}

/** A plan in the layer: its shots counted. */
export interface SavedPlan {
  id: string;
  name: string;
  created: number | null;
  shots: number;
  first: number;
  last: number;
  /** Shots by status. */
  statuses: Partial<Record<ShotStatus, number>>;
}

/** The layer's fields (names that exist) and its object id field. */
export async function layerOf(store: PlanStoreConfig, ask: StoreAsk): Promise<{ names: Set<string>; types: FieldTypes; oid: string }> {
  const json = (await ask(store.url, {}, store.token)) as { fields?: Array<{ name: string; type: string }>; objectIdField?: string };
  const types: FieldTypes = {};
  for (const f of json.fields ?? []) types[f.name] = f.type;
  const oid = json.objectIdField ?? json.fields?.find((f) => f.type === 'esriFieldTypeOID')?.name ?? 'OBJECTID';
  const names = new Set(Object.keys(types));
  for (const role of ['planId', 'shotTime'] as const) if (!names.has(store.fields[role])) throw new Error(`${store.label} に属性 ${store.fields[role]} なし`);
  return { names, types, oid };
}

/** A new id for a plan. */
export const newPlanId = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`).toUpperCase();

/**
 * The features of a plan's shots (one per shot; a scene shared by several
 * targets once, naming them all): attributes by role, and the scenes as an
 * Esri polygon in WGS 84.
 */
export function shotFeatures(
  ops: readonly Opportunity[],
  sats: readonly SatelliteSpec[],
  targets: readonly PlanTarget[],
  ringsOf: (op: Opportunity) => number[][][],
  plan: { id: string; name: string },
  fields: PlanStoreFields,
  now = Date.now(),
): Array<{ attributes: Record<string, unknown>; geometry: object }> {
  return shotsOf(ops, sats, targets).map(({ op, sat, targets: names }) => ({
    attributes: {
      [fields.planId]: plan.id,
      [fields.planName]: plan.name,
      [fields.shotTime]: op.time,
      [fields.satellite]: sat.name,
      [fields.satelliteId]: sat.id,
      [fields.mode]: sat.mode ?? null,
      [fields.target]: names.join('、').slice(0, 250),
      [fields.offNadir]: Math.round(op.offNadir * 100) / 100,
      [fields.incidence]: Math.round(op.incidence * 100) / 100,
      [fields.pass]: op.ascending ? '北行' : '南行',
      [fields.side]: op.side === 'right' ? '右' : '左',
      [fields.status]: '予定',
      [fields.imageId]: null,
      [fields.created]: now,
    },
    // Outer rings clockwise, as the REST API expects.
    geometry: { rings: ringsOf(op).map((ring) => (signedArea(ring) > 0 ? [...ring].reverse() : ring)), spatialReference: { wkid: 4326 } },
  }));
}

/** Twice the signed area of a ring (positive when anticlockwise). */
function signedArea(ring: number[][]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return a;
}

/** Leaves out the attributes the layer does not have. */
const only = (attributes: Record<string, unknown>, names: Set<string>) => Object.fromEntries(Object.entries(attributes).filter(([k]) => names.has(k)));

/** Adds features to the layer (200 at a time); returns how many were saved and why others were not. */
export async function addShots(store: PlanStoreConfig, ask: StoreAsk, features: Array<{ attributes: Record<string, unknown>; geometry: object }>): Promise<{ saved: number; failed: string[] }> {
  const { names } = await layerOf(store, ask);
  let saved = 0;
  const failed: string[] = [];
  for (let i = 0; i < features.length; i += 200) {
    const batch = features.slice(i, i + 200).map((f) => ({ ...f, attributes: only(f.attributes, names) }));
    const json = (await ask(`${store.url}/applyEdits`, { adds: JSON.stringify(batch), rollbackOnFailure: 'false' }, store.token)) as { addResults?: Array<{ success: boolean; error?: { description?: string } | null }> };
    for (const r of json.addResults ?? []) {
      if (r.success) saved++;
      else failed.push(r.error?.description ?? '保存失敗');
    }
  }
  return { saved, failed };
}

const numberOr = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const statusOf = (v: unknown): ShotStatus => ((STATUSES as readonly string[]).includes(text(v)) ? (text(v) as ShotStatus) : '予定');

/** Every feature matching `where` (paged, at most `max`). */
async function queryAll(store: PlanStoreConfig, ask: StoreAsk, params: Record<string, string>, max = 20000): Promise<Array<{ attributes: Record<string, unknown>; geometry?: { rings?: number[][][] } }>> {
  const out: Array<{ attributes: Record<string, unknown>; geometry?: { rings?: number[][][] } }> = [];
  for (let offset = 0; offset < max; ) {
    const json = (await ask(`${store.url}/query`, { ...params, resultOffset: String(offset), resultRecordCount: '2000' }, store.token)) as {
      features?: Array<{ attributes: Record<string, unknown>; geometry?: { rings?: number[][][] } }>;
      exceededTransferLimit?: boolean;
    };
    const features = json.features ?? [];
    out.push(...features);
    if (!json.exceededTransferLimit || !features.length) break;
    offset += features.length;
  }
  return out;
}

/** The plans in the layer, newest first. */
export async function listPlans(store: PlanStoreConfig, ask: StoreAsk): Promise<SavedPlan[]> {
  const f = store.fields;
  const { names } = await layerOf(store, ask);
  const fields = [f.planId, f.planName, f.shotTime, f.status, f.created].filter((n) => names.has(n));
  const rows = await queryAll(store, ask, { where: '1=1', outFields: fields.join(','), returnGeometry: 'false' });
  const plans = new Map<string, SavedPlan>();
  for (const { attributes: a } of rows) {
    const id = text(a[f.planId]);
    if (!id) continue;
    const time = timeOf(a[f.shotTime]);
    const plan = plans.get(id) ?? { id, name: text(a[f.planName]) || id, created: numberOr(a[f.created]), shots: 0, first: Infinity, last: -Infinity, statuses: {} };
    plan.shots++;
    if (Number.isFinite(time)) {
      plan.first = Math.min(plan.first, time);
      plan.last = Math.max(plan.last, time);
    }
    const status = statusOf(a[f.status]);
    plan.statuses[status] = (plan.statuses[status] ?? 0) + 1;
    plans.set(id, plan);
  }
  return [...plans.values()].sort((a, b) => (b.created ?? b.first) - (a.created ?? a.first));
}

/** The shots of a plan, in time order. */
export async function loadShots(store: PlanStoreConfig, ask: StoreAsk, planId: string): Promise<SavedShot[]> {
  const f = store.fields;
  const { oid } = await layerOf(store, ask);
  const rows = await queryAll(store, ask, { where: `${f.planId} = ${quote(planId)}`, outFields: '*', returnGeometry: 'true', outSR: '4326' });
  return rows
    .map(({ attributes: a, geometry }) => ({
      objectId: Number(a[oid]),
      planId: text(a[f.planId]),
      planName: text(a[f.planName]),
      time: timeOf(a[f.shotTime]),
      satellite: text(a[f.satellite]),
      satelliteId: text(a[f.satelliteId]),
      target: text(a[f.target]),
      offNadir: numberOr(a[f.offNadir]),
      incidence: numberOr(a[f.incidence]),
      pass: text(a[f.pass]),
      side: text(a[f.side]),
      status: statusOf(a[f.status]),
      imageId: text(a[f.imageId]),
      created: numberOr(a[f.created]),
      rings: geometry?.rings ?? [],
    }))
    .sort((a, b) => a.time - b.time);
}

/** Changes shots' status (and image id) in the layer. */
export async function updateShots(store: PlanStoreConfig, ask: StoreAsk, changes: Array<{ objectId: number; status: ShotStatus; imageId?: string }>): Promise<number> {
  if (!changes.length) return 0;
  const { names, oid } = await layerOf(store, ask);
  const f = store.fields;
  let done = 0;
  for (let i = 0; i < changes.length; i += 200) {
    const updates = changes.slice(i, i + 200).map((c) => ({ attributes: only({ [oid]: c.objectId, [f.status]: c.status, ...(c.imageId !== undefined ? { [f.imageId]: c.imageId } : {}) }, new Set([...names, oid])) }));
    const json = (await ask(`${store.url}/applyEdits`, { updates: JSON.stringify(updates), rollbackOnFailure: 'false' }, store.token)) as { updateResults?: Array<{ success: boolean }> };
    done += (json.updateResults ?? []).filter((r) => r.success).length;
  }
  return done;
}

/** Deletes a plan's shots from the layer. */
export async function deletePlan(store: PlanStoreConfig, ask: StoreAsk, planId: string): Promise<void> {
  await ask(`${store.url}/deleteFeatures`, { where: `${store.fields.planId} = ${quote(planId)}` }, store.token);
}

/** `field` between two moments, written for its type. */
export function betweenCondition(field: string, type: string | undefined, from: number, to: number): string {
  if (type && /Integer|Double|Single/.test(type)) return `${field} >= ${Math.floor(from)} AND ${field} <= ${Math.ceil(to)}`;
  if (type === 'esriFieldTypeString') return `${field} >= '${utcText(from)}' AND ${field} <= '${utcText(to)}'`;
  return `${field} >= TIMESTAMP '${utcText(from)}' AND ${field} <= TIMESTAMP '${utcText(to)}'`;
}

/** Letters and digits only, lower case: `WorldView-3` → `worldview3`. */
const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** What a follow-up check found for one shot. */
export interface ShotCheck {
  objectId: number;
  status: ShotStatus;
  imageId?: string;
}

/**
 * Follows up the shots still 「予定」 whose moment has passed: an image of
 * `catalog` taken within `matchMinutes` of the shot over its scenes makes it
 * 「撮像済み」 (an image whose sensor names the satellite preferred); none
 * after `missAfterDays` makes it 「未撮像」; otherwise it waits. Returns the
 * changes only.
 */
export async function trackShots(
  store: PlanStoreConfig,
  catalog: CatalogConfig,
  types: FieldTypes,
  ask: StoreAsk,
  shots: readonly SavedShot[],
  now = Date.now(),
): Promise<ShotCheck[]> {
  const acquired = catalog.fields.acquired;
  if (!acquired) throw new Error(`${catalog.label} に撮像日時の属性（fields.acquired）なし`);
  const changes: ShotCheck[] = [];
  const window = store.matchMinutes * 60000;
  for (const shot of shots) {
    if (shot.status !== '予定' || !Number.isFinite(shot.time) || shot.time > now) continue;
    const where = [betweenCondition(acquired, types[acquired], shot.time - window, shot.time + window), ...(catalog.where ? [`(${catalog.where})`] : [])].join(' AND ');
    const params: Record<string, string> = { where, outFields: '*', returnGeometry: 'false' };
    if (shot.rings.length) Object.assign(params, { geometry: JSON.stringify({ rings: shot.rings, spatialReference: { wkid: 4326 } }), geometryType: 'esriGeometryPolygon', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' });
    const json = (await ask(`${catalog.url}/query`, params, catalog.token)) as { features?: Array<{ attributes: Record<string, unknown> }> };
    const found = json.features ?? [];
    if (found.length) {
      const names = [shot.satellite, shot.satelliteId].map(plain).filter(Boolean);
      const sensor = catalog.fields.sensor;
      const named = (f: (typeof found)[number]) => {
        const s = sensor ? plain(text(f.attributes[sensor])) : '';
        return s !== '' && names.some((n) => s.includes(n) || n.includes(s));
      };
      const best = found.find(named) ?? found[0];
      const a = best.attributes;
      const id = text((catalog.fields.id && a[catalog.fields.id]) ?? a.OBJECTID ?? a.objectid ?? a.FID);
      changes.push({ objectId: shot.objectId, status: '撮像済み', imageId: id });
    } else if (now - shot.time > store.missAfterDays * 86400000) changes.push({ objectId: shot.objectId, status: '未撮像' });
  }
  return changes;
}

/** How a plan is going: shots taken of those whose outcome is known, and those still to come or wait for. */
export function progressText(statuses: Partial<Record<ShotStatus, number>>): string {
  const taken = statuses['撮像済み'] ?? 0;
  const missed = statuses['未撮像'] ?? 0;
  const known = taken + missed;
  const parts = [known ? `撮像済み ${taken} / ${known}（${Math.round((taken / known) * 100)}%）` : '', missed ? `未撮像 ${missed}` : '', statuses['予定'] ? `予定 ${statuses['予定']}` : '', statuses['取消'] ? `取消 ${statuses['取消']}` : ''];
  return parts.filter(Boolean).join('・') || '—';
}
