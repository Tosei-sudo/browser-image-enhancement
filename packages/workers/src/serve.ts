/** Worker-side bootstrap: wires a package's message handler to the worker scope. */
import type { ControlResponse } from './pool.js';

/** Sends a message back to the main thread, transferring the given buffers. */
export type Post<Res> = (message: Res | ControlResponse, transfer?: Transferable[]) => void;

interface WorkerScope<Req, Res> {
  postMessage(message: Res | ControlResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<Req>) => void) | null;
}

/**
 * Runs inside the worker. `createHandler` receives a `post` function and returns
 * the handler for each request. Sends `ready` once the handler is installed.
 */
export function serveWorker<Req, Res>(createHandler: (post: Post<Res>) => (request: Req) => void): void {
  const scope = self as unknown as WorkerScope<Req, Res>;
  const handle = createHandler((message, transfer) => scope.postMessage(message, transfer ?? []));
  scope.onmessage = (event) => handle(event.data);
  scope.postMessage({ type: 'ready' });
}
