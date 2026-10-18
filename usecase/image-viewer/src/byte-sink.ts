/**
 * Where a file being written goes, a piece at a time: kept in the page as
 * Blob parts (the browser keeps large ones on disk), or written into a file
 * as it comes (see result-store.ts), so a result of many gigabytes never has
 * to be one Blob in the page.
 */

import { fileOf } from './recent-files.js';

/** A file written front to back, whose first bytes (a header) may be written again at the end. */
export interface ByteSink {
  /** Adds `data` after what is written; writes happen in the order they are asked for. */
  append(data: Blob | Uint8Array): Promise<void>;
  /** Writes `data` over bytes already written at `position` (a header, once the rest is known). */
  overwrite(position: number, data: Uint8Array): Promise<void>;
  /** Finishes the file: what was written, as a File named `name`. */
  close(name: string, type?: string): Promise<File>;
  /** Drops what was written. */
  abort(): Promise<void>;
  /** Says how large the file will about be, before anything is written (a sink may then pick where it goes). */
  reserve?(bytes: number): void;
}

/** A sink kept in the page. */
export class MemorySink implements ByteSink {
  private parts_: Array<Blob | Uint8Array> = [];
  private size_ = 0;

  append(data: Blob | Uint8Array): Promise<void> {
    this.parts_.push(data);
    this.size_ += data instanceof Blob ? data.size : data.byteLength;
    return Promise.resolve();
  }

  overwrite(position: number, data: Uint8Array): Promise<void> {
    let at = 0;
    for (const [k, part] of this.parts_.entries()) {
      const size = part instanceof Blob ? part.size : part.byteLength;
      if (position >= at && position + data.byteLength <= at + size && part instanceof Uint8Array) {
        const copy = part.slice();
        copy.set(data, position - at);
        this.parts_[k] = copy;
        return Promise.resolve();
      }
      at += size;
    }
    return Promise.reject(new RangeError(`Cannot overwrite ${data.byteLength} bytes at ${position}.`));
  }

  close(name: string, type = 'image/tiff'): Promise<File> {
    const file = new File(this.parts_ as BlobPart[], name, { type });
    this.parts_ = [];
    return Promise.resolve(file);
  }

  abort(): Promise<void> {
    this.parts_ = [];
    return Promise.resolve();
  }

  /** Bytes written so far. */
  get size(): number {
    return this.size_;
  }
}

/** A file of a folder (OPFS, or one the person chose) written at given places, in the order asked. */
export class FileSink implements ByteSink {
  private size_ = 0;
  private chain_: Promise<unknown>;
  private readonly ready_: Promise<{ handle: FileSystemFileHandle; writable: FileSystemWritableFileStream }>;

  constructor(
    private readonly dir: Promise<FileSystemDirectoryHandle>,
    private readonly name: string,
  ) {
    this.ready_ = dir.then(async (d) => {
      const handle = await d.getFileHandle(name, { create: true });
      return { handle, writable: await handle.createWritable({ keepExistingData: false }) };
    });
    this.chain_ = this.ready_;
  }

  /** Resolves once the file is made and open for writing (rejects when it cannot be). */
  async ready(): Promise<void> {
    await this.ready_;
  }

  private then_(write: (writable: FileSystemWritableFileStream) => Promise<void>): Promise<void> {
    const next = this.chain_.then(async () => write((await this.ready_).writable));
    this.chain_ = next;
    return next;
  }

  append(data: Blob | Uint8Array): Promise<void> {
    const position = this.size_;
    this.size_ += data instanceof Blob ? data.size : data.byteLength;
    return this.then_((w) => w.write({ type: 'write', position, data: data as Blob | Uint8Array<ArrayBuffer> }));
  }

  overwrite(position: number, data: Uint8Array): Promise<void> {
    return this.then_((w) => w.write({ type: 'write', position, data: data as Uint8Array<ArrayBuffer> }));
  }

  /** The file as written (its name is the one it was made with). */
  async close(): Promise<File> {
    await this.chain_;
    const { handle, writable } = await this.ready_;
    await writable.close();
    return fileOf(handle);
  }

  async abort(): Promise<void> {
    await this.chain_.catch(() => {});
    const ready = await this.ready_.catch(() => null);
    await ready?.writable.abort().catch(() => {});
    await this.dir.then((d) => d.removeEntry(this.name)).catch(() => {});
  }

  /** Bytes written so far. */
  get size(): number {
    return this.size_;
  }
}
