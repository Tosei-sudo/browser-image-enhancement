/**
 * A lazily started pool of module Web Workers.
 *
 * Workers are created on first use, announce themselves with a `ready` message,
 * and stay alive for reuse. A worker that cannot start (blocked by CSP, missing
 * file, no Worker support) makes the pool report itself unavailable so callers
 * fall back to the main thread.
 */
import { defaultCreateWorker } from './default-worker.js';
/** Thrown when no worker could be started; callers fall back to the main thread. */
export class WorkerUnavailableError extends Error {
    name = 'WorkerUnavailableError';
}
function defaultMaxWorkers() {
    const n = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined;
    return n && n > 0 ? n : 4;
}
export class WorkerPool {
    maxWorkers;
    minStripPixels;
    startupTimeout;
    create;
    slots = [];
    starting = null;
    failed = false;
    capacity;
    constructor(config = {}) {
        this.maxWorkers = Math.max(1, Math.floor(config.maxWorkers ?? defaultMaxWorkers()));
        this.capacity = this.maxWorkers;
        this.minStripPixels = Math.max(1, config.minStripPixels ?? 1 << 18);
        this.startupTimeout = config.startupTimeout ?? 10000;
        this.create =
            config.createWorker ??
                (typeof Worker !== 'undefined'
                    ? defaultCreateWorker
                    : () => {
                        throw new WorkerUnavailableError('Web Workers are not supported in this environment.');
                    });
    }
    /** False once workers have failed to start; the pool then stays on the main thread. */
    get available() {
        return !this.failed;
    }
    /** Number of live workers. */
    get size() {
        return this.slots.length;
    }
    /**
     * Returns up to `count` started workers, least busy first, starting new ones as needed.
     * Rejects with WorkerUnavailableError if none can run.
     */
    async acquire(count) {
        const want = Math.min(Math.max(1, Math.floor(count)), this.capacity);
        while (this.starting)
            await this.starting;
        if (this.failed)
            throw new WorkerUnavailableError('Web Workers could not be started.');
        if (this.slots.length < want) {
            this.starting = this.startWorkers(want - this.slots.length).finally(() => {
                this.starting = null;
            });
            await this.starting;
            if (this.failed)
                throw new WorkerUnavailableError('Web Workers could not be started.');
        }
        return [...this.slots].sort((a, b) => a.load - b.load).slice(0, want);
    }
    async startWorkers(n) {
        const started = await Promise.all(Array.from({ length: n }, () => this.startOne()));
        const ok = started.filter((s) => s !== null);
        this.slots.push(...ok);
        if (this.slots.length === 0)
            this.failed = true;
        // Some workers started and some did not: don't keep retrying the ones that fail.
        else if (ok.length < n)
            this.capacity = this.slots.length;
    }
    startOne() {
        let worker;
        try {
            worker = this.create();
        }
        catch {
            return Promise.resolve(null);
        }
        return new Promise((resolve) => {
            const slot = { worker, load: 0, dead: false, pending: new Map() };
            let ready = false;
            const timer = setTimeout(() => fail(), this.startupTimeout);
            const fail = () => {
                clearTimeout(timer);
                this.kill(slot, new WorkerUnavailableError('Web Worker stopped unexpectedly.'));
                if (!ready)
                    resolve(null);
            };
            worker.addEventListener('message', (event) => {
                const msg = event.data;
                if (msg.type === 'ready') {
                    ready = true;
                    clearTimeout(timer);
                    resolve(slot);
                    return;
                }
                const pending = slot.pending.get(msg.id);
                if (!pending)
                    return;
                slot.pending.delete(msg.id);
                slot.load--;
                if (msg.type === 'error')
                    pending.reject(new Error(msg.message));
                else
                    pending.resolve(msg);
            });
            worker.addEventListener('error', (event) => {
                event.preventDefault?.();
                fail();
            });
            worker.addEventListener('messageerror', () => fail());
        });
    }
    /** Sends a request and resolves with the worker's answer for the same id. */
    request(slot, message, transfer = []) {
        if (slot.dead)
            return Promise.reject(new WorkerUnavailableError('Web Worker is no longer running.'));
        return new Promise((resolve, reject) => {
            slot.pending.set(message.id, { resolve, reject });
            slot.load++;
            try {
                slot.worker.postMessage(message, transfer);
            }
            catch (e) {
                slot.pending.delete(message.id);
                slot.load--;
                reject(e instanceof Error ? e : new Error(String(e)));
            }
        });
    }
    /** Fire-and-forget message (used for `release`). */
    notify(slot, message) {
        if (!slot.dead)
            slot.worker.postMessage(message, []);
    }
    kill(slot, error) {
        if (slot.dead)
            return;
        slot.dead = true;
        try {
            slot.worker.terminate();
        }
        catch {
            // Already gone.
        }
        const i = this.slots.indexOf(slot);
        if (i >= 0)
            this.slots.splice(i, 1);
        for (const p of slot.pending.values())
            p.reject(error);
        slot.pending.clear();
    }
    /** Stops every worker. Pending requests reject. */
    terminate() {
        for (const slot of [...this.slots])
            this.kill(slot, new WorkerUnavailableError('Worker pool was terminated.'));
    }
}
let config = {};
let shared = null;
/** The pool used by `pipeline().run()`. */
export function getPool() {
    shared ??= new WorkerPool(config);
    return shared;
}
/**
 * Changes how workers are created and how many run. Stops the current workers;
 * new ones start on the next run with the new settings.
 */
export function configureWorkers(next) {
    terminateWorkers();
    config = { ...config, ...next };
}
/** Stops all workers. They restart on demand. */
export function terminateWorkers() {
    shared?.terminate();
    shared = null;
}
//# sourceMappingURL=pool.js.map