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

const shims = new Map<string, string>();

/**
 * Returns a Blob URL for a module worker that imports the `worker.js` next to
 * `moduleUrl`, or null when that file is same-origin with the page and can be
 * started directly.
 */
export function crossOriginWorkerUrl(moduleUrl: string, pageOrigin: string | undefined): string | null {
  // Not written as `new URL('./worker.js', import.meta.url)` so bundlers don't treat it as an asset.
  const script = new URL('worker.js', moduleUrl);
  if (pageOrigin === undefined || script.origin === pageOrigin) return null;
  let shim = shims.get(script.href);
  if (!shim) {
    // One small Blob per script URL, kept for the page's lifetime so workers can restart.
    shim = URL.createObjectURL(new Blob([`import ${JSON.stringify(script.href)};`], { type: 'text/javascript' }));
    shims.set(script.href, shim);
  }
  return shim;
}

export function defaultCreateWorker(): WorkerLike {
  const shim = crossOriginWorkerUrl(import.meta.url, globalThis.location?.origin);
  if (shim) return new Worker(shim, { type: 'module' }) as unknown as WorkerLike;
  return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}
