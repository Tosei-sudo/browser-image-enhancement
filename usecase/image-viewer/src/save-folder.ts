/**
 * Where the files the viewer makes go: downloaded (the default), or written
 * straight into a folder the person chooses once with the File System Access
 * API (Chrome, Edge). The folder's handle is kept in IndexedDB like the
 * folders of `pathMappings`, so after a reload saving only asks to allow
 * writing again.
 *
 * Writing into the folder hands the Blob to the file (`createWritable`), so no
 * second copy of a large GeoTIFF is made in the page, there is no save dialog
 * or download bar, and a name already in the folder gets ` (1)`, ` (2)`… as a
 * download would. When the folder cannot be written (removed,
 * not allowed), the file is downloaded instead and the status says why.
 */
import { askDialog, FolderStore, type LocalPathOptions } from './local-paths.js';
import { FileSink, type ByteSink } from './byte-sink.js';

type PermissionState = 'granted' | 'denied' | 'prompt';
interface WritableFolder extends FileSystemDirectoryHandle {
  queryPermission?: (options: { mode: 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (options: { mode: 'readwrite' }) => Promise<PermissionState>;
}
type DirectoryPicker = (options?: { id?: string; mode?: 'readwrite' }) => Promise<FileSystemDirectoryHandle>;

/** The key the save folder is kept under, beside the `pathMappings` folders. */
const KEY = 'save-folder:';

/** Whether the browser can write into a folder the person chooses. */
export function canSaveToFolder(): boolean {
  return (
    typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function' &&
    typeof indexedDB !== 'undefined' &&
    typeof (FileSystemFileHandle.prototype as { createWritable?: unknown }).createWritable === 'function'
  );
}

/** Hands `blob` to the browser's downloads as `name`. */
export function downloadBlob(name: string, blob: Blob): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  // A large Blob is still being read by the download a while after the click.
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

/** `name`, or `name (1).ext`, `name (2).ext`… for the `n`th try. */
export function numberedName(name: string, n: number): string {
  if (n === 0) return name;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/** A name for a new file in `dir`: `name`, or the first numbered one not there yet. */
export async function freeName(dir: FileSystemDirectoryHandle, name: string): Promise<string> {
  for (let n = 0; n < 1000; n++) {
    const candidate = numberedName(name, n);
    try {
      await dir.getFileHandle(candidate);
    } catch (error) {
      if (error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError')) {
        if (error.name === 'NotFoundError') return candidate;
        continue;
      }
      throw error;
    }
  }
  throw new Error(`${name} と同じ名前のファイルが多すぎ`);
}

/** Writes `blob` as a new file `name` in `dir`; the name it was written as. */
export async function writeToFolder(dir: FileSystemDirectoryHandle, name: string, blob: Blob): Promise<string> {
  const free = await freeName(dir, name);
  const handle = await dir.getFileHandle(free, { create: true });
  const writable = await handle.createWritable();
  try {
    // The Blob itself, not its stream: the browser copies it to the file without
    // bringing it into the page (several times faster than piping it through).
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    await dir.removeEntry(free).catch(() => {});
    throw error;
  }
  return free;
}

/** What a save did, for the status line. */
export interface Saved {
  /** The name the file was written as (numbered when the folder had one by that name). */
  name: string;
  /** The folder it was written into; null when it was downloaded. */
  folder: string | null;
  /** Why it was downloaded although a folder was chosen. */
  problem?: string;
}

/** `「name」を保存` with where it went. */
export function savedMessage(saved: Saved, detail = ''): string {
  const where = saved.folder ? `フォルダ「${saved.folder}」に ` : '';
  const problem = saved.problem ? `（フォルダに書けなかったためダウンロード: ${saved.problem}）` : '';
  return `${where}${saved.name} を保存${detail}${problem}`;
}

/** The save folder: chosen, forgotten, and written into. */
export class SaveFolder {
  private readonly store_ = new FolderStore();
  private folder_: WritableFolder | null = null;
  private loaded_: Promise<void> | null = null;
  private readonly listeners_ = new Set<() => void>();

  constructor(private readonly ask: LocalPathOptions['ask'] = askDialog()) {}

  /** The chosen folder, or null to download. */
  async current(): Promise<FileSystemDirectoryHandle | null> {
    this.loaded_ ??= this.store_
      .get(KEY)
      .then((handle) => {
        this.folder_ ??= (handle as WritableFolder | undefined) ?? null;
      })
      .catch(() => {});
    await this.loaded_;
    return this.folder_;
  }

  /** Calls `listener` when the folder is chosen or forgotten. */
  onChange(listener: () => void): () => void {
    this.listeners_.add(listener);
    return () => this.listeners_.delete(listener);
  }

  /** Saves into `handle` from now on (kept for later visits). */
  async set(handle: FileSystemDirectoryHandle | null): Promise<void> {
    this.folder_ = handle as WritableFolder | null;
    this.loaded_ = Promise.resolve();
    await (handle ? this.store_.set(KEY, handle) : this.store_.delete(KEY)).catch(() => {});
    for (const listener of this.listeners_) listener();
  }

  /** Asks for a folder with the browser's picker (call it from a click); false when the person cancels. */
  async choose(): Promise<boolean> {
    const picker = (window as unknown as { showDirectoryPicker: DirectoryPicker }).showDirectoryPicker;
    try {
      await this.set(await picker({ id: 'save-folder', mode: 'readwrite' }));
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return false;
      throw error;
    }
  }

  /** Whether the folder may be written, asking (on a click of its own when needed) to allow it again. */
  private async allowed_(folder: WritableFolder): Promise<boolean> {
    if (!folder.queryPermission) return true;
    if ((await folder.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    const request = () => folder.requestPermission!({ mode: 'readwrite' });
    let state: PermissionState | null;
    try {
      // Straight after the person's click, the browser asks at once.
      state = await request();
    } catch {
      // Long after it (the file took a while to make), it wants a click of its own.
      state = await this.ask(`保存先のフォルダ「${folder.name}」に書き込む許可が必要`, '許可', request);
    }
    return state === 'granted';
  }

  /**
   * A new file `name` in the chosen folder, to write as it is made (a large
   * file need not be made first): its sink and where it goes. `sink` is null
   * when files are downloaded, or when the folder cannot be written
   * (`problem` says why).
   */
  async open(name: string): Promise<{ sink: ByteSink; saved: Saved } | { sink: null; problem?: string }> {
    const folder = (await this.current()) as WritableFolder | null;
    if (!folder || !canSaveToFolder()) return { sink: null };
    try {
      if (!(await this.allowed_(folder))) return { sink: null, problem: '書き込みが拒否' };
      const free = await freeName(folder, name);
      return { sink: new FileSink(Promise.resolve(folder), free), saved: { name: free, folder: folder.name } };
    } catch (error) {
      return { sink: null, problem: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Saves `blob` as `name`: into the chosen folder, else (or when that
   * fails) as a download.
   */
  async save(name: string, blob: Blob): Promise<Saved> {
    const folder = (await this.current()) as WritableFolder | null;
    if (!folder || !canSaveToFolder()) {
      downloadBlob(name, blob);
      return { name, folder: null };
    }
    let problem: string;
    try {
      if (await this.allowed_(folder)) return { name: await writeToFolder(folder, name, blob), folder: folder.name };
      problem = '書き込みが拒否';
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    downloadBlob(name, blob);
    return { name, folder: null, problem };
  }
}

/** The viewer's one save folder. */
export const saveFolder = new SaveFolder();

/** Saves `blob` as `name` where the viewer saves files, and says so on the status line. */
export async function saveFile(name: string, blob: Blob, say: (message: string) => void, detail = ''): Promise<Saved> {
  const saved = await saveFolder.save(name, blob);
  say(savedMessage(saved, detail));
  return saved;
}

/**
 * The 「保存先…」 dialog: where files go now, 「フォルダを選ぶ…」 and
 * 「ダウンロードに復帰」.
 */
export class SaveFolderDialog {
  readonly dialog: HTMLDialogElement;
  private readonly where_: HTMLElement;
  private readonly back_: HTMLButtonElement;

  constructor(
    private readonly folder: SaveFolder,
    private readonly options: { say: (message: string) => void },
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service save-folder';
    this.dialog.setAttribute('aria-labelledby', 'save-folder-title');
    this.dialog.innerHTML = `
      <h2 id="save-folder-title">保存先</h2>
      <p class="save-folder-where"></p>
      <p class="hint">フォルダを選ぶと、処理結果の GeoTIFF・表示範囲の画像などをダウンロードせずにそのフォルダへ直接書き込み。同じ名前のファイルがあると「(1)」を付与。</p>
      <div class="service-actions">
        <button type="button" value="download">ダウンロードに復帰</button>
        <button type="button" value="choose" class="primary">フォルダを選択…</button>
        <button type="button" value="close">閉じる</button>
      </div>`;
    this.where_ = this.dialog.querySelector('.save-folder-where')!;
    this.back_ = this.dialog.querySelector('button[value=download]')!;
    this.dialog.querySelector('button[value=choose]')!.addEventListener('click', () => void this.choose_());
    this.back_.addEventListener('click', () => void this.folder.set(null).then(() => this.options.say('ファイルはダウンロードで保存')));
    this.dialog.querySelector('button[value=close]')!.addEventListener('click', () => this.dialog.close());
    this.folder.onChange(() => void this.update_());
    document.body.append(this.dialog);
  }

  async open(): Promise<void> {
    await this.update_();
    this.dialog.showModal();
  }

  private async choose_(): Promise<void> {
    try {
      if (await this.folder.choose()) this.options.say(`ファイルはフォルダ「${(await this.folder.current())!.name}」に保存`);
    } catch (error) {
      this.options.say(`フォルダの選択に失敗: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async update_(): Promise<void> {
    const folder = await this.folder.current();
    this.where_.textContent = folder ? `いまの保存先: フォルダ「${folder.name}」` : 'いまの保存先: ダウンロード';
    this.back_.hidden = !folder;
  }
}
