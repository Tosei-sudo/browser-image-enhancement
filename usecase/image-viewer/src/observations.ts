/**
 * Observations (観測記録): what was seen in an image, one record per thing
 * per image — when (the image's acquisition time), where (a point), what
 * thing (モノ: an id that stays the same from image to image, a name and a
 * kind) and what it was doing (活動), or that it was no longer there.
 *
 * What the viewer knows is filled in by itself: the record's id, the image's
 * id (its catalog id, else its file name), name and time, the place's
 * longitude and latitude, and when the record was made, last changed and
 * deleted (a deleted record is kept, marked, so it can be brought back).
 *
 * Because images are recorded in any order, a thing's flow (流れ) is its
 * records ordered by the images' times, not by when they were made: the
 * spans it stayed doing one thing, where it moved, and when it went.
 *
 * Kept in an Esri feature service (`config.json`'s `observationStores`, a
 * point layer, attribute names mapped by role as `planStores` are) or, when
 * none is given, in the browser (IndexedDB).
 */
import { timeOf, type FieldTypes } from './catalog-query.js';
import { getDistance } from 'ol/sphere.js';

/** One observation of one thing in one image. */
export interface Observation {
  /** The record's own id. */
  id: string;
  /** The image's catalog id, else its file name. */
  imageId: string;
  imageName: string;
  /** When the image was taken (ms), when known. */
  imageTime: number | null;
  /** The thing's id, the same in every image it is recorded in. */
  objectId: string;
  objectName: string;
  /** 種別: ship, aircraft, building… */
  kind: string;
  /** 活動: what it was doing. */
  activity: string;
  /** False for 「いない」: looked for and not there. */
  present: boolean;
  note: string;
  lon: number;
  lat: number;
  createdAt: number;
  updatedAt: number;
  /** When it was deleted; null while it counts. */
  deletedAt: number | null;
}

/** The record's attributes by role, for a feature layer. */
export interface ObservationFields {
  id: string;
  imageId: string;
  imageName: string;
  imageTime: string;
  objectId: string;
  objectName: string;
  kind: string;
  activity: string;
  present: string;
  note: string;
  created: string;
  updated: string;
  deleted: string;
}

/** The names used when `config.json` does not map a role. */
export const defaultObservationFields: ObservationFields = {
  id: 'OBS_ID',
  imageId: 'IMAGE_ID',
  imageName: 'IMAGE_NAME',
  imageTime: 'IMAGE_TIME',
  objectId: 'OBJECT_ID',
  objectName: 'OBJECT_NAME',
  kind: 'KIND',
  activity: 'ACTIVITY',
  present: 'PRESENT',
  note: 'NOTE',
  created: 'CREATED_AT',
  updated: 'UPDATED_AT',
  deleted: 'DELETED_AT',
};

/** The kinds and activities offered first (more can be typed; those used are offered too). */
export interface ObservationVocabulary {
  kinds: string[];
  activities: string[];
}

export const defaultVocabulary: ObservationVocabulary = {
  kinds: ['船舶', '航空機', '車両', '建物', '構造物', 'その他'],
  activities: ['停泊', '航行', '駐機', '移動', '工事', '集積', '活動なし'],
};

/** One entry of `config.json`'s `observationStores`. */
export interface ObservationStoreConfig {
  label: string;
  /** An editable point feature layer (`…/FeatureServer/0`). */
  url: string;
  token?: string;
  fields: ObservationFields;
  /** Only these records (an SQL where clause). */
  where?: string;
  /** False: deleting removes the feature instead of marking it. */
  softDelete: boolean;
  kinds?: string[];
  activities?: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const words = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()) : undefined);

/** One `observationStores` entry; null (with the reason in `problems`) when it cannot be used. */
export function observationStoreOf(value: unknown, problems: string[], index: number): ObservationStoreConfig | null {
  const at = `observationStores[${index}]`;
  if (!isRecord(value)) return (problems.push(`${at} がオブジェクトではありません`), null);
  const { label, url, token, fields, where, softDelete, kinds, activities } = value;
  if (typeof url !== 'string' || !/\/FeatureServer\/\d+\/?$/i.test(url.split('?', 1)[0])) return (problems.push(`${at} の url は編集できる …/FeatureServer/0 のようなポイントレイヤーの URL にしてください`), null);
  const mapped = { ...defaultObservationFields };
  if (isRecord(fields)) {
    for (const [key, v] of Object.entries(fields)) {
      if (!(key in defaultObservationFields)) problems.push(`${at} の fields.${key} は使えない役割です`);
      else if (typeof v === 'string' && /^[\w.]+$/.test(v)) mapped[key as keyof ObservationFields] = v;
      else problems.push(`${at} の fields.${key} は属性名にしてください`);
    }
  }
  return {
    label: typeof label === 'string' && label ? label : `観測の保存先 ${index + 1}`,
    url: url.split('?', 1)[0].replace(/\/+$/, ''),
    ...(typeof token === 'string' && token ? { token } : {}),
    fields: mapped,
    ...(typeof where === 'string' && where.trim() ? { where: where.trim() } : {}),
    softDelete: softDelete !== false,
    ...(words(kinds)?.length ? { kinds: words(kinds) } : {}),
    ...(words(activities)?.length ? { activities: words(activities) } : {}),
  };
}

/** `config.json`'s `observationVocabulary`. */
export function vocabularyOf(value: unknown, problems: string[]): ObservationVocabulary {
  if (!isRecord(value)) {
    problems.push('observationVocabulary がオブジェクトではありません');
    return { ...defaultVocabulary };
  }
  return { kinds: words(value.kinds)?.length ? words(value.kinds)! : defaultVocabulary.kinds, activities: words(value.activities)?.length ? words(value.activities)! : defaultVocabulary.activities };
}

const randomId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
/** A new record id. */
export const newObservationId = (): string => randomId();
/** A new thing id: short, to be read and typed (`OBJ-K3F9Q2TX`). */
export const newObjectId = (): string => `OBJ-${randomId().replace(/-/g, '').slice(-8).toUpperCase()}`;

/** The next free name of a kind: 船舶-1, 船舶-2… */
export function nextName(kind: string, taken: Iterable<string>): string {
  const base = kind || 'モノ';
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`);
  let max = 0;
  for (const name of taken) {
    const m = pattern.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${base}-${max + 1}`;
}

/** When an observation sits in a flow: its image's time, else when it was made. */
export const timeKey = (o: Observation): number => o.imageTime ?? o.createdAt;
const byTime = (a: Observation, b: Observation) => timeKey(a) - timeKey(b) || a.createdAt - b.createdAt;

/** The records that count (not deleted). */
export const living = (list: readonly Observation[]): Observation[] => list.filter((o) => o.deletedAt === null);

/** A stretch of a flow: one activity (or absence) over consecutive images. */
export interface FlowStep {
  activity: string;
  present: boolean;
  from: number;
  to: number;
  count: number;
  /** How far (m) the thing had moved since the step before, at the step's first record. */
  moved: number | null;
  observations: Observation[];
}

/** A thing's flow: its records in image-time order, and what they say. */
export interface ObjectFlow {
  objectId: string;
  name: string;
  kind: string;
  observations: Observation[];
  first: number;
  last: number;
  /** The images it was seen in. */
  seen: number;
  /** The latest record's activity, and whether it was there then. */
  activity: string;
  present: boolean;
  /** The path length (m) between the places it was seen. */
  distance: number;
  steps: FlowStep[];
}

/** Farther than this (m) between two records counts as having moved. */
export const MOVE_METRES = 30;

const distance = (a: Observation, b: Observation) => getDistance([a.lon, a.lat], [b.lon, b.lat]);

/** The flow of one thing (its living records, any order). */
export function flowOf(records: readonly Observation[]): ObjectFlow {
  const list = [...records].sort(byTime);
  const last = list[list.length - 1];
  const steps: FlowStep[] = [];
  let path = 0;
  let previous: Observation | null = null;
  for (const o of list) {
    const moved = previous && o.present && previous.present ? distance(previous, o) : null;
    if (moved !== null) path += moved;
    const step = steps[steps.length - 1];
    const same = step && step.present === o.present && (!o.present || step.activity === o.activity) && !(moved !== null && moved > MOVE_METRES);
    if (same) {
      step.to = timeKey(o);
      step.count++;
      step.observations.push(o);
    } else steps.push({ activity: o.present ? o.activity : '', present: o.present, from: timeKey(o), to: timeKey(o), count: 1, moved: steps.length ? moved : null, observations: [o] });
    if (o.present) previous = o;
  }
  // The name and kind as last written.
  const named = [...list].reverse().find((o) => o.objectName) ?? last;
  return {
    objectId: last.objectId,
    name: named.objectName || last.objectId,
    kind: named.kind,
    observations: list,
    first: timeKey(list[0]),
    last: timeKey(last),
    seen: list.filter((o) => o.present).length,
    activity: last.activity,
    present: last.present,
    distance: path,
    steps,
  };
}

/** Every thing's flow (from living records), the most recently seen first. */
export function flows(records: readonly Observation[]): ObjectFlow[] {
  const groups = new Map<string, Observation[]>();
  for (const o of living(records)) {
    const g = groups.get(o.objectId);
    if (g) g.push(o);
    else groups.set(o.objectId, [o]);
  }
  return [...groups.values()].map(flowOf).sort((a, b) => b.last - a.last || a.name.localeCompare(b.name, 'ja'));
}

/** A thing recorded in another image that may be in this one too. */
export interface CarryOver {
  /** Its nearest record in time. */
  from: Observation;
  /** Whether that record is from an earlier image or a later one. */
  side: 'before' | 'after';
}

/**
 * What may still be there in an image: each thing not yet recorded in it,
 * by its nearest record in time — an earlier one first, else a later one —
 * unless that record says it had gone (or, later, was not there yet).
 * `inside` limits them to a place (the image's footprint).
 */
export function carryOvers(records: readonly Observation[], image: { id: string; time: number | null }, inside?: (lon: number, lat: number) => boolean): CarryOver[] {
  const here = new Set<string>();
  const others = new Map<string, Observation[]>();
  for (const o of living(records)) {
    if (o.imageId === image.id) here.add(o.objectId);
    else {
      const g = others.get(o.objectId);
      if (g) g.push(o);
      else others.set(o.objectId, [o]);
    }
  }
  const out: CarryOver[] = [];
  for (const [objectId, list] of others) {
    if (here.has(objectId)) continue;
    list.sort(byTime);
    const before = image.time === null ? list : list.filter((o) => timeKey(o) <= image.time!);
    const pick: CarryOver = before.length ? { from: before[before.length - 1], side: 'before' } : { from: list[0], side: 'after' };
    if (!pick.from.present) continue;
    // Its last place it was seen at, for the ghost.
    if (inside && !inside(pick.from.lon, pick.from.lat)) continue;
    out.push(pick);
  }
  return out.sort((a, b) => a.from.objectName.localeCompare(b.from.objectName, 'ja'));
}

/** A copy of `from` for another image (the same thing, its place and activity), stamped now. */
export function carriedInto(from: Observation, image: { id: string; name: string; time: number | null }, now = Date.now(), changes: Partial<Observation> = {}): Observation {
  return { ...from, note: '', ...changes, id: newObservationId(), imageId: image.id, imageName: image.name, imageTime: image.time, createdAt: now, updatedAt: now, deletedAt: null };
}

const pad = (n: number) => String(n).padStart(2, '0');
/** `yyyy-mm-dd hh:mm` in local time. */
export const localTime = (t: number | null): string => {
  if (t === null || !Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const iso = (t: number | null) => (t === null || !Number.isFinite(t) ? '' : new Date(t).toISOString());

/** The CSV of observations (with a BOM, for spreadsheets), in flow order. */
export function observationsCsv(records: readonly Observation[]): string {
  const cell = (v: unknown) => {
    const text = String(v ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const head = ['観測ID', 'モノID', 'モノ', '種別', '活動', '有無', '撮像日時', '画像ID', '画像', '経度', '緯度', '備考', '登録日時', '更新日時', '削除日時'];
  const rows = [...records]
    .sort((a, b) => a.objectId.localeCompare(b.objectId) || byTime(a, b))
    .map((o) => [o.id, o.objectId, o.objectName, o.kind, o.activity, o.present ? 'あり' : 'なし', iso(o.imageTime), o.imageId, o.imageName, o.lon.toFixed(7), o.lat.toFixed(7), o.note, iso(o.createdAt), iso(o.updatedAt), iso(o.deletedAt)]);
  return `\ufeff${[head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}

/** Where observations are kept. */
export interface ObservationStore {
  readonly label: string;
  /** Every record (deleted ones too). */
  load(): Promise<Observation[]>;
  /** Adds or replaces records. */
  save(list: readonly Observation[]): Promise<void>;
  /** Deletes records: marks them (returns them marked), or removes them where the store says so. */
  remove(list: readonly Observation[], now?: number): Promise<Observation[]>;
}

const DB = 'image-viewer-observations';
const STORE = 'observations';

/** Observations in this browser (IndexedDB). */
export class LocalObservationStore implements ObservationStore {
  readonly label = 'このブラウザ';

  private open_(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB を開けません'));
    });
  }

  async load(): Promise<Observation[]> {
    const db = await this.open_();
    try {
      return await new Promise<Observation[]>((resolve, reject) => {
        const request = db.transaction(STORE).objectStore(STORE).getAll();
        request.onsuccess = () => resolve(request.result as Observation[]);
        request.onerror = () => reject(request.error ?? new Error('読み込めません'));
      });
    } finally {
      db.close();
    }
  }

  async save(list: readonly Observation[]): Promise<void> {
    if (!list.length) return;
    const db = await this.open_();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        for (const o of list) store.put(o);
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('ブラウザに保存できません'));
      });
    } finally {
      db.close();
    }
  }

  async remove(list: readonly Observation[], now = Date.now()): Promise<Observation[]> {
    const marked = list.map((o) => ({ ...o, deletedAt: now, updatedAt: now }));
    await this.save(marked);
    return marked;
  }
}

/** Asks an Esri layer for JSON (POST); throws with the reason when it cannot. */
export type ObservationAsk = (url: string, params: Record<string, string>, token?: string) => Promise<unknown>;

type EsriFeature = { attributes: Record<string, unknown>; geometry?: { x?: number; y?: number } | null };

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const presentOf = (v: unknown) => !(v === 0 || v === false || /^(0|false|no|なし|いない|不在)$/i.test(text(v).trim()));
const msOf = (v: unknown): number | null => {
  const t = timeOf(v);
  return Number.isFinite(t) ? t : null;
};

/** Observations in an Esri point feature layer. */
export class EsriObservationStore implements ObservationStore {
  readonly label: string;
  /** The object id of each record (by its own id) as the layer gave it. */
  private readonly oids_ = new Map<string, number>();
  private layer_: Promise<{ types: FieldTypes; oid: string }> | null = null;

  constructor(
    private readonly config: ObservationStoreConfig,
    private readonly ask: ObservationAsk,
  ) {
    this.label = config.label;
  }

  /** The layer's fields and object id field (asked once). */
  private layer(): Promise<{ types: FieldTypes; oid: string }> {
    this.layer_ ??= (async () => {
      const json = (await this.ask(this.config.url, {}, this.config.token)) as { fields?: Array<{ name: string; type: string }>; objectIdField?: string };
      const types: FieldTypes = {};
      for (const f of json.fields ?? []) types[f.name] = f.type;
      const oid = json.objectIdField ?? json.fields?.find((f) => f.type === 'esriFieldTypeOID')?.name ?? 'OBJECTID';
      for (const role of ['id', 'objectId'] as const) if (!(this.config.fields[role] in types)) throw new Error(`${this.config.label} に属性 ${this.config.fields[role]} がありません`);
      return { types, oid };
    })();
    this.layer_.catch(() => (this.layer_ = null));
    return this.layer_;
  }

  /** A value written for a field's type. */
  private static fit(value: unknown, type: string | undefined): unknown {
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean') return type && /Integer/.test(type) ? (value ? 1 : 0) : type === 'esriFieldTypeString' ? (value ? 'あり' : 'なし') : value;
    if (type === 'esriFieldTypeString' && typeof value === 'number' && value > 1e11) return new Date(value).toISOString();
    return value;
  }

  private featureOf(o: Observation, types: FieldTypes, oid: string): EsriFeature {
    const f = this.config.fields;
    const values: Record<string, unknown> = {
      [f.id]: o.id,
      [f.imageId]: o.imageId,
      [f.imageName]: o.imageName,
      [f.imageTime]: o.imageTime,
      [f.objectId]: o.objectId,
      [f.objectName]: o.objectName,
      [f.kind]: o.kind,
      [f.activity]: o.activity,
      [f.present]: o.present,
      [f.note]: o.note,
      [f.created]: o.createdAt,
      [f.updated]: o.updatedAt,
      [f.deleted]: o.deletedAt,
    };
    const attributes: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(values)) if (name in types) attributes[name] = EsriObservationStore.fit(value, types[name]);
    const id = this.oids_.get(o.id);
    if (id !== undefined) attributes[oid] = id;
    return { attributes, geometry: { x: o.lon, y: o.lat, spatialReference: { wkid: 4326 } } as EsriFeature['geometry'] };
  }

  private recordOf(feature: EsriFeature, oid: string): Observation | null {
    const f = this.config.fields;
    const a = feature.attributes;
    const id = text(a[f.id]);
    const objectId = text(a[f.objectId]);
    const x = feature.geometry?.x;
    const y = feature.geometry?.y;
    if (!id || !objectId || typeof x !== 'number' || typeof y !== 'number') return null;
    if (typeof a[oid] === 'number') this.oids_.set(id, a[oid] as number);
    const created = msOf(a[f.created]) ?? 0;
    return {
      id,
      imageId: text(a[f.imageId]),
      imageName: text(a[f.imageName]),
      imageTime: msOf(a[f.imageTime]),
      objectId,
      objectName: text(a[f.objectName]),
      kind: text(a[f.kind]),
      activity: text(a[f.activity]),
      present: f.present in a ? presentOf(a[f.present]) : true,
      note: text(a[f.note]),
      lon: x,
      lat: y,
      createdAt: created,
      updatedAt: msOf(a[f.updated]) ?? created,
      deletedAt: msOf(a[f.deleted]),
    };
  }

  async load(): Promise<Observation[]> {
    const { oid } = await this.layer();
    const out: Observation[] = [];
    for (let offset = 0; offset < 200000; ) {
      const json = (await this.ask(`${this.config.url}/query`, { where: this.config.where ?? '1=1', outFields: '*', returnGeometry: 'true', outSR: '4326', resultOffset: String(offset), resultRecordCount: '2000' }, this.config.token)) as {
        features?: EsriFeature[];
        exceededTransferLimit?: boolean;
        error?: { message?: string };
      };
      if (json.error) throw new Error(json.error.message ?? '読み込めません');
      const features = json.features ?? [];
      for (const feature of features) {
        const o = this.recordOf(feature, oid);
        if (o) out.push(o);
      }
      if (!json.exceededTransferLimit || !features.length) break;
      offset += features.length;
    }
    return out;
  }

  async save(list: readonly Observation[]): Promise<void> {
    if (!list.length) return;
    const { types, oid } = await this.layer();
    const failed: string[] = [];
    for (let i = 0; i < list.length; i += 200) {
      const batch = list.slice(i, i + 200);
      const adds = batch.filter((o) => !this.oids_.has(o.id));
      const updates = batch.filter((o) => this.oids_.has(o.id));
      const json = (await this.ask(
        `${this.config.url}/applyEdits`,
        { adds: JSON.stringify(adds.map((o) => this.featureOf(o, types, oid))), updates: JSON.stringify(updates.map((o) => this.featureOf(o, types, oid))), rollbackOnFailure: 'false' },
        this.config.token,
      )) as { addResults?: Array<{ success: boolean; objectId?: number; error?: { description?: string } | null }>; updateResults?: Array<{ success: boolean; error?: { description?: string } | null }> };
      (json.addResults ?? []).forEach((r, k) => {
        if (r.success && typeof r.objectId === 'number') this.oids_.set(adds[k].id, r.objectId);
        else if (!r.success) failed.push(r.error?.description ?? '追加できませんでした');
      });
      for (const r of json.updateResults ?? []) if (!r.success) failed.push(r.error?.description ?? '更新できませんでした');
    }
    if (failed.length) throw new Error(`${failed.length} 件を保存できませんでした: ${failed[0]}`);
  }

  async remove(list: readonly Observation[], now = Date.now()): Promise<Observation[]> {
    const marked = list.map((o) => ({ ...o, deletedAt: now, updatedAt: now }));
    if (this.config.softDelete && this.config.fields.deleted in (await this.layer()).types) {
      await this.save(marked);
      return marked;
    }
    const ids = list.map((o) => this.oids_.get(o.id)).filter((v): v is number => v !== undefined);
    if (ids.length) await this.ask(`${this.config.url}/deleteFeatures`, { objectIds: ids.join(',') }, this.config.token);
    for (const o of list) this.oids_.delete(o.id);
    return [];
  }
}
