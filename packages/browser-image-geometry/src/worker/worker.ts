/** Web Worker entry. Loaded by the pool with `new URL('./worker.js', import.meta.url)`. */
import { serveWorker } from '@browser-image/workers';
import { createWorkerHandler } from './handler.js';

serveWorker(createWorkerHandler);
