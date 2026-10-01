/**
 * How the pool starts a worker when no `createWorker` is configured.
 *
 * The worker file sits next to this module and is found with
 * `new URL('./worker.js', import.meta.url)`, which bundlers understand. When the
 * package itself is loaded from another origin (a CDN), browsers refuse to start
 * a worker from that URL, so a same-origin Blob worker that imports it is used
 * instead. The CDN bundles replace this module with `default-worker.inline.ts`.
 */
import type { WorkerLike } from './pool.js';
/**
 * Returns a Blob URL for a module worker that imports the `worker.js` next to
 * `moduleUrl`, or null when that file is same-origin with the page and can be
 * started directly.
 */
export declare function crossOriginWorkerUrl(moduleUrl: string, pageOrigin: string | undefined): string | null;
export declare function defaultCreateWorker(): WorkerLike;
//# sourceMappingURL=default-worker.d.ts.map