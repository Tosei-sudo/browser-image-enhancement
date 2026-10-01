/**
 * This package's worker pool: the shared pool from @browser-image/workers,
 * typed with this package's messages and started with its own worker script.
 */
import {
  createSharedPool,
  WorkerPool as SharedWorkerPool,
  type ControlResponse,
  type Slot as SharedSlot,
  type WorkerConfig as SharedWorkerConfig,
} from '@browser-image/workers';
import { defaultCreateWorker } from './default-worker.js';
import type { WorkerRequest, WorkerResponse } from './protocol.js';

export { WorkerUnavailableError } from '@browser-image/workers';

/** The part of `Worker` the pool uses. Lets tests and custom setups supply their own. */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerResponse | ControlResponse>) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  terminate(): void;
}

export interface WorkerConfig extends SharedWorkerConfig<WorkerRequest, WorkerResponse> {
  /** Creates a worker. Override to serve the worker script from a custom URL. */
  createWorker?: () => WorkerLike;
}

export type Slot = SharedSlot<WorkerRequest, WorkerResponse>;

export class WorkerPool extends SharedWorkerPool<WorkerRequest, WorkerResponse> {
  constructor(config: WorkerConfig = {}) {
    super(config, defaultCreateWorker);
  }
}

const shared = createSharedPool<WorkerRequest, WorkerResponse>(defaultCreateWorker);

/** The pool used by `pipeline().run()`. */
export const getPool: () => WorkerPool = shared.getPool;

/**
 * Changes how workers are created and how many run. Stops the current workers;
 * new ones start on the next run with the new settings.
 */
export function configureWorkers(next: WorkerConfig): void {
  shared.configureWorkers(next);
}

/** Stops all workers. They restart on demand. */
export function terminateWorkers(): void {
  shared.terminateWorkers();
}
