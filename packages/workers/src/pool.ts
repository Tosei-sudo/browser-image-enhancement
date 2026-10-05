/**
 * A lazily started pool of module Web Workers, independent of what the workers compute.
 *
 * Workers are created on first use, announce themselves with a `ready` message,
 * and stay alive for reuse. A worker that cannot start (blocked by CSP, missing
 * file, no Worker support) makes the pool report itself unavailable so callers
 * fall back to the main thread.
 *
 * Each package defines its own request/response messages. Every request carries
 * an `id`; the worker answers it with a response carrying the same `id`, or with
 * `{ type: 'error', id, message }`. Workers send `{ type: 'ready' }` once on start.
 */

/** Messages every worker may send, whatever its package. */
export type ControlResponse = { type: 'ready' } | { type: 'error'; id: number; message: string };

/** The part of `Worker` the pool uses. Lets tests and custom setups supply their own. */
export interface WorkerLike<Req = unknown, Res = unknown> {
  postMessage(message: Req, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<Res | ControlResponse>) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  terminate(): void;
}

export interface WorkerConfig<Req = unknown, Res = unknown> {
  /** Most workers to run at once. Default `navigator.hardwareConcurrency` (4 if unknown). */
  maxWorkers?: number;
  /** Smallest strip, in pixels, worth sending to its own worker. Default 262144 (512x512). */
  minStripPixels?: number;
  /** How long a new worker may take to start before the pool gives up on it, in ms. Default 10000. */
  startupTimeout?: number;
  /** Creates a worker. Override to serve the worker script from a custom URL. */
  createWorker?: () => WorkerLike<Req, Res>;
}

/** Thrown when no worker could be started; callers fall back to the main thread. */
export class WorkerUnavailableError extends Error {
  override name = 'WorkerUnavailableError';
}

interface Pending<Res> {
  resolve: (response: Res) => void;
  reject: (error: Error) => void;
}

export interface Slot<Req = unknown, Res = unknown> {
  readonly worker: WorkerLike<Req, Res>;
  /** Requests sent and not yet answered. */
  load: number;
  dead: boolean;
  readonly pending: Map<number, Pending<Res>>;
}

function defaultMaxWorkers(): number {
  const n = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined;
  return n && n > 0 ? n : 4;
}

function noWorkers(): never {
  throw new WorkerUnavailableError('Web Workers are not supported in this environment.');
}

export class WorkerPool<Req extends { id: number }, Res extends { id: number }> {
  readonly maxWorkers: number;
  readonly minStripPixels: number;
  private readonly startupTimeout: number;
  private readonly create: () => WorkerLike<Req, Res>;
  private readonly slots: Array<Slot<Req, Res>> = [];
  private starting: Promise<void> | null = null;
  private failed = false;
  /** Set by {@link terminate}: workers still starting are stopped as soon as they are up. */
  private terminated = false;
  private capacity: number;

  /**
   * @param defaultCreate Used when `config.createWorker` is not set and `Worker` exists.
   */
  constructor(config: WorkerConfig<Req, Res> = {}, defaultCreate?: () => WorkerLike<Req, Res>) {
    // NaN, 0 or negative settings fall back to the defaults rather than disabling the workers.
    const valid = (v: number | undefined) => (v !== undefined && Number.isFinite(v) && v > 0 ? v : undefined);
    this.maxWorkers = Math.max(1, Math.floor(valid(config.maxWorkers) ?? defaultMaxWorkers()));
    this.capacity = this.maxWorkers;
    this.minStripPixels = Math.max(1, valid(config.minStripPixels) ?? 1 << 18);
    this.startupTimeout = valid(config.startupTimeout) ?? 10000;
    this.create = config.createWorker ?? (typeof Worker !== 'undefined' && defaultCreate ? defaultCreate : noWorkers);
  }

  /** False once workers have failed to start; the pool then stays on the main thread. */
  get available(): boolean {
    return !this.failed;
  }

  /** Number of live workers. */
  get size(): number {
    return this.slots.length;
  }

  /**
   * Returns up to `count` started workers, least busy first, starting new ones as needed.
   * Rejects with WorkerUnavailableError if none can run.
   */
  async acquire(count: number): Promise<Array<Slot<Req, Res>>> {
    const want = Math.min(Math.max(1, Math.floor(count) || 1), this.capacity);
    while (this.starting) await this.starting;
    if (this.terminated) throw new WorkerUnavailableError('Worker pool was terminated.');
    if (this.failed) throw new WorkerUnavailableError('Web Workers could not be started.');
    if (this.slots.length < want) {
      this.starting = this.startWorkers(want - this.slots.length).finally(() => {
        this.starting = null;
      });
      await this.starting;
      if (this.terminated) throw new WorkerUnavailableError('Worker pool was terminated.');
      if (this.failed) throw new WorkerUnavailableError('Web Workers could not be started.');
    }
    return [...this.slots].sort((a, b) => a.load - b.load).slice(0, want);
  }

  private async startWorkers(n: number): Promise<void> {
    const started = await Promise.all(Array.from({ length: n }, () => this.startOne()));
    // A worker can die after `ready` while the others are still starting: leave it out.
    const ok = started.filter((s): s is Slot<Req, Res> => s !== null && !s.dead);
    if (this.terminated) {
      for (const slot of ok) this.kill(slot, new WorkerUnavailableError('Worker pool was terminated.'));
      return;
    }
    this.slots.push(...ok);
    if (this.slots.length === 0) this.failed = true;
    // Some workers started and some did not: don't keep retrying the ones that fail.
    else if (ok.length < n) this.capacity = this.slots.length;
  }

  private startOne(): Promise<Slot<Req, Res> | null> {
    let worker: WorkerLike<Req, Res>;
    try {
      worker = this.create();
    } catch {
      return Promise.resolve(null);
    }
    return new Promise<Slot<Req, Res> | null>((resolve) => {
      const slot: Slot<Req, Res> = { worker, load: 0, dead: false, pending: new Map() };
      let ready = false;
      const timer = setTimeout(() => fail(), this.startupTimeout);
      const fail = () => {
        clearTimeout(timer);
        this.kill(slot, new WorkerUnavailableError('Web Worker stopped unexpectedly.'));
        if (!ready) resolve(null);
      };
      worker.addEventListener('message', (event) => {
        const msg = event.data as Res | ControlResponse;
        if ('type' in msg && msg.type === 'ready') {
          ready = true;
          clearTimeout(timer);
          resolve(slot);
          return;
        }
        const id = (msg as { id: number }).id;
        const pending = slot.pending.get(id);
        if (!pending) return;
        slot.pending.delete(id);
        slot.load--;
        if ('type' in msg && msg.type === 'error') pending.reject(new Error((msg as { message: string }).message));
        else pending.resolve(msg as Res);
      });
      worker.addEventListener('error', (event) => {
        event.preventDefault?.();
        fail();
      });
      worker.addEventListener('messageerror', () => fail());
    });
  }

  /** Sends a request and resolves with the worker's answer for the same id. */
  request(slot: Slot<Req, Res>, message: Req, transfer: Transferable[] = []): Promise<Res> {
    if (slot.dead) return Promise.reject(new WorkerUnavailableError('Web Worker is no longer running.'));
    return new Promise((resolve, reject) => {
      slot.pending.set(message.id, { resolve, reject });
      slot.load++;
      try {
        slot.worker.postMessage(message, transfer);
      } catch (e) {
        slot.pending.delete(message.id);
        slot.load--;
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Fire-and-forget message that gets no answer. */
  notify(slot: Slot<Req, Res>, message: Req): void {
    if (!slot.dead) slot.worker.postMessage(message, []);
  }

  /**
   * Gives up on requests already sent: each rejects with `error`. A worker
   * busy only with them is stopped, so an aborted job stops using the CPU (a
   * new worker starts on the next {@link acquire}); on a worker that also has
   * other jobs' requests, the answers to these are ignored when they come.
   */
  cancel(slot: Slot<Req, Res>, ids: Iterable<number>, error: Error): void {
    const mine = [...ids].filter((id) => slot.pending.has(id));
    if (mine.length === 0) return;
    if (mine.length === slot.pending.size) {
      this.kill(slot, error);
      return;
    }
    for (const id of mine) {
      const pending = slot.pending.get(id)!;
      slot.pending.delete(id);
      slot.load--;
      pending.reject(error);
    }
  }

  private kill(slot: Slot<Req, Res>, error: Error): void {
    if (slot.dead) return;
    slot.dead = true;
    try {
      slot.worker.terminate();
    } catch {
      // Already gone.
    }
    const i = this.slots.indexOf(slot);
    if (i >= 0) this.slots.splice(i, 1);
    for (const p of slot.pending.values()) p.reject(error);
    slot.pending.clear();
  }

  /** Stops every worker. Pending requests reject. */
  terminate(): void {
    this.terminated = true;
    for (const slot of [...this.slots]) this.kill(slot, new WorkerUnavailableError('Worker pool was terminated.'));
  }
}

export interface SharedPool<Req extends { id: number }, Res extends { id: number }> {
  /** The package's shared pool, created on first use. */
  getPool(): WorkerPool<Req, Res>;
  /**
   * Changes how workers are created and how many run. Stops the current workers;
   * new ones start on the next run with the new settings.
   */
  configureWorkers(next: WorkerConfig<Req, Res>): void;
  /** Stops all workers. They restart on demand. */
  terminateWorkers(): void;
}

/** One lazily created pool per package, with the package's default way to start its worker. */
export function createSharedPool<Req extends { id: number }, Res extends { id: number }>(
  defaultCreate: () => WorkerLike<Req, Res>,
): SharedPool<Req, Res> {
  let config: WorkerConfig<Req, Res> = {};
  let shared: WorkerPool<Req, Res> | null = null;
  const terminateWorkers = () => {
    shared?.terminate();
    shared = null;
  };
  return {
    getPool: () => (shared ??= new WorkerPool(config, defaultCreate)),
    configureWorkers(next) {
      terminateWorkers();
      config = { ...config, ...next };
    },
    terminateWorkers,
  };
}
