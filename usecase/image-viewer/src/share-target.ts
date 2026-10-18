/**
 * Files and text shared to the installed app from the operating system's
 * share sheet (the manifest's `share_target`). The service worker (sw.js)
 * takes the shared form, keeps its files and text in the Cache Storage under
 * an id, and opens the page at `?share=<id>`; the page picks them up here
 * once, and they are deleted.
 */

/** The cache the service worker keeps shared files in (not `image-viewer-…`: those are the site's versions). */
export const SHARE_CACHE = 'iv-share';
/** The page's parameter naming what was shared. */
export const SHARE_PARAM = 'share';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Most files taken from one share (the service worker keeps no more). */
export const MAX_SHARED_FILES = 100;
const MAX_TEXT = 200_000;

/** What was shared. */
export interface Shared {
  files: File[];
  title: string;
  text: string;
  url: string;
}

/** Whether `id` is an id the service worker gives (a UUID). */
export function isShareId(id: string | null): id is string {
  return id !== null && ID.test(id);
}

/** A file name to show and open by: no folders, no control characters, not too long. */
export function safeFileName(name: unknown, index: number): string {
  // eslint-disable-next-line no-control-regex
  const base = typeof name === 'string' ? name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(-200) : '';
  return base && base !== '.' && base !== '..' ? base : `共有されたファイル${index + 1}`;
}

/** Text of what was shared, capped; '' for anything else. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : '';
}

/**
 * Takes what was shared under `id` from the cache (and deletes it there);
 * null when there is nothing (already taken, or no Cache Storage).
 */
export async function takeShared(id: string, base = new URL('./', location.href).href): Promise<Shared | null> {
  if (!isShareId(id) || typeof caches === 'undefined') return null;
  const cache = await caches.open(SHARE_CACHE);
  const key = (part: string) => new URL(`share/${id}/${part}`, base).href;
  const metaResponse = await cache.match(key('meta'));
  if (!metaResponse) return null;
  let meta: { files?: unknown; title?: unknown; text?: unknown; url?: unknown };
  try {
    meta = (await metaResponse.json()) as typeof meta;
  } catch {
    meta = {};
  }
  const listed = Array.isArray(meta.files) ? meta.files.slice(0, MAX_SHARED_FILES) : [];
  const files: File[] = [];
  for (const [i, entry] of listed.entries()) {
    const response = await cache.match(key(String(i)));
    if (!response) continue;
    const blob = await response.blob();
    const { name, type } = (entry ?? {}) as { name?: unknown; type?: unknown };
    files.push(new File([blob], safeFileName(name, i), { type: typeof type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : '' }));
  }
  // Taken once: a reload does not open them again.
  for (const request of await cache.keys()) if (request.url.startsWith(key(''))) await cache.delete(request);
  return { files, title: textOf(meta.title), text: textOf(meta.text), url: textOf(meta.url) };
}
