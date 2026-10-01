//#region ../workers/src/pool.d.ts
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
export type ControlResponse = {
  type: 'ready';
} | {
  type: 'error';
  id: number;
  message: string;
};
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
//#endregion
//# sourceMappingURL=pool.d.ts.map