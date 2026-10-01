/** Web Worker entry. Loaded by the pool with `new URL('./worker.js', import.meta.url)`. */
import { createWorkerHandler } from './handler.js';
import type { WorkerRequest, WorkerResponse } from './protocol.js';

interface WorkerScope {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;
const handle = createWorkerHandler((message, transfer) => scope.postMessage(message, transfer ?? []));
scope.onmessage = (event) => handle(event.data);
scope.postMessage({ type: 'ready' });
