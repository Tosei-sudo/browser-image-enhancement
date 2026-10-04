/** Worker-side message handling, kept free of worker globals so it can be tested directly. */
import type { Post } from '@browser-image/workers';
import { renderRows } from '../resample.js';
import type { WorkerRequest, WorkerResponse } from './protocol.js';

const EMPTY = new Uint8ClampedArray(0);

export function createWorkerHandler(post: Post<WorkerResponse>): (request: WorkerRequest) => void {
  return (request) => {
    try {
      if (request.type !== 'warp') throw new Error(`Unknown request: ${String((request as { type: unknown }).type)}`);
      const { window: w, width, y0, y1 } = request;
      const src = w
        ? { data: new Uint8ClampedArray(w.buffer), width: w.width, height: w.height, x0: w.x0, y0: w.y0 }
        : { data: EMPTY, width: 0, height: 0, x0: 0, y0: 0 };
      const out = new Uint8ClampedArray((y1 - y0) * width * 4);
      renderRows(src, request.mapping, width, y0, y1, request.resample, request.background, out, request.clampEdges);
      post({ type: 'done', id: request.id, buffer: out.buffer }, [out.buffer]);
    } catch (e) {
      post({ type: 'error', id: request.id, message: e instanceof Error ? e.message : String(e) });
    }
  };
}
