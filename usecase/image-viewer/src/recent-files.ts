/**
 * Opening files through the File System Access API, where the browser has it
 * (Chrome, Edge): the files chosen or dropped are remembered by their handles,
 * so they open again from the 「最近」 menu after a reload without being
 * chosen again, only allowed. Nothing is copied: like a file from the
 * ordinary chooser, a large GeoTIFF is read a tile at a time from the disk.
 *
 * Files chosen together (an image and its .RPB, a Shapefile's parts) are
 * remembered and opened again together.
 */
import { ContextMenu } from './context-menu.js';

/** The File System Access API's file picker, where there is one. */
type OpenFilePicker = (options?: {
  multiple?: boolean;
  id?: string;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}) => Promise<FileSystemFileHandle[]>;

interface PermissionHandle extends FileSystemFileHandle {
  queryPermission?: (options: { mode: 'read' }) => Promise<PermissionState>;
  requestPermission?: (options: { mode: 'read' }) => Promise<PermissionState>;
}

/** Files opened together, as remembered. */
export interface RecentEntry {
  id?: number;
  handles: FileSystemFileHandle[];
  /** When they were last opened (ms since the epoch). */
  opened: number;
}

const DB = 'image-viewer';
const STORE = 'recent';
/** How many sets of files are remembered. */
export const MAX_RECENT = 10;

/** Whether the browser can pick files with handles (and keep them in IndexedDB). */
export function hasFileAccess(): boolean {
  return typeof (window as { showOpenFilePicker?: unknown }).showOpenFilePicker === 'function' && typeof indexedDB !== 'undefined';
}

/**
 * Asks for files with the File System Access picker. Empty when the person
 * cancels. `accept` is the chooser's list (`.tif,.tiff,image/*,…`).
 */
export async function pickFiles(accept: string): Promise<FileSystemFileHandle[]> {
  const extensions = accept.split(',').map((a) => a.trim()).filter((a) => a.startsWith('.'));
  const picker = (window as unknown as { showOpenFilePicker: OpenFilePicker }).showOpenFilePicker;
  try {
    return await picker({
      multiple: true,
      id: 'image-viewer',
      types: [{ description: '画像・GeoTIFF・ベクター・標高・RPC', accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'], 'application/octet-stream': extensions } }],
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return [];
    throw error;
  }
}

/** The handles of files dropped on `element`, collected while the drop event lasts (they cannot be read later). */
export function onDroppedHandles(element: HTMLElement, take: (handles: FileSystemFileHandle[]) => void): void {
  element.addEventListener(
    'drop',
    (e) => {
      const items = Array.from(e.dataTransfer?.items ?? []).filter((item) => item.kind === 'file');
      type WithHandle = DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> };
      const pending = items.map((item) => (item as WithHandle).getAsFileSystemHandle?.() ?? Promise.resolve(null));
      if (!pending.length) return;
      void Promise.all(pending.map((p) => p.catch(() => null))).then((handles) => {
        const files = handles.filter((h): h is FileSystemFileHandle => h?.kind === 'file');
        if (files.length) take(files);
      });
    },
    true,
  );
}

/** The remembered sets of files, newest first, in IndexedDB. */
export class RecentFiles {
  private db_: Promise<IDBDatabase> | null = null;

  /** All remembered sets, newest first. */
  async list(): Promise<RecentEntry[]> {
    const all = await this.request_<RecentEntry[]>('readonly', (store) => store.getAll());
    return all.sort((a, b) => b.opened - a.opened);
  }

  /** Remembers `handles` as opened now, in place of an earlier entry of the same files; keeps the newest {@link MAX_RECENT}. */
  async add(handles: FileSystemFileHandle[]): Promise<void> {
    if (!handles.length) return;
    const entries = await this.list();
    const same: RecentEntry[] = [];
    for (const entry of entries) if (await sameFiles(entry.handles, handles)) same.push(entry);
    const old = [...same, ...entries.filter((e) => !same.includes(e)).slice(MAX_RECENT - 1)];
    await this.request_('readwrite', (store) => {
      for (const entry of old) if (entry.id !== undefined) store.delete(entry.id);
      return store.add({ handles, opened: Date.now() } satisfies RecentEntry);
    });
  }

  /** Forgets one entry. */
  async remove(entry: RecentEntry): Promise<void> {
    if (entry.id !== undefined) await this.request_('readwrite', (store) => store.delete(entry.id!));
  }

  /** Forgets them all. */
  async clear(): Promise<void> {
    await this.request_('readwrite', (store) => store.clear());
  }

  private open_(): Promise<IDBDatabase> {
    this.db_ ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.db_;
  }

  private async request_<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this.open_();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result as T);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
}

async function sameFiles(a: FileSystemFileHandle[], b: FileSystemFileHandle[]): Promise<boolean> {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!(await a[i].isSameEntry(b[i]).catch(() => false))) return false;
  return true;
}

/**
 * The files of an entry, after asking to read them again where the browser
 * no longer allows it (it asks once per file, on this click). Files that are
 * gone or not allowed are listed in `missing`.
 */
export async function readEntry(entry: RecentEntry): Promise<{ files: File[]; missing: string[] }> {
  const files: File[] = [];
  const missing: string[] = [];
  for (const handle of entry.handles as PermissionHandle[]) {
    try {
      let state = (await handle.queryPermission?.({ mode: 'read' })) ?? 'granted';
      if (state !== 'granted') state = (await handle.requestPermission?.({ mode: 'read' })) ?? 'denied';
      if (state !== 'granted') throw new Error('not allowed');
      files.push(await handle.getFile());
    } catch {
      missing.push(handle.name);
    }
  }
  return { files, missing };
}

/** A label for an entry: its file names, the first few. */
export function entryLabel(entry: RecentEntry): string {
  const names = entry.handles.map((h) => h.name);
  return names.length > 3 ? `${names.slice(0, 3).join('、')} ほか ${names.length - 3} 件` : names.join('、');
}

export interface RecentMenuOptions {
  /** Opens the files of an entry (as if chosen). */
  open: (files: File[]) => void;
  say: (message: string) => void;
}

/** The 「最近」 button and its menu of remembered files. */
export class RecentMenu {
  readonly button = document.createElement('button');
  private readonly menu_ = new ContextMenu('最近開いたファイル');

  constructor(
    private readonly recent: RecentFiles,
    private readonly options: RecentMenuOptions,
  ) {
    const b = this.button;
    b.type = 'button';
    b.className = 'recent-button';
    b.textContent = '最近';
    b.title = '最近開いたファイルを開き直します';
    b.setAttribute('aria-haspopup', 'menu');
    b.addEventListener('click', () => void this.show_());
  }

  /** Remembers `handles` (just opened). */
  async remember(handles: FileSystemFileHandle[]): Promise<void> {
    try {
      await this.recent.add(handles);
    } catch (error) {
      console.warn('最近開いたファイルを記録できませんでした', error);
    }
  }

  private async show_(): Promise<void> {
    if (this.menu_.isOpen()) return this.menu_.close();
    const entries = await this.recent.list().catch(() => []);
    const rect = this.button.getBoundingClientRect();
    this.menu_.open(
      entries.length
        ? [
            ...entries.map((entry) => ({ label: entryLabel(entry), run: () => void this.reopen_(entry) })),
            { label: '履歴を消去', danger: true, run: () => void this.recent.clear().then(() => this.options.say('最近開いたファイルの履歴を消去しました')) },
          ]
        : [{ label: '最近開いたファイルはありません', disabled: true, run: () => {} }],
      rect.left,
      rect.bottom + 2,
    );
  }

  private async reopen_(entry: RecentEntry): Promise<void> {
    const { files, missing } = await readEntry(entry);
    if (missing.length) this.options.say(`${missing.join('、')} を開けませんでした（移動・削除されたか、読み取りが許可されていません）`);
    if (!files.length) {
      if (missing.length === entry.handles.length) await this.recent.remove(entry).catch(() => {});
      return;
    }
    await this.remember(entry.handles);
    this.options.open(files);
  }
}
