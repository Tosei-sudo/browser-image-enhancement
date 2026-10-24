/**
 * Watches on image catalogs: conditions saved in advance (points or areas,
 * the sensor, an angle limit, a SQL condition) that the viewer checks the
 * catalog against again and again, turning each image that newly matches into
 * a notice (the app icon's badge and the notification centre, watch-panel.ts).
 *
 * The page checks while it is open (and as it starts, for what came while it
 * was closed); the installed app's service worker also checks with Periodic
 * Background Sync where the browser offers it (Chrome and Edge, installed
 * app only, at times the browser chooses). Both read and write the same
 * IndexedDB database, so this module uses neither OpenLayers nor the page:
 * vite.config.ts bundles it into sw.js as well.
 */
import type { CatalogConfig } from './catalog.js';
import { emptySearch, timeOf, utcText, whereOf, type CatalogSearch, type FieldTypes } from './catalog-query.js';

/**
 * Where the images must be, in longitude / latitude: on one of the points (POIs, `[lon, lat]`), or over
 * the polygon (AOIs, every ring of every area in one Esri polygon: outer rings clockwise, holes anticlockwise).
 */
export type WatchArea = { kind: 'points'; points: number[][] } | { kind: 'polygon'; rings: number[][][] };

/** The conditions of a watch other than the area (the catalog search's, without its dates). */
export type WatchConditions = Pick<CatalogSearch, 'sensor' | 'maxAngle' | 'azimuthFrom' | 'azimuthTo' | 'where'>;

export interface CatalogWatch {
  id: string;
  name: string;
  /** The catalog as config.json had it when the watch was made (the service worker has no config.json). */
  catalog: CatalogConfig;
  /** The catalog layer's field types, for the date condition. */
  types: FieldTypes;
  conditions: WatchConditions;
  /** Asked one after another, an image on any of them matching; empty: anywhere. */
  areas: WatchArea[];
  enabled: boolean;
  created: number;
  /** When the catalog was last asked; null before the first check (which only notes what is already there). */
  lastChecked: number | null;
  /** When a check was last tried (worked or not), for when the next is due. */
  lastTried?: number;
  /** Why the last check failed; absent when it worked. */
  lastError?: string;
  /** The keys of the images already seen, oldest first. */
  seen: string[];
}

/** An Esri feature as the query gives it (outSR 4326). */
export interface EsriFeature {
  attributes: Record<string, unknown>;
  geometry?: unknown;
}

/** An image that newly matched a watch. */
export interface WatchNotice {
  /** `watch id` + `image key`. */
  id: string;
  watchId: string;
  watchName: string;
  catalogLabel: string;
  /** When the viewer found it. */
  found: number;
  read: boolean;
  /** The image's id, when it was taken and its sensor, for the list. */
  imageId: string;
  acquired: unknown;
  sensor: string;
  feature: EsriFeature;
  /** `plan`: a reminder of a planned shot (imaging-plan-remind.ts) rather than a new image; it has nothing to open. */
  kind?: 'plan';
}

/** How many image keys a watch remembers. */
const MAX_SEEN = 5000;
/** The most images one check asks for. */
const MAX_FOUND = 1000;
const DAY = 24 * 60 * 60 * 1000;

/** The field telling how new an image is, and how far back a check looks before its last one (registration can lag). */
export function newnessOf(catalog: CatalogConfig): { field: string; margin: number } | null {
  const { systemRegistered, registered, acquired } = catalog.fields;
  if (systemRegistered ?? registered) return { field: (systemRegistered ?? registered)!, margin: 3 * DAY };
  // Images are often registered days after they were taken.
  if (acquired) return { field: acquired, margin: 30 * DAY };
  return null;
}

/** `field` at or after `time`, written for the field's type. */
export function sinceCondition(field: string, type: string | undefined, time: number): string {
  if (type === 'esriFieldTypeDateOnly') return `${field} >= DATE '${utcText(time).slice(0, 10)}'`;
  if (type && /Integer|Double|Single/.test(type)) return `${field} >= ${Math.floor(time)}`;
  if (type === 'esriFieldTypeString') return `${field} >= '${utcText(time).slice(0, 10)}'`;
  return `${field} >= TIMESTAMP '${utcText(time)}'`;
}

/** The query of one check over `area` (anywhere when null): the watch's conditions and the images since `since` (ms). */
export function watchQuery(watch: CatalogWatch, since: number | null, area: WatchArea | null = watch.areas[0] ?? null): Record<string, string> {
  const { catalog, types, conditions } = watch;
  const parts = [whereOf(catalog, types, { ...emptySearch, ...conditions })].filter((w) => w !== '1=1');
  const newness = newnessOf(catalog);
  if (newness && since !== null) parts.push(sinceCondition(newness.field, types[newness.field], since - newness.margin));
  const params: Record<string, string> = { where: parts.length ? parts.join(' AND ') : '1=1', outFields: '*', returnGeometry: 'true', outSR: '4326' };
  if (area) {
    const one = area.kind === 'points' && area.points.length === 1;
    params.geometry = JSON.stringify(
      one
        ? { x: area.points[0][0], y: area.points[0][1], spatialReference: { wkid: 4326 } }
        : area.kind === 'points'
          ? { points: area.points, spatialReference: { wkid: 4326 } }
          : { rings: area.rings, spatialReference: { wkid: 4326 } },
    );
    params.geometryType = one ? 'esriGeometryPoint' : area.kind === 'points' ? 'esriGeometryMultipoint' : 'esriGeometryPolygon';
    params.inSR = '4326';
    params.spatialRel = 'esriSpatialRelIntersects';
  }
  return params;
}

/** Asks an Esri layer (`url` + `/query`…) for JSON; throws with the reason when it cannot. */
export type EsriAsk = (url: string, params: Record<string, string>, token?: string) => Promise<unknown>;

/** A plain {@link EsriAsk} (POST, the catalog's own token), for the service worker. */
export const plainAsk: EsriAsk = async (url, params, token) => {
  const body = new URLSearchParams({ ...params, f: 'json', ...(token ? { token } : {}) });
  const response = await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!json) throw new Error('応答が JSON 以外');
  if (json.error) throw new Error(`サービスからエラー応答: ${json.error.message ?? ''}`);
  return json;
};

/** The key that tells one image from another: its id, else its object id. */
function keyOf(feature: EsriFeature, catalog: CatalogConfig, objectIdField: string | undefined): string {
  const a = feature.attributes ?? {};
  const value = (catalog.fields.id && a[catalog.fields.id]) ?? (objectIdField && a[objectIdField]) ?? a.OBJECTID ?? a.FID ?? a.objectid;
  return value === undefined || value === null || value === '' ? JSON.stringify(a) : String(value);
}

/** What one check found: the watch as it is after it, and its new notices. */
export interface CheckResult {
  watch: CatalogWatch;
  notices: WatchNotice[];
}

/**
 * Asks the catalog once for `watch`. The first check only notes the images
 * already there; later ones turn each image not seen before into a notice.
 * A failure is kept in `lastError` (and `lastChecked` stays as it was, so
 * nothing is missed once it works again).
 */
export async function checkWatch(watch: CatalogWatch, ask: EsriAsk, now = Date.now()): Promise<CheckResult> {
  const { catalog } = watch;
  const since = watch.lastChecked ?? watch.created;
  const newness = newnessOf(catalog);
  type Answer = { features?: EsriFeature[]; objectIdFieldName?: string };
  const answers: Answer[] = [];
  try {
    // Points and polygons are separate geometries of the query: one question each.
    for (const area of watch.areas.length ? watch.areas : [null]) {
      const params = watchQuery(watch, since, area);
      try {
        answers.push((await ask(`${catalog.url}/query`, { ...params, ...(newness ? { orderByFields: `${newness.field} DESC` } : {}), resultRecordCount: String(MAX_FOUND) }, catalog.token)) as Answer);
      } catch {
        // Older services refuse ordering or paging.
        answers.push((await ask(`${catalog.url}/query`, params, catalog.token)) as Answer);
      }
    }
  } catch (error) {
    return { watch: { ...watch, lastTried: now, lastError: error instanceof Error ? error.message : String(error) }, notices: [] };
  }
  const seen = new Set(watch.seen);
  const notices: WatchNotice[] = [];
  const keys: string[] = [];
  for (const [feature, objectIdField] of answers.flatMap((json) => (json.features ?? []).map((f) => [f, json.objectIdFieldName] as const))) {
    if (!feature || typeof feature !== 'object') continue;
    const key = keyOf(feature, catalog, objectIdField);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
    if (watch.lastChecked === null) continue;
    const a = feature.attributes ?? {};
    const get = (name?: string) => (name ? a[name] : undefined);
    notices.push({
      id: `${watch.id}|${key}`,
      watchId: watch.id,
      watchName: watch.name,
      catalogLabel: catalog.label,
      found: now,
      read: false,
      imageId: String(get(catalog.fields.id) ?? key),
      acquired: get(catalog.fields.acquired) ?? null,
      sensor: get(catalog.fields.sensor) == null ? '' : String(get(catalog.fields.sensor)),
      feature,
    });
  }
  // Newest first in the centre, as the catalog lists them.
  notices.sort((x, y) => (timeOf(y.acquired) || 0) - (timeOf(x.acquired) || 0));
  const remembered = [...watch.seen, ...keys].slice(-MAX_SEEN);
  const rest = { ...watch };
  delete rest.lastError;
  return { watch: { ...rest, lastChecked: now, lastTried: now, seen: remembered }, notices };
}

/** `areas` and `more` as one list: points joined into one set of points, rings into one polygon. */
export function joinAreas(areas: WatchArea[], more: WatchArea[]): WatchArea[] {
  const points = [...areas, ...more].flatMap((a) => (a.kind === 'points' ? a.points : []));
  const rings = [...areas, ...more].flatMap((a) => (a.kind === 'polygon' ? a.rings : []));
  return [...(points.length ? [{ kind: 'points' as const, points }] : []), ...(rings.length ? [{ kind: 'polygon' as const, rings }] : [])];
}

/**
 * `watch` with `more` areas: the images already over them are noted first
 * (as a new watch's first check does), so only images new to them are notified.
 */
export async function addAreas(watch: CatalogWatch, more: WatchArea[], ask: EsriAsk, now = Date.now()): Promise<CatalogWatch> {
  if (!watch.areas.length) return watch;
  const first = await checkWatch({ ...watch, areas: more, lastChecked: null, created: watch.lastChecked ?? watch.created }, ask, now);
  if (first.watch.lastError) throw new Error(first.watch.lastError);
  return { ...watch, areas: joinAreas(watch.areas, more), seen: [...new Set([...watch.seen, ...first.watch.seen])].slice(-MAX_SEEN) };
}

// ------------------------------------------------------------ the database

const DB = 'image-viewer-catalog-watch';
const WATCHES = 'watches';
const NOTICES = 'notices';
/** The most notices kept; the oldest go first. */
const MAX_NOTICES = 500;
/** Tells the page's windows (and the worker's) that watches or notices changed. */
export const WATCH_CHANNEL = 'image-viewer-catalog-watch';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(WATCHES)) db.createObjectStore(WATCHES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(NOTICES)) db.createObjectStore(NOTICES, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB のオープン不可'));
  });
}

/** Runs `work` in one transaction over `stores` and resolves with its result once committed. */
async function inStores<T>(stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T> | T): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction(stores, mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('IndexedDB への書き込み不可'));
    });
    const result = await work(tx);
    await done;
    return result;
  } finally {
    db.close();
  }
}

const all = <T>(store: IDBObjectStore) =>
  new Promise<T[]>((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });

export const listWatches = (): Promise<CatalogWatch[]> =>
  inStores([WATCHES], 'readonly', (tx) => all<CatalogWatch>(tx.objectStore(WATCHES))).then((w) => w.sort((a, b) => a.created - b.created));

/** The notices, newest first. */
export const listNotices = (): Promise<WatchNotice[]> =>
  inStores([NOTICES], 'readonly', (tx) => all<WatchNotice>(tx.objectStore(NOTICES))).then((n) => n.sort((a, b) => b.found - a.found || (timeOf(b.acquired) || 0) - (timeOf(a.acquired) || 0)));

export const putWatch = (watch: CatalogWatch): Promise<void> => inStores([WATCHES], 'readwrite', (tx) => void tx.objectStore(WATCHES).put(watch)).then(changed);

/** Deletes a watch with its notices. */
export async function deleteWatch(id: string): Promise<void> {
  const notices = await listNotices();
  await inStores([WATCHES, NOTICES], 'readwrite', (tx) => {
    tx.objectStore(WATCHES).delete(id);
    for (const n of notices) if (n.watchId === id) tx.objectStore(NOTICES).delete(n.id);
  });
  await changed();
}

/** Adds notices made elsewhere (the imaging plan's reminders), keeping at most the usual number. */
export async function addNotices(notices: WatchNotice[]): Promise<void> {
  if (!notices.length) return;
  const existing = (await listNotices()).map((n) => n.id);
  await inStores([NOTICES], 'readwrite', (tx) => {
    for (const n of notices) tx.objectStore(NOTICES).put(n);
    const extra = existing.length + notices.length - MAX_NOTICES;
    for (const id of extra > 0 ? existing.slice(-extra) : []) tx.objectStore(NOTICES).delete(id);
  });
  await changed();
}

/** Marks notices read (all when `ids` is not given). */
export async function markRead(ids?: string[]): Promise<void> {
  const notices = await listNotices();
  const which = ids ? new Set(ids) : null;
  await inStores([NOTICES], 'readwrite', (tx) => {
    for (const n of notices) if (!n.read && (!which || which.has(n.id))) tx.objectStore(NOTICES).put({ ...n, read: true });
  });
  await changed();
}

/** Deletes notices (all when `ids` is not given). */
export async function deleteNotices(ids?: string[]): Promise<void> {
  await inStores([NOTICES], 'readwrite', (tx) => {
    if (!ids) tx.objectStore(NOTICES).clear();
    else for (const id of ids) tx.objectStore(NOTICES).delete(id);
  });
  await changed();
}

/** Puts the number of unread notices on the app's icon (where the browser can). */
export async function updateBadge(): Promise<number> {
  const unread = (await listNotices()).filter((n) => !n.read).length;
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  try {
    if (unread) await nav?.setAppBadge?.(unread);
    else await nav?.clearAppBadge?.();
  } catch {
    // Not an installed app, or the badge is not offered: the centre still counts.
  }
  return unread;
}

/** Updates the badge and tells the other windows. */
async function changed(): Promise<void> {
  await updateBadge();
  try {
    const channel = new BroadcastChannel(WATCH_CHANNEL);
    channel.postMessage({ type: 'changed' });
    channel.close();
  } catch {
    // No BroadcastChannel: only this window updates.
  }
}

/**
 * Checks the enabled watches last checked longer than `interval` ms ago (all
 * of them when `force`), keeping their notices. One window or worker checks
 * at a time (Web Locks); the others skip. Resolves with the number of new
 * notices, or null when another was checking.
 */
export async function checkDue(ask: EsriAsk, interval: number, force = false): Promise<number | null> {
  const run = async (): Promise<number> => {
    const now = Date.now();
    const due = (await listWatches()).filter((w) => w.enabled && (force || (w.lastTried ?? w.lastChecked) == null || now - (w.lastTried ?? w.lastChecked)! >= interval - 5000));
    let added = 0;
    for (const watch of due) {
      const { watch: after, notices } = await checkWatch(watch, ask);
      const existing = (await listNotices()).map((n) => n.id);
      await inStores([WATCHES, NOTICES], 'readwrite', (tx) => {
        // The watch may have been deleted or changed meanwhile: keep what the person did, add what was found.
        const watches = tx.objectStore(WATCHES);
        const request = watches.get(watch.id);
        request.onsuccess = () => {
          const current = request.result as CatalogWatch | undefined;
          if (!current) return;
          watches.put({ ...after, name: current.name, enabled: current.enabled, conditions: current.conditions, areas: current.areas, seen: [...new Set([...current.seen, ...after.seen])].slice(-MAX_SEEN) });
          for (const n of notices) tx.objectStore(NOTICES).put({ ...n, watchName: current.name });
        };
        const extra = existing.length + notices.length - MAX_NOTICES;
        for (const id of extra > 0 ? existing.slice(-extra) : []) tx.objectStore(NOTICES).delete(id);
      });
      added += notices.length;
    }
    if (due.length) await changed();
    return added;
  };
  const locks = (globalThis as { navigator?: Navigator }).navigator?.locks;
  if (!locks) return run();
  return locks.request('image-viewer-catalog-watch', { ifAvailable: true }, (lock) => (lock ? run() : null));
}

/** The tag of the Periodic Background Sync the installed app registers. */
export const SYNC_TAG = 'catalog-watch';
