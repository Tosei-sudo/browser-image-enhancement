/**
 * Opening images an image catalog knows only by a local path (`\\nas\img\…`,
 * `Z:\…`, `/mnt/…`). A browser cannot open a path itself, so `config.json`'s
 * `pathMappings` say what each path prefix stands for:
 *
 * - with `url`, the same folder served over HTTP: the rest of the path is
 *   added to the URL and the image opens as a COG;
 * - without, a folder the person allows once with the File System Access
 *   API (Chrome, Edge): its handle is kept in IndexedDB like 「最近」, so
 *   later visits only ask to allow reading again. The rest of the path is
 *   followed inside it, and the image opens like a local file (read a tile
 *   at a time), with its .ovr, .RPB / _RPC.TXT and .IMD beside it.
 */

/** One prefix of local paths and what it stands for. */
export interface PathMapping {
  /** The start of the paths, as the catalog writes them (`\\nas\img`, `Z:\images`). Case and `\` / `/` do not matter. */
  prefix: string;
  /** The folder's name when asking for it. */
  label: string;
  /** The same folder over HTTP (`https://nas-web/img/`); none to ask for the folder in the browser. */
  url?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The mapping of one `pathMappings` entry; null (with the reason in `problems`) when it cannot be used. */
export function pathMappingOf(value: unknown, problems: string[], index: number): PathMapping | null {
  const at = `pathMappings[${index}]`;
  if (!isRecord(value)) return (problems.push(`${at} がオブジェクトではありません`), null);
  const { prefix, label, url } = value;
  if (typeof prefix !== 'string' || pathParts(prefix).length === 0) return (problems.push(`${at} に prefix（パスの先頭）がありません`), null);
  if (url !== undefined && (typeof url !== 'string' || !/^(https?:)?\/\/|^\.{0,2}\//.test(url))) {
    return (problems.push(`${at} の url は http(s) か相対パスの URL にしてください`), null);
  }
  return {
    prefix,
    label: typeof label === 'string' && label ? label : prefix,
    ...(typeof url === 'string' ? { url } : {}),
  };
}

/**
 * The parts of a path: `\\nas\img\a.tif` → `['//nas', 'img', 'a.tif']`,
 * `C:\x\a.tif` → `['c:', 'x', 'a.tif']` (drive letters in lower case),
 * `/mnt/a.tif` → `['/', 'mnt', 'a.tif']`; `file://` URLs as the path they name.
 */
export function pathParts(path: string): string[] {
  let text = path.trim();
  const file = /^file:(\/\/[^/]*)?(\/.*)$/i.exec(text);
  if (file) {
    const host = file[1] && file[1] !== '//' && !/^\/\/localhost$/i.test(file[1]) ? file[1] : '';
    let rest = file[2];
    try {
      rest = decodeURIComponent(rest);
    } catch {
      // keep it encoded
    }
    // file:///C:/x → C:/x
    text = host ? `${host}${rest}` : /^\/[A-Za-z]:/.test(rest) ? rest.slice(1) : rest;
  }
  text = text.replaceAll('\\', '/');
  let head: string | null = null;
  if (text.startsWith('//')) {
    const [server, ...rest] = text.slice(2).split('/');
    if (!server) return [];
    head = `//${server.toLowerCase()}`;
    text = rest.join('/');
  } else if (/^[A-Za-z]:/.test(text)) {
    head = text.slice(0, 2).toLowerCase();
    text = text.slice(2);
  } else if (text.startsWith('/')) head = '/';
  const parts = text.split('/').filter((p) => p !== '' && p !== '.');
  return head ? [head, ...parts] : parts;
}

/** The mapping with the longest prefix that `path` starts with, and the parts of the path after it. */
export function mappingFor(mappings: readonly PathMapping[], path: string): { mapping: PathMapping; rest: string[] } | null {
  const parts = pathParts(path);
  let best: { mapping: PathMapping; rest: string[]; length: number } | null = null;
  for (const mapping of mappings) {
    const prefix = pathParts(mapping.prefix);
    if (prefix.length >= parts.length || (best && prefix.length <= best.length)) continue;
    if (prefix.every((p, i) => p.toLowerCase() === parts[i].toLowerCase())) best = { mapping, rest: parts.slice(prefix.length), length: prefix.length };
  }
  return best && { mapping: best.mapping, rest: best.rest };
}

/** The URL of the rest of a path under a mapping's `url`. */
export function urlFor(mapping: PathMapping & { url: string }, rest: string[]): string {
  return `${mapping.url.replace(/\/+$/, '')}/${rest.map(encodeURIComponent).join('/')}`;
}

/** Whether the files beside `name` that go with it: its .ovr, RPC and .IMD files. */
export function isSidecar(name: string, image: string): boolean {
  const lower = name.toLowerCase();
  const full = image.toLowerCase();
  const stem = full.replace(/\.[^.]+$/, '');
  if (lower === full) return false;
  return (
    lower === `${full}.ovr` ||
    lower === `${stem}_rpc.txt` ||
    (lower.startsWith(`${stem}.`) && /^(ovr|rpb|rpc|imd)$/.test(lower.slice(stem.length + 1)))
  );
}

type PermissionState = 'granted' | 'denied' | 'prompt';
interface PermissionHandle extends FileSystemDirectoryHandle {
  queryPermission?: (options: { mode: 'read' }) => Promise<PermissionState>;
  requestPermission?: (options: { mode: 'read' }) => Promise<PermissionState>;
}
type DirectoryPicker = (options?: { id?: string; mode?: 'read' }) => Promise<FileSystemDirectoryHandle>;

/** Whether the browser can be given a folder to read (and keep it in IndexedDB). */
export function hasFolderAccess(): boolean {
  return typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function' && typeof indexedDB !== 'undefined';
}

/** The folders allowed for path prefixes, kept in IndexedDB by prefix. */
export class FolderStore {
  private db_: Promise<IDBDatabase> | null = null;

  get(prefix: string): Promise<FileSystemDirectoryHandle | undefined> {
    return this.request_('readonly', (store) => store.get(key(prefix)));
  }

  set(prefix: string, handle: FileSystemDirectoryHandle): Promise<unknown> {
    return this.request_('readwrite', (store) => store.put(handle, key(prefix)));
  }

  delete(prefix: string): Promise<unknown> {
    return this.request_('readwrite', (store) => store.delete(key(prefix)));
  }

  private open_(): Promise<IDBDatabase> {
    this.db_ ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('image-viewer-folders', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('folders');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.db_;
  }

  private async request_<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this.open_();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction('folders', mode);
      const request = run(tx.objectStore('folders'));
      tx.oncomplete = () => resolve(request.result as T);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
}

/** The same prefix however it is written. */
const key = (prefix: string) => pathParts(prefix).join('/').toLowerCase();

/** An entry of `dir` by name, or one whose name differs only in case (as on Windows and most NAS shares). */
async function entryOf(dir: FileSystemDirectoryHandle, name: string, kind: 'file' | 'directory'): Promise<FileSystemHandle | null> {
  try {
    return kind === 'file' ? await dir.getFileHandle(name) : await dir.getDirectoryHandle(name);
  } catch (error) {
    if (!(error instanceof DOMException) || (error.name !== 'NotFoundError' && error.name !== 'TypeMismatchError')) throw error;
  }
  const lower = name.toLowerCase();
  for await (const entry of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
    if (entry.kind === kind && entry.name.toLowerCase() === lower) return entry;
  }
  return null;
}

/** The file at `rest` inside `root`, with the files beside it that go with it. */
export async function findFile(root: FileSystemDirectoryHandle, rest: string[]): Promise<{ file: FileSystemFileHandle; sidecars: FileSystemFileHandle[] } | null> {
  let dir = root;
  for (const name of rest.slice(0, -1)) {
    const next = await entryOf(dir, name, 'directory');
    if (!next) return null;
    dir = next as FileSystemDirectoryHandle;
  }
  const file = (await entryOf(dir, rest[rest.length - 1], 'file')) as FileSystemFileHandle | null;
  if (!file) return null;
  const sidecars: FileSystemFileHandle[] = [];
  for await (const entry of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
    if (entry.kind === 'file' && isSidecar(entry.name, file.name)) sidecars.push(entry as FileSystemFileHandle);
  }
  return { file, sidecars };
}

/** Where a local path leads: a URL to open as a COG, or files to open like local ones. */
export type Resolved = { kind: 'url'; url: string } | { kind: 'files'; handles: FileSystemFileHandle[] };

export interface LocalPathOptions {
  /**
   * Asks the person before choosing or allowing a folder (the browser lets
   * a page do that only on a click): `run` is called from the click, and
   * the result is null when they cancel.
   */
  ask: <T>(message: string, button: string, run: () => Promise<T>) => Promise<T | null>;
}

/** Resolves local paths with `pathMappings` and the folders allowed for them. */
export class LocalPaths {
  private readonly store_ = new FolderStore();

  constructor(
    readonly mappings: readonly PathMapping[],
    private readonly options: LocalPathOptions,
  ) {}

  /** Where `path` leads; throws with a message for the status line when it cannot be opened, null when the person cancelled. */
  async resolve(path: string): Promise<Resolved | null> {
    const found = mappingFor(this.mappings, path);
    if (!found) throw new Error(`config.json の pathMappings に「${path}」の先頭に合う prefix がありません`);
    const { mapping, rest } = found;
    if (mapping.url !== undefined) return { kind: 'url', url: urlFor(mapping as PathMapping & { url: string }, rest) };
    if (!hasFolderAccess()) throw new Error('このブラウザではフォルダを開けません。Chrome か Edge で開いてください');

    const root = await this.folder(mapping);
    if (!root) return null;
    const hit = await findFile(root, rest);
    if (!hit) throw new Error(`「${mapping.label}」に選んだフォルダ「${root.name}」の中に ${rest.join('/')} がありません（フォルダを選び直すには、カタログの「フォルダの許可を消去」を使ってください）`);
    return { kind: 'files', handles: [hit.file, ...hit.sidecars] };
  }

  /** The folder allowed for `mapping`, asking to allow reading it again or to choose it. */
  private async folder(mapping: PathMapping): Promise<FileSystemDirectoryHandle | null> {
    const kept = (await this.store_.get(mapping.prefix).catch(() => undefined)) as PermissionHandle | undefined;
    if (kept) {
      if ((await kept.queryPermission?.({ mode: 'read' })) === 'granted') return kept;
      const state = await this.options.ask(`「${mapping.label}」（${mapping.prefix}）のフォルダ「${kept.name}」を読む許可が必要です`, '許可する', async () =>
        kept.requestPermission ? kept.requestPermission({ mode: 'read' }) : ('granted' as PermissionState),
      );
      if (state === null) return null;
      if (state === 'granted') return kept;
      throw new Error(`「${mapping.label}」のフォルダを読む許可がありません`);
    }
    const picker = (window as unknown as { showDirectoryPicker: DirectoryPicker }).showDirectoryPicker;
    const chosen = await this.options.ask(
      `「${mapping.label}」のフォルダ（${mapping.prefix}）を選んでください。一度選ぶと、次からは選ばずに開けます`,
      'フォルダを選ぶ…',
      async () => {
        try {
          return await picker({ id: 'image-catalog', mode: 'read' });
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') return null;
          throw error;
        }
      },
    );
    if (!chosen) return null;
    await this.store_.set(mapping.prefix, chosen).catch(() => {});
    return chosen;
  }

  /** Forgets every folder allowed, so the next path asks for its folder again. */
  async forget(): Promise<void> {
    for (const mapping of this.mappings) await this.store_.delete(mapping.prefix).catch(() => {});
  }
}

/**
 * A small dialog for {@link LocalPathOptions.ask}: the message, a button that
 * runs the action on its click, and 「キャンセル」.
 */
export function askDialog(): LocalPathOptions['ask'] {
  return (message, button, run) =>
    new Promise((resolve, reject) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'add-service folder-ask';
      dialog.innerHTML = `<p></p><div class="service-actions"><button type="button" value="cancel">キャンセル</button><button type="button" value="ok" class="primary"></button></div>`;
      dialog.querySelector('p')!.textContent = message;
      const ok = dialog.querySelector<HTMLButtonElement>('button[value=ok]')!;
      ok.textContent = button;
      let done = false;
      const finish = () => {
        done = true;
        dialog.close();
        dialog.remove();
      };
      ok.addEventListener('click', () => {
        // Called on the click itself, which is what lets the browser show its picker or prompt.
        const running = run();
        finish();
        running.then(resolve, reject);
      });
      dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => {
        finish();
        resolve(null);
      });
      dialog.addEventListener('close', () => {
        if (!done) {
          dialog.remove();
          resolve(null);
        }
      });
      document.body.append(dialog);
      dialog.showModal();
      ok.focus();
    });
}
