/**
 * Processing results kept in the browser: each tool writes its GeoTIFF
 * straight into a file of the origin private file system (OPFS) as it makes
 * it, tile block by tile block, so a result of many gigabytes is never one
 * Blob in the page, and it is still there after a reload. The 「処理結果」
 * dialog (results-dialog.ts) lists them to open, save or delete; a project
 * that had one open finds it again by its file handle, like any local file.
 *
 * Each result is a folder `results/<id>/`: its files (the GeoTIFF that opens,
 * and any others the tool made, such as a class table) and `meta.json`,
 * written last. A folder without `meta.json` is a result that was never
 * finished (the tab closed while it was made); it is removed on the next
 * visit, unless another tab is still writing it (a Web Lock says so).
 *
 * Where the browser has no OPFS with writable files, results are kept in
 * the page as before (lost on reload), through the same calls.
 */
import { FileSink, MemorySink, type ByteSink } from './byte-sink.js';
import { fileOf, handleOf } from './recent-files.js';
import type { ViewerImage } from './images.js';

/** A result kept in the browser. */
export interface KeptResult {
  id: string;
  /** The file that opens as the layer. */
  name: string;
  /** What made it (モザイク, バンド演算…). */
  tool: string;
  /** When it was made (ms since 1970). */
  created: number;
  /** Bytes of all its files. */
  size: number;
  /** Its files, the one that opens first. */
  files: string[];
  /** Whether its values are classes (overviews pick a value instead of averaging). */
  categorical?: boolean;
}

/** What the viewer knows of a layer that is a processing result. */
export interface ResultInfo {
  tool: string;
  /** Its files, the one shown first (kept in the browser, or in the page). */
  files: File[];
  /** Kept in the browser; null when only in the page. */
  kept: KeptResult | null;
  categorical?: boolean;
}

type Lock = { release: () => void };

/** The entries of a folder (the DOM types lack its iterator). */
function entriesOf(dir: FileSystemDirectoryHandle): AsyncIterable<[string, FileSystemHandle]> {
  return (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
}

const ROOT = 'results';
const EXPORTS = 'exports';
const META = 'meta.json';

/** Whether the browser can keep results in its own storage. */
export function canKeepResults(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    typeof (FileSystemFileHandle.prototype as { createWritable?: unknown }).createWritable === 'function'
  );
}

/** A Web Lock held until released (none where the browser has no Web Locks). */
async function hold(name: string): Promise<Lock> {
  if (typeof navigator === 'undefined' || !navigator.locks) return { release: () => {} };
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await new Promise<void>((acquired) => {
    void navigator.locks.request(name, () => {
      acquired();
      return held;
    });
  });
  return { release };
}

/** Runs `run` when nobody holds the lock `name`; false when somebody does. */
async function whenFree(name: string, run: () => Promise<void>): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    await run();
    return true;
  }
  return navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
    if (!lock) return false;
    await run();
    return true;
  });
}

/** Room to leave free in the browser's storage, besides a file being written. */
const MARGIN = 64 * 1024 * 1024;

/**
 * A file of OPFS, unless the browser's storage has no room for it (as said
 * by {@link ByteSink.reserve} before the first write) or cannot be written
 * (a private window): then kept in the page.
 */
export class RoomySink implements ByteSink {
  private inner_: Promise<ByteSink> | null = null;
  private bytes_ = 0;
  private memory_ = false;

  constructor(
    private readonly file: () => FileSink,
    private readonly free: () => Promise<number | null>,
  ) {}

  reserve(bytes: number): void {
    this.bytes_ = bytes;
  }

  /** Whether it is kept in the page (no room in the browser's storage). */
  get inMemory(): boolean {
    return this.memory_;
  }

  private inner(): Promise<ByteSink> {
    this.inner_ ??= this.free()
      .catch(() => null)
      .then(async (free) => {
        if (free === null || free >= this.bytes_ + MARGIN) {
          const file = this.file();
          if (await file.ready().then(() => true, () => false)) return file;
          await file.abort();
        }
        this.memory_ = true;
        return new MemorySink();
      });
    return this.inner_;
  }

  append(data: Blob | Uint8Array): Promise<void> {
    return this.inner().then((s) => s.append(data));
  }

  overwrite(position: number, data: Uint8Array): Promise<void> {
    return this.inner().then((s) => s.overwrite(position, data));
  }

  close(name: string, type?: string): Promise<File> {
    return this.inner().then((s) => s.close(name, type));
  }

  async abort(): Promise<void> {
    if (this.inner_) await (await this.inner_).abort();
  }
}

/** A result being made: its files are written, then {@link ResultDraft.commit} keeps it. */
export class ResultDraft {
  private readonly files_ = new Map<string, File>();
  private readonly sinks_: ByteSink[] = [];
  private done_ = false;

  constructor(
    private readonly store: ResultStore,
    readonly id: string,
    readonly tool: string,
    /** Its folder; null when results stay in the page. */
    private readonly dir: Promise<FileSystemDirectoryHandle> | null,
    private readonly lock: Promise<Lock>,
  ) {}

  /** Where a file of this result named `name` is written as it is made. */
  sink(name: string): ByteSink {
    const dir = this.dir;
    const sink = dir ? new RoomySink(() => new FileSink(dir, name), () => this.store.free()) : new MemorySink();
    this.sinks_.push(sink);
    return sink;
  }

  /** Writes a file already made (a small one, such as a table) into the result. */
  async add(name: string, blob: Blob): Promise<File> {
    const sink = this.sink(name);
    sink.reserve?.(blob.size);
    await sink.append(blob);
    const file = await sink.close(name, blob.type);
    this.files_.set(name, file);
    return file;
  }

  /**
   * Keeps the result, `main` (made by one of its sinks, or {@link add}) the
   * file that opens; null when results stay in the page.
   */
  async commit(main: File, others: File[] = [], options: { categorical?: boolean } = {}): Promise<KeptResult | null> {
    this.done_ = true;
    try {
      // Not kept when a file had no room in the browser's storage (it is in the page). Its other
      // files may be open as layers: they stay until the next visit removes the unfinished folder.
      if (this.sinks_.some((s) => s instanceof RoomySink && s.inMemory)) return null;
      if (!this.dir) return null;
      const files = [main, ...others.filter((f) => f !== main)];
      const kept: KeptResult = {
        id: this.id,
        name: main.name,
        tool: this.tool,
        created: Date.now(),
        size: files.reduce((n, f) => n + f.size, 0),
        files: files.map((f) => f.name),
        ...(options.categorical ? { categorical: true } : {}),
      };
      const dir = await this.dir;
      const handle = await dir.getFileHandle(META, { create: true });
      const writable = await handle.createWritable();
      await writable.write(JSON.stringify(kept));
      await writable.close();
      this.store.changed();
      void navigator.storage.persist?.().catch(() => false);
      return kept;
    } finally {
      (await this.lock).release();
    }
  }

  /** Drops the result (it failed or was stopped). */
  async discard(): Promise<void> {
    if (this.done_) return;
    this.done_ = true;
    await Promise.all(this.sinks_.map((s) => s.abort().catch(() => {})));
    if (this.dir) await this.store.removeFolder(this.id).catch(() => {});
    (await this.lock).release();
  }
}

/** The results kept in the browser, and which open layers are results. */
export class ResultStore {
  private readonly info_ = new WeakMap<ViewerImage, ResultInfo>();
  private readonly marked_ = new Set<(image: ViewerImage, info: ResultInfo) => void>();
  private readonly changed_ = new Set<() => void>();

  constructor(private readonly keep: () => boolean = canKeepResults) {}

  private async root_(name = ROOT): Promise<FileSystemDirectoryHandle> {
    const top = await navigator.storage.getDirectory();
    return top.getDirectoryHandle(name, { create: true });
  }

  /** Whether results are kept in the browser (else only in the page). */
  get kept(): boolean {
    return this.keep();
  }

  /** Starts a result made by `tool`. */
  begin(tool: string): ResultDraft {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (!this.keep()) return new ResultDraft(this, id, tool, null, Promise.resolve({ release: () => {} }));
    const lock = hold(`result:${id}`);
    const dir = lock.then(() => this.root_()).then((root) => root.getDirectoryHandle(id, { create: true }));
    return new ResultDraft(this, id, tool, dir, lock);
  }

  /** Makes `blob` (a file already made in the page) a kept result: the File to open, and what was kept. */
  async keepBlob(tool: string, name: string, blob: Blob, options: { categorical?: boolean } = {}): Promise<{ file: File; kept: KeptResult | null }> {
    const draft = this.begin(tool);
    try {
      const file = await draft.add(name, blob);
      return { file, kept: await draft.commit(file, [], options) };
    } catch {
      await draft.discard();
      // Kept in the page instead.
      return { file: new File([blob], name, { type: blob.type || 'image/tiff' }), kept: null };
    }
  }

  /** The kept results, newest first. */
  async list(): Promise<KeptResult[]> {
    if (!this.keep()) return [];
    const root = await this.root_();
    const out: KeptResult[] = [];
    for await (const [id, entry] of entriesOf(root)) {
      if (entry.kind !== 'directory') continue;
      try {
        const meta = await (await (entry as FileSystemDirectoryHandle).getFileHandle(META)).getFile();
        const kept = JSON.parse(await meta.text()) as KeptResult;
        if (kept.id === id) out.push(kept);
      } catch {
        // Not finished (or being made in another tab).
      }
    }
    return out.sort((a, b) => b.created - a.created);
  }

  /** A file of a kept result (default: the one that opens). */
  async file(result: KeptResult, name = result.name): Promise<File> {
    const dir = await (await this.root_()).getDirectoryHandle(result.id);
    return fileOf(await dir.getFileHandle(name));
  }

  /** Deletes a kept result. */
  async remove(id: string): Promise<void> {
    await this.removeFolder(id);
    this.changed();
  }

  /** @internal Deletes a result's folder. */
  async removeFolder(id: string): Promise<void> {
    await (await this.root_()).removeEntry(id, { recursive: true });
  }

  /**
   * Removes what an earlier visit left unfinished: results never kept, and
   * files made only to be downloaded. Those another tab is using stay.
   */
  async cleanUp(): Promise<void> {
    if (!this.keep()) return;
    const root = await this.root_();
    for await (const [id, entry] of entriesOf(root)) {
      if (entry.kind !== 'directory') continue;
      const finished = await (entry as FileSystemDirectoryHandle).getFileHandle(META).then(
        () => true,
        () => false,
      );
      if (!finished) await whenFree(`result:${id}`, () => root.removeEntry(id, { recursive: true }));
    }
    const exports = await this.root_(EXPORTS);
    for await (const [id] of entriesOf(exports)) await whenFree(`export:${id}`, () => exports.removeEntry(id, { recursive: true }));
  }

  /**
   * A file to write and then hand to the browser's downloads (a COG made for
   * saving): in OPFS, kept until a later visit (the download reads it a while
   * after it is handed over), else in the page.
   */
  scratch(name: string): ByteSink {
    if (!this.keep()) return new MemorySink();
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return new RoomySink(
      () => {
        const lock = hold(`export:${id}`);
        // Freed a while after it is written: long enough for a download to read it.
        const dir = lock.then(async (l) => {
          setTimeout(() => l.release(), 30 * 60_000);
          return (await this.root_(EXPORTS)).getDirectoryHandle(id, { create: true });
        });
        return new FileSink(dir, name);
      },
      () => this.free(),
    );
  }

  /** Bytes the viewer may still store, when the browser says. */
  async free(): Promise<number | null> {
    const usage = await this.usage().catch(() => null);
    return usage ? usage.quota - usage.used : null;
  }

  /** Space used and left for the viewer's storage, when the browser says. */
  async usage(): Promise<{ used: number; quota: number } | null> {
    const estimate = await navigator.storage?.estimate?.().catch(() => null);
    return estimate && estimate.usage !== undefined && estimate.quota !== undefined ? { used: estimate.usage, quota: estimate.quota } : null;
  }

  /** The kept result `file` was read from, if any (a project's layer opened again). */
  async recognize(file: File): Promise<KeptResult | null> {
    const handle = handleOf(file);
    if (!handle || !this.keep()) return null;
    const root = await this.root_();
    for (const kept of await this.list()) {
      if (!kept.files.includes(file.name)) continue;
      const own = await root
        .getDirectoryHandle(kept.id)
        .then((d) => d.getFileHandle(file.name))
        .catch(() => null);
      if (own && (await own.isSameEntry(handle))) return kept;
    }
    return null;
  }

  /** Marks `image` as a result (its save button, its files). */
  mark(image: ViewerImage, info: ResultInfo): void {
    this.info_.set(image, info);
    for (const listener of this.marked_) listener(image, info);
  }

  /** What `image` is a result of, or undefined when it is not one. */
  infoOf(image: ViewerImage): ResultInfo | undefined {
    return this.info_.get(image);
  }

  /** Calls `listener` when a layer is marked as a result. */
  onMark(listener: (image: ViewerImage, info: ResultInfo) => void): void {
    this.marked_.add(listener);
  }

  /** Calls `listener` when results are kept or deleted. */
  onChange(listener: () => void): () => void {
    this.changed_.add(listener);
    return () => this.changed_.delete(listener);
  }

  /** @internal Tells the listeners the kept results changed. */
  changed(): void {
    for (const listener of this.changed_) listener();
  }
}

/** The viewer's one store of results. */
export const results = new ResultStore();

/**
 * Keeps a result made through `draft` once it has opened as `image` (kept
 * in the browser, and the layer marked as a result); drops it when it did
 * not open.
 */
export async function keepResult(draft: ResultDraft, image: ViewerImage | null | undefined, main: File, others: File[] = [], options: { categorical?: boolean } = {}): Promise<void> {
  if (!image) return draft.discard();
  const kept = await draft.commit(main, others, options).catch(() => null);
  results.mark(image, { tool: draft.tool, files: [main, ...others], kept, ...options });
}
