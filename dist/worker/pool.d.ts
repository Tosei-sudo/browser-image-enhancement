import type { WorkerRequest, WorkerResponse } from './protocol.js';
/** The part of `Worker` the pool uses. Lets tests and custom setups supply their own. */
export interface WorkerLike {
    postMessage(message: WorkerRequest, transfer: Transferable[]): void;
    addEventListener(type: 'message', listener: (event: MessageEvent<WorkerResponse>) => void): void;
    addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
    terminate(): void;
}
export interface WorkerConfig {
    /** Most workers to run at once. Default `navigator.hardwareConcurrency` (4 if unknown). */
    maxWorkers?: number;
    /** Smallest strip, in pixels, worth sending to its own worker. Default 262144 (512x512). */
    minStripPixels?: number;
    /** How long a new worker may take to start before the pool gives up on it, in ms. Default 10000. */
    startupTimeout?: number;
    /** Creates a worker. Override to serve the worker script from a custom URL. */
    createWorker?: () => WorkerLike;
}
/** Thrown when no worker could be started; callers fall back to the main thread. */
export declare class WorkerUnavailableError extends Error {
    name: string;
}
interface Pending {
    resolve: (response: WorkerResponse) => void;
    reject: (error: Error) => void;
}
export interface Slot {
    readonly worker: WorkerLike;
    /** Requests sent and not yet answered. */
    load: number;
    dead: boolean;
    readonly pending: Map<number, Pending>;
}
export declare class WorkerPool {
    readonly maxWorkers: number;
    readonly minStripPixels: number;
    private readonly startupTimeout;
    private readonly create;
    private readonly slots;
    private starting;
    private failed;
    private capacity;
    constructor(config?: WorkerConfig);
    /** False once workers have failed to start; the pool then stays on the main thread. */
    get available(): boolean;
    /** Number of live workers. */
    get size(): number;
    /**
     * Returns up to `count` started workers, least busy first, starting new ones as needed.
     * Rejects with WorkerUnavailableError if none can run.
     */
    acquire(count: number): Promise<Slot[]>;
    private startWorkers;
    private startOne;
    /** Sends a request and resolves with the worker's answer for the same id. */
    request(slot: Slot, message: Exclude<WorkerRequest, {
        type: 'release';
    }>, transfer?: Transferable[]): Promise<WorkerResponse>;
    /** Fire-and-forget message (used for `release`). */
    notify(slot: Slot, message: WorkerRequest): void;
    private kill;
    /** Stops every worker. Pending requests reject. */
    terminate(): void;
}
/** The pool used by `pipeline().run()`. */
export declare function getPool(): WorkerPool;
/**
 * Changes how workers are created and how many run. Stops the current workers;
 * new ones start on the next run with the new settings.
 */
export declare function configureWorkers(next: WorkerConfig): void;
/** Stops all workers. They restart on demand. */
export declare function terminateWorkers(): void;
export {};
//# sourceMappingURL=pool.d.ts.map