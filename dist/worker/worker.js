/** Web Worker entry. Loaded by the pool with `new URL('./worker.js', import.meta.url)`. */
import { createWorkerHandler } from './handler.js';
const scope = self;
const handle = createWorkerHandler((message, transfer) => scope.postMessage(message, transfer ?? []));
scope.onmessage = (event) => handle(event.data);
scope.postMessage({ type: 'ready' });
//# sourceMappingURL=worker.js.map