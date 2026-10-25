/**
 * Checked areas (確認範囲) of the observations: a part of an image that was
 * looked over, with every thing of a kind there recorded — so a thing seen
 * there in another image and not recorded in this one was not there (空振り
 * when nothing was). A kind narrows it (「船舶」: only ships were looked
 * for); none means everything.
 *
 * Kept beside the observations: in an Esri polygon layer (the store's
 * `areas` in `config.json`), else in the browser (IndexedDB), per store.
 */
import { timeOf, type FieldTypes } from './catalog-query.js';
import { kindOf, pathOf, within } from './taxonomy.js';

/** A checked part of one image. */
export interface CheckedArea {
  id: string;
  imageId: string;
  imageName: string;
  imageTime: number | null;
  /** Its outline: longitude / latitude, closed (the first point again at the end). */
  ring: number[][];
  /** The kind looked for (its class path, `船舶 > 支援船`); '' for everything. */
  kind: string;
  note: string;
  recordedBy?: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

/** The area's attributes by role, for a feature layer. */
export interface AreaFields {
  id: string;
  imageId: string;
  imageName: string;
  imageTime: string;
  kind: string;
  note: string;
  recordedBy: string;
  created: string;
  updated: string;
  deleted: string;
}

export const defaultAreaFields: AreaFields = {
  id: 'AREA_ID',
  imageId: 'IMAGE_ID',
  imageName: 'IMAGE_NAME',
  imageTime: 'IMAGE_TIME',
  kind: 'KIND',
  note: 'NOTE',
  recordedBy: 'OBSERVER',
  created: 'CREATED_AT',
  updated: 'UPDATED_AT',
  deleted: 'DELETED_AT',
};

/** An observation store's `areas`: an editable polygon layer. */
export interface AreaStoreConfig {
  url: string;
  token?: string;
  fields: AreaFields;
  softDelete: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `areas`: the layer's URL, or `{ url, token, fields, softDelete }`; null (the reason in `problems`) when it cannot be used. */
export function areaStoreOf(value: unknown, problems: string[], at: string): AreaStoreConfig | null {
  const v = typeof value === 'string' ? { url: value } : isRecord(value) ? value : null;
  const url = typeof v?.url === 'string' ? v.url.split('?', 1)[0].replace(/\/+$/, '') : '';
  if (!/\/FeatureServer\/\d+$/i.test(url)) return (problems.push(`${at} は編集できる …/FeatureServer/1 のようなポリゴンレイヤーの URL で指定`), null);
  const fields = { ...defaultAreaFields };
  if (isRecord(v!.fields)) {
    for (const [key, name] of Object.entries(v!.fields)) {
      if (!(key in defaultAreaFields)) problems.push(`${at} の fields.${key} は使用不可の役割`);
      else if (typeof name === 'string' && /^[\w.]+$/.test(name)) fields[key as keyof AreaFields] = name;
      else problems.push(`${at} の fields.${key} は属性名で指定`);
    }
  }
  return { url, ...(typeof v!.token === 'string' && v!.token ? { token: v!.token } : {}), fields, softDelete: v!.softDelete !== false };
}

/** A new area id. */
export const newAreaId = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/** The closed outline of a longitude / latitude box. */
export const boxRing = ([w, s, e, n]: readonly number[]): number[][] => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];

/** Whether a place is inside an area's outline (even-odd). */
export function areaContains(area: Pick<CheckedArea, 'ring'>, lon: number, lat: number): boolean {
  const ring = area.ring;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Whether an area was checked for things of a kind ('' kind: any). */
export const coversKind = (area: Pick<CheckedArea, 'kind'>, kind: string): boolean => !area.kind || within(kind, pathOf(area.kind));

/** The living areas of an image that cover a thing of `kind` at a place. */
export function coveringAreas(areas: readonly CheckedArea[], imageId: string, lon: number, lat: number, kind: string): CheckedArea[] {
  return areas.filter((a) => a.deletedAt === null && a.imageId === imageId && coversKind(a, kind) && areaContains(a, lon, lat));
}

/** What an area is called in lists: 「確認範囲（船舶）」. */
export const areaLabel = (a: Pick<CheckedArea, 'kind'>): string => `確認範囲（${a.kind ? kindOf(pathOf(a.kind)) : 'すべて'}）`;

/** Where checked areas are kept. */
export interface AreaStore {
  readonly label: string;
  load(): Promise<CheckedArea[]>;
  save(list: readonly CheckedArea[]): Promise<void>;
  remove(list: readonly CheckedArea[], now?: number): Promise<CheckedArea[]>;
}

const DB = 'image-viewer-observation-areas';
const STORE = 'areas';

/** Checked areas in this browser (IndexedDB), one set per observation store. */
export class LocalAreaStore implements AreaStore {
  readonly label = 'このブラウザ';

  constructor(private readonly of: string) {}

  private open_(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB のオープン不可'));
    });
  }

  async load(): Promise<CheckedArea[]> {
    const db = await this.open_();
    try {
      const all = await new Promise<Array<CheckedArea & { store?: string }>>((resolve, reject) => {
        const request = db.transaction(STORE).objectStore(STORE).getAll();
        request.onsuccess = () => resolve(request.result as Array<CheckedArea & { store?: string }>);
        request.onerror = () => reject(request.error ?? new Error('読み込み不可'));
      });
      return all
        .filter((a) => a.store === this.of)
        .map((a) => {
          const own = { ...a };
          delete own.store;
          return own;
        });
    } finally {
      db.close();
    }
  }

  async save(list: readonly CheckedArea[]): Promise<void> {
    if (!list.length) return;
    const db = await this.open_();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        for (const a of list) store.put({ ...a, store: this.of });
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('ブラウザに保存不可'));
      });
    } finally {
      db.close();
    }
  }

  async remove(list: readonly CheckedArea[], now = Date.now()): Promise<CheckedArea[]> {
    const marked = list.map((a) => ({ ...a, deletedAt: now, updatedAt: now }));
    await this.save(marked);
    return marked;
  }
}

/** Asks an Esri layer for JSON (POST); throws with the reason when it cannot. */
export type AreaAsk = (url: string, params: Record<string, string>, token?: string) => Promise<unknown>;

type EsriPolygon = { attributes: Record<string, unknown>; geometry?: { rings?: number[][][] } | null };

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const msOf = (v: unknown): number | null => {
  const t = timeOf(v);
  return Number.isFinite(t) ? t : null;
};

/** Checked areas in an Esri polygon feature layer. */
export class EsriAreaStore implements AreaStore {
  private readonly oids_ = new Map<string, number>();
  private layer_: Promise<{ types: FieldTypes; oid: string }> | null = null;

  constructor(
    readonly label: string,
    private readonly config: AreaStoreConfig,
    private readonly ask: AreaAsk,
  ) {}

  private layer(): Promise<{ types: FieldTypes; oid: string }> {
    this.layer_ ??= (async () => {
      const json = (await this.ask(this.config.url, {}, this.config.token)) as { fields?: Array<{ name: string; type: string }>; objectIdField?: string };
      const types: FieldTypes = {};
      for (const f of json.fields ?? []) types[f.name] = f.type;
      if (!(this.config.fields.id in types)) throw new Error(`${this.label} に属性 ${this.config.fields.id} なし`);
      return { types, oid: json.objectIdField ?? json.fields?.find((f) => f.type === 'esriFieldTypeOID')?.name ?? 'OBJECTID' };
    })();
    this.layer_.catch(() => (this.layer_ = null));
    return this.layer_;
  }

  private featureOf(a: CheckedArea, types: FieldTypes, oid: string): EsriPolygon {
    const f = this.config.fields;
    const values: Record<string, unknown> = {
      [f.id]: a.id,
      [f.imageId]: a.imageId,
      [f.imageName]: a.imageName,
      [f.imageTime]: a.imageTime,
      [f.kind]: a.kind,
      [f.note]: a.note,
      [f.recordedBy]: a.recordedBy ?? '',
      [f.created]: a.createdAt,
      [f.updated]: a.updatedAt,
      [f.deleted]: a.deletedAt,
    };
    const attributes: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(values)) {
      if (!(name in types)) continue;
      attributes[name] = types[name] === 'esriFieldTypeString' && typeof value === 'number' && value > 1e11 ? new Date(value).toISOString() : value;
    }
    const id = this.oids_.get(a.id);
    if (id !== undefined) attributes[oid] = id;
    return { attributes, geometry: { rings: [a.ring], spatialReference: { wkid: 4326 } } as EsriPolygon['geometry'] };
  }

  async load(): Promise<CheckedArea[]> {
    const { oid } = await this.layer();
    const f = this.config.fields;
    const out: CheckedArea[] = [];
    for (let offset = 0; offset < 100000; ) {
      const json = (await this.ask(`${this.config.url}/query`, { where: '1=1', outFields: '*', returnGeometry: 'true', outSR: '4326', resultOffset: String(offset), resultRecordCount: '2000' }, this.config.token)) as {
        features?: EsriPolygon[];
        exceededTransferLimit?: boolean;
        error?: { message?: string };
      };
      if (json.error) throw new Error(json.error.message ?? '読み込み不可');
      const features = json.features ?? [];
      for (const feature of features) {
        const a = feature.attributes;
        const id = text(a[f.id]);
        const ring = feature.geometry?.rings?.[0];
        if (!id || !ring || ring.length < 4) continue;
        if (typeof a[oid] === 'number') this.oids_.set(id, a[oid] as number);
        const created = msOf(a[f.created]) ?? 0;
        out.push({ id, imageId: text(a[f.imageId]), imageName: text(a[f.imageName]), imageTime: msOf(a[f.imageTime]), ring, kind: text(a[f.kind]), note: text(a[f.note]), recordedBy: text(a[f.recordedBy]), createdAt: created, updatedAt: msOf(a[f.updated]) ?? created, deletedAt: msOf(a[f.deleted]) });
      }
      if (!json.exceededTransferLimit || !features.length) break;
      offset += features.length;
    }
    return out;
  }

  async save(list: readonly CheckedArea[]): Promise<void> {
    if (!list.length) return;
    const { types, oid } = await this.layer();
    const adds = list.filter((a) => !this.oids_.has(a.id));
    const updates = list.filter((a) => this.oids_.has(a.id));
    const json = (await this.ask(
      `${this.config.url}/applyEdits`,
      { adds: JSON.stringify(adds.map((a) => this.featureOf(a, types, oid))), updates: JSON.stringify(updates.map((a) => this.featureOf(a, types, oid))), rollbackOnFailure: 'false' },
      this.config.token,
    )) as { addResults?: Array<{ success: boolean; objectId?: number; error?: { description?: string } | null }>; updateResults?: Array<{ success: boolean; error?: { description?: string } | null }> };
    const failed: string[] = [];
    (json.addResults ?? []).forEach((r, k) => {
      if (r.success && typeof r.objectId === 'number') this.oids_.set(adds[k].id, r.objectId);
      else if (!r.success) failed.push(r.error?.description ?? '追加失敗');
    });
    for (const r of json.updateResults ?? []) if (!r.success) failed.push(r.error?.description ?? '更新失敗');
    if (failed.length) throw new Error(`${failed.length} 件の保存に失敗: ${failed[0]}`);
  }

  async remove(list: readonly CheckedArea[], now = Date.now()): Promise<CheckedArea[]> {
    const marked = list.map((a) => ({ ...a, deletedAt: now, updatedAt: now }));
    if (this.config.softDelete && this.config.fields.deleted in (await this.layer()).types) {
      await this.save(marked);
      return marked;
    }
    const ids = list.map((a) => this.oids_.get(a.id)).filter((v): v is number => v !== undefined);
    if (ids.length) await this.ask(`${this.config.url}/deleteFeatures`, { objectIds: ids.join(',') }, this.config.token);
    for (const a of list) this.oids_.delete(a.id);
    return [];
  }
}
