import { ControlResponse, WorkerConfig as WorkerConfig$1 } from "../workers/src/pool.js";
import { WorkerRequest, WorkerResponse } from "./protocol.js";
//#region src/worker/pool.d.ts
/** The part of `Worker` the pool uses. Lets tests and custom setups supply their own. */
export interface WorkerLike {
  /** Sends a job to the worker, transferring the listed buffers. */
  postMessage(message: WorkerRequest, transfer: Transferable[]): void;
  /** Receives the worker's results and its `ready` message. */
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerResponse | ControlResponse>) => void): void;
  /** Reports a worker that failed to load or to read a message. */
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  /** Stops the worker. */
  terminate(): void;
}
/** Settings for {@link configureWorkers}. */
export interface WorkerConfig extends WorkerConfig$1<WorkerRequest, WorkerResponse> {
  /** Creates a worker. Override to serve the worker script from a custom URL. */
  createWorker?: () => WorkerLike;
}
/**
 * Changes how workers are created and how many run. Stops the current workers;
 * new ones start on the next run with the new settings.
 */
export declare function configureWorkers(next: WorkerConfig): void;
/** Stops all workers. They restart on demand. */
export declare function terminateWorkers(): void;
//#endregion
//# sourceMappingURL=pool.d.ts.map