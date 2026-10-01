/**
 * CDN-bundle replacement for `default-worker.ts`: the worker is bundled into the
 * library file itself and started from a Blob URL, so it works from any origin
 * and needs no second file. CSP `worker-src` must allow `blob:`; otherwise the
 * pool falls back to the main thread.
 */
import InlineWorker from '../src/worker/worker.ts?worker&inline';
import type { WorkerLike } from '../src/worker/pool.js';

export function defaultCreateWorker(): WorkerLike {
  return new InlineWorker() as unknown as WorkerLike;
}
