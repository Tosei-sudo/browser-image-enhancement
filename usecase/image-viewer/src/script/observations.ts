/**
 * The observations (観測記録) for scripts: the records, things (with their
 * flows), images and checked areas read; records and checked areas added,
 * changed and deleted; the candidates of the same thing at a place; and the
 * report. Writes reach the store (an Esri layer shared with others, or the
 * browser) at once, so a run asks the person once before its first write.
 */
import type { ObservationPanel } from '../observation-panel.js';
import { living, timeKey, type ObjectFlow, type Observation } from '../observations.js';
import { boxRing, type CheckedArea } from '../observation-areas.js';
import { pathOf, within } from '../taxonomy.js';

/** What the viewer lends these functions (main.ts fills it). */
export interface ObservationScriptContext {
  observations?: () => ObservationPanel;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const opts = (v: unknown): Record<string, unknown> => {
  if (v === undefined || v === null) return {};
  if (!isRecord(v)) throw new TypeError('オプションはオブジェクトで指定');
  return v;
};
const num = (v: unknown, name: string, min = -Infinity, max = Infinity): number => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new TypeError(`${name} は数値で指定`);
  if (n < min || n > max) throw new RangeError(`${name} は ${min}〜${max} の範囲で指定`);
  return n;
};
const maybeNum = (v: unknown, name: string, min?: number, max?: number) => (v === undefined || v === null || v === '' ? undefined : num(v, name, min, max));
const str = (v: unknown, name: string): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new TypeError(`${name} は文字列で指定`);
  return v;
};
const time = (v: unknown, name: string): number => {
  const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : typeof v === 'string' ? new Date(v).getTime() : NaN;
  if (!Number.isFinite(ms)) throw new TypeError(`${name} は日時（Date、ミリ秒、または "2026-10-20T09:00" のような文字列）で指定`);
  return ms;
};
const iso = (t: number | null | undefined) => (t === null || t === undefined || !Number.isFinite(t) ? null : new Date(t).toISOString());

/** A record as a script sees it (times as ISO text). */
const recordOut = (o: Observation) => ({
  id: o.id,
  imageId: o.imageId,
  imageName: o.imageName,
  imageTime: iso(o.imageTime),
  objectId: o.objectId,
  objectName: o.objectName,
  kind: o.kind,
  activity: o.activity,
  present: o.present,
  confidence: o.confidence ?? '',
  note: o.note,
  lon: o.lon,
  lat: o.lat,
  length: o.length ?? null,
  heading: o.heading ?? null,
  recordedBy: o.recordedBy ?? '',
  updatedBy: o.updatedBy ?? '',
  createdAt: iso(o.createdAt),
  updatedAt: iso(o.updatedAt),
  deletedAt: iso(o.deletedAt),
});

const flowOut = (f: ObjectFlow) => {
  const last = f.observations[f.observations.length - 1];
  return {
    objectId: f.objectId,
    name: f.name,
    kind: f.kind,
    first: iso(f.first),
    last: iso(f.last),
    seen: f.seen,
    present: f.present,
    activity: f.activity,
    confidence: last.confidence ?? '',
    distance: Math.round(f.distance),
    lon: last.lon,
    lat: last.lat,
    steps: f.steps.map((s) => ({ from: iso(s.from), to: iso(s.to), present: s.present, activity: s.activity, images: s.count, moved: s.moved === null ? null : Math.round(s.moved) })),
  };
};

const areaOut = (a: CheckedArea) => ({ id: a.id, imageId: a.imageId, imageName: a.imageName, imageTime: iso(a.imageTime), kind: a.kind, note: a.note, recordedBy: a.recordedBy ?? '', polygon: { type: 'Polygon', coordinates: [a.ring] }, createdAt: iso(a.createdAt), deletedAt: iso(a.deletedAt) });

/** An outline from a script: `bbox` [西, 南, 東, 北], or `polygon` (a GeoJSON Polygon or one ring of [経度, 緯度]). */
function ringOf(o: Record<string, unknown>): number[][] {
  if (o.bbox !== undefined) {
    const b = o.bbox;
    if (!Array.isArray(b) || b.length !== 4 || !b.every((v) => typeof v === 'number' && Number.isFinite(v)) || b[0] > b[2] || b[1] > b[3]) throw new TypeError('bbox は [西, 南, 東, 北]（経緯度）で指定');
    return boxRing(b as number[]);
  }
  let ring: unknown = o.polygon;
  if (isRecord(ring) && ring.type === 'Feature') ring = ring.geometry;
  if (isRecord(ring) && ring.type === 'Polygon' && Array.isArray(ring.coordinates)) ring = ring.coordinates[0];
  if (!Array.isArray(ring) || ring.length < 3 || !ring.every((p) => Array.isArray(p) && p.length >= 2 && p.every((v) => typeof v === 'number' && Number.isFinite(v)))) throw new TypeError('範囲は bbox: [西, 南, 東, 北] か polygon（GeoJSON の Polygon、または [[経度, 緯度], …]）で指定');
  if (ring.length > 10_000) throw new RangeError('polygon の点は 10000 個まで');
  return (ring as number[][]).map((p) => [p[0], p[1]]);
}

/** The functions, made for one run: `download` counts a saved file against the run's limit. */
export function observationHandlers(ctx: ObservationScriptContext, download: () => void): Record<string, (...args: unknown[]) => unknown> {
  let allowed = false;
  const panel = async () => {
    const p = ctx.observations?.();
    if (!p) throw new Error('観測記録は使用不可');
    await p.loaded();
    if (!p.imageList().length) await p.refreshImages();
    return p;
  };
  /** A person agrees, once a run, to the script writing into the store. */
  const mayWrite = (p: ObservationPanel) => {
    if (allowed) return;
    if (!confirm(`スクリプトが観測記録（保存先: ${p.storeLabel()}）に書き込もうとしています。許可しますか？（この実行の間のみ有効）`)) throw new Error('観測記録への書き込みを取り消し');
    allowed = true;
  };
  const recordOf = (p: ObservationPanel, id: unknown) => {
    const found = p.records().find((o) => o.id === id && o.deletedAt === null);
    if (!found) throw new Error(`観測記録「${String(id)}」なし`);
    return found;
  };
  return {
    observations: async (options?: unknown) => {
      const p = await panel();
      const o = opts(options);
      const image = str(o.image, 'image');
      const object = str(o.object, 'object');
      const kind = o.kind !== undefined ? pathOf(String(o.kind)) : null;
      const from = o.from !== undefined ? time(o.from, 'from') : null;
      const to = o.to !== undefined ? time(o.to, 'to') : null;
      return (o.deleted ? p.records() : living(p.records()))
        .filter((r) => (image === undefined || r.imageId === image) && (object === undefined || r.objectId === object || r.objectName === object) && (!kind?.length || within(r.kind, kind)) && (from === null || timeKey(r) >= from) && (to === null || timeKey(r) <= to))
        .map(recordOut);
    },
    observedThings: async (options?: unknown) => {
      const p = await panel();
      const o = opts(options);
      const kind = o.kind !== undefined ? pathOf(String(o.kind)) : null;
      return p.flows().filter((f) => !kind?.length || within(f.kind, kind)).map(flowOut);
    },
    observationImages: async () => (await panel()).imageList().map((i) => ({ id: i.id, name: i.name, time: iso(i.time), file: i.file, current: i.current, bbox: i.box })),
    observeImage: async (id: unknown) => {
      const p = await panel();
      if (!p.goToImage(String(id))) throw new Error(`画像「${String(id)}」なし（viewer.observationImages() で一覧可能）`);
      return true;
    },
    confidences: async () => (await panel()).confidences().map((c) => ({ ...c })),
    observationCandidates: async (options?: unknown) => {
      const p = await panel();
      const o = opts(options);
      const at = { lon: num(o.lon, 'lon', -180, 180), lat: num(o.lat, 'lat', -90, 90), kind: str(o.kind, 'kind'), length: maybeNum(o.length, 'length', 0) ?? null, heading: maybeNum(o.heading, 'heading', -360, 360) ?? null };
      const image = str(o.image, 'image');
      if (image !== undefined && !p.imageList().some((i) => i.id === image)) throw new Error(`画像「${image}」なし`);
      return p.candidates(at, image).map((c) => ({ objectId: c.objectId, name: c.name, kind: c.kind, distance: Math.round(c.distance), score: Math.round(c.score * 1000) / 1000, reasons: c.reasons, record: recordOut(c.from) }));
    },
    addObservation: async (values?: unknown) => {
      const p = await panel();
      const o = opts(values);
      const image = str(o.image, 'image');
      if (image !== undefined ? !p.imageList().some((i) => i.id === image) : !p.current()) throw new Error(image !== undefined ? `画像「${image}」なし` : '記録する画像なし（画像を開くか image で指定）');
      const levels = p.confidences().map((c) => c.label);
      const confidence = str(o.confidence, 'confidence');
      if (confidence && !levels.includes(confidence)) throw new Error(`確度「${confidence}」なし（${levels.join('・')}）`);
      mayWrite(p);
      const record = await p.add({
        lon: num(o.lon, 'lon', -180, 180),
        lat: num(o.lat, 'lat', -90, 90),
        image,
        object: str(o.object, 'object'),
        kind: str(o.kind, 'kind'),
        activity: str(o.activity, 'activity'),
        confidence,
        note: str(o.note, 'note'),
        present: o.present === undefined ? true : Boolean(o.present),
        length: maybeNum(o.length, 'length', 0),
        heading: maybeNum(o.heading, 'heading', -360, 360),
      });
      if (!record || !p.records().some((r) => r.id === record.id)) throw new Error('観測記録の保存失敗');
      return recordOut(p.records().find((r) => r.id === record.id)!);
    },
    updateObservation: async (id: unknown, changes?: unknown) => {
      const p = await panel();
      recordOf(p, id);
      const c = opts(changes);
      const out: Parameters<ObservationPanel['update']>[1] = {};
      for (const key of ['kind', 'activity', 'confidence', 'note'] as const) if (c[key] !== undefined) out[key] = str(c[key], key)!;
      if (c.present !== undefined) out.present = Boolean(c.present);
      if (c.lon !== undefined) out.lon = num(c.lon, 'lon', -180, 180);
      if (c.lat !== undefined) out.lat = num(c.lat, 'lat', -90, 90);
      if (c.length !== undefined) out.length = maybeNum(c.length, 'length', 0) ?? null;
      if (c.heading !== undefined) out.heading = maybeNum(c.heading, 'heading', -360, 360) ?? null;
      const unknown = Object.keys(c).filter((k) => !['kind', 'activity', 'confidence', 'note', 'present', 'lon', 'lat', 'length', 'heading'].includes(k));
      if (unknown.length) throw new Error(`変更できない項目: ${unknown.join(', ')}（モノの名前は renameObservedThing で）`);
      mayWrite(p);
      const record = await p.update(String(id), out);
      return record ? recordOut(record) : null;
    },
    renameObservedThing: async (objectId: unknown, name: unknown) => {
      const p = await panel();
      const n = str(name, 'name')?.trim();
      if (!n) throw new TypeError('name を指定');
      if (!p.records().some((o) => o.objectId === objectId)) throw new Error(`モノ「${String(objectId)}」なし`);
      mayWrite(p);
      await p.rename(String(objectId), n);
      return true;
    },
    deleteObservations: async (ids: unknown) => {
      const p = await panel();
      const list = (Array.isArray(ids) ? ids : [ids]).map((id) => recordOf(p, id));
      mayWrite(p);
      await p.remove(list);
      return list.length;
    },
    checkedAreas: async (options?: unknown) => {
      const p = await panel();
      const o = opts(options);
      const image = str(o.image, 'image');
      return p
        .areas()
        .filter((a) => (o.deleted || a.deletedAt === null) && (image === undefined || a.imageId === image))
        .map(areaOut);
    },
    addCheckedArea: async (values?: unknown) => {
      const p = await panel();
      const o = opts(values);
      const image = str(o.image, 'image');
      if (image !== undefined ? !p.imageList().some((i) => i.id === image) : !p.current()) throw new Error(image !== undefined ? `画像「${image}」なし` : '記録する画像なし（画像を開くか image で指定）');
      const ring = ringOf(o);
      mayWrite(p);
      const area = await p.addArea({ ring, kind: str(o.kind, 'kind'), note: str(o.note, 'note'), image });
      if (!area) throw new Error('確認範囲の保存失敗');
      return areaOut(area);
    },
    deleteCheckedAreas: async (ids: unknown) => {
      const p = await panel();
      const want = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
      const list = p.areas().filter((a) => want.has(a.id) && a.deletedAt === null);
      if (list.length !== want.size) throw new Error('確認範囲の ID に該当なし');
      mayWrite(p);
      await p.removeAreas(list);
      return list.length;
    },
    observationReport: async (options?: unknown) => {
      const p = await panel();
      const o = opts(options);
      const report = {
        ...(o.title !== undefined ? { title: str(o.title, 'title')!.slice(0, 200) } : {}),
        ...(o.from !== undefined ? { from: o.from === null ? null : time(o.from, 'from') } : {}),
        ...(o.to !== undefined ? { to: o.to === null ? null : time(o.to, 'to') } : {}),
        ...(o.kind !== undefined ? { kind: String(o.kind) } : {}),
        ...(o.confidence !== undefined ? { confidence: String(o.confidence) } : {}),
        ...Object.fromEntries((['map', 'flows', 'areas', 'records'] as const).filter((k) => o[k] !== undefined).map((k) => [k, Boolean(o[k])])),
      };
      if (o.save === false) {
        const { html, things, records } = await p.report(report);
        return { html, things, records };
      }
      download();
      const { things, records } = await p.report({ ...report, map: false });
      await p.saveReport(report);
      return { things, records };
    },
  };
}
