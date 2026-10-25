/**
 * The classes' reference photos (参考写真): a URL is shown as it is; a file
 * added from this computer is kept in the browser (IndexedDB) and named
 * `local:<id>` in the classification, so it is seen only in this browser.
 */

const DB = 'image-viewer-taxon-photos';
const STORE = 'photos';
const PREFIX = 'local:';

/** Whether a photo is kept in this browser (not seen by others sharing the classification). */
export const isLocalPhoto = (ref: string): boolean => ref.startsWith(PREFIX);

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB のオープン不可'));
  });
}

async function run<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = act(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('写真の保存先の操作不可'));
    });
  } finally {
    db.close();
  }
}

/** Keeps a photo file in the browser; its reference. */
export async function addPhoto(file: Blob): Promise<string> {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  await run('readwrite', (s) => s.put(file, id));
  return `${PREFIX}${id}`;
}

/** Forgets a photo kept in the browser (a URL needs nothing). */
export async function removePhoto(ref: string): Promise<void> {
  if (isLocalPhoto(ref)) await run('readwrite', (s) => s.delete(ref.slice(PREFIX.length)));
}

const urls = new Map<string, string>();

/** The URL a photo is shown from; null when a browser-kept photo is not here. */
export async function photoUrl(ref: string): Promise<string | null> {
  if (!isLocalPhoto(ref)) return /^(https?:|data:image\/|blob:|\.{0,2}\/)/i.test(ref) ? ref : null;
  const had = urls.get(ref);
  if (had) return had;
  const blob = await run<Blob | undefined>('readonly', (s) => s.get(ref.slice(PREFIX.length)) as IDBRequest<Blob | undefined>).catch(() => undefined);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urls.set(ref, url);
  return url;
}

/** An image of a photo, filled in when it is read; a click shows it large. */
export function photoThumb(ref: string, title: string, onOpen: (url: string) => void): HTMLElement {
  const box = document.createElement('button');
  box.type = 'button';
  box.className = 'taxon-photo';
  box.title = title;
  box.setAttribute('aria-label', title);
  void photoUrl(ref).then((url) => {
    if (!url) {
      box.textContent = '写真なし';
      box.disabled = true;
      return;
    }
    const img = document.createElement('img');
    img.src = url;
    img.alt = title;
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    box.append(img);
    box.addEventListener('click', () => onOpen(url));
  });
  return box;
}

let viewer: HTMLDialogElement | null = null;

/** Shows a photo large, over everything; a click or Esc closes it. */
export function showPhoto(url: string, title: string): void {
  if (!viewer) {
    viewer = document.createElement('dialog');
    viewer.className = 'taxon-photo-view';
    viewer.addEventListener('click', () => viewer!.close());
    document.body.append(viewer);
  }
  const img = document.createElement('img');
  img.src = url;
  img.alt = title;
  img.referrerPolicy = 'no-referrer';
  const caption = document.createElement('p');
  caption.textContent = title;
  viewer.replaceChildren(img, caption);
  if (!viewer.open) viewer.showModal();
}
