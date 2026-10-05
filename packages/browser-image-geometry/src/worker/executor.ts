/**
 * Renders a plan in workers when possible: the output is cut into horizontal
 * strips, and each worker receives only the source rectangle its strip reads.
 */
import {
  abortError,
  createImageData,
  race,
  splitRows,
  stripCount,
  throwIfAborted,
  WorkerUnavailableError,
  yieldToEventLoop,
  type ImageDataLike,
} from '@browser-image/workers';
import { shrink, sourceBounds, type Plan } from '../plan.js';
import { renderPlan } from '../render.js';
import { getPool, type Slot, type WorkerPool } from './pool.js';
import type { WorkerRequest } from './protocol.js';

export interface ExecuteOptions {
  /** Use workers (default true). Falls back to the main thread when they cannot start. */
  worker?: boolean;
  signal?: AbortSignal;
  /** Pool to use; defaults to the shared one. */
  pool?: WorkerPool;
}

export interface ExecuteResult {
  image: ImageData;
  usedWorker: boolean;
}

let nextId = 1;

export async function execute(image: ImageDataLike, plan: Plan, options: ExecuteOptions = {}): Promise<ExecuteResult> {
  const { signal } = options;
  throwIfAborted(signal);
  const onMain = (): ExecuteResult => ({ image: renderPlan(image, plan), usedWorker: false });
  if (options.worker === false) return onMain();
  const pool = options.pool ?? getPool();
  if (!pool.available) return onMain();

  let slots: Slot[];
  try {
    slots = await race(pool.acquire(stripCount(plan.width * plan.height, plan.height, pool.maxWorkers, pool.minStripPixels)), signal);
  } catch (e) {
    if (e instanceof WorkerUnavailableError) return onMain();
    throw e;
  }
  const sent: Sent[] = [];
  try {
    const result = await race(runInWorkers(pool, slots, image, plan, sent, signal), signal);
    return { image: result, usedWorker: true };
  } catch (e) {
    // Stop the strips still being computed rather than letting them run on.
    if (signal?.aborted) for (const { slot, id } of sent) pool.cancel(slot, [id], abortError(signal));
    // The source was copied, not transferred, so it is still here to retry with.
    if (e instanceof WorkerUnavailableError) {
      throwIfAborted(signal);
      return onMain();
    }
    throw e;
  }
}

/** Copies the source rectangle `[left, top, right, bottom)` into its own buffer. */
function copyWindow(src: { data: Uint8ClampedArray; width: number }, [left, top, right, bottom]: [number, number, number, number]) {
  const w = right - left;
  const h = bottom - top;
  if (left === 0 && w === src.width) {
    return { buffer: src.data.slice(top * w * 4, bottom * w * 4).buffer, width: w, height: h, x0: left, y0: top };
  }
  const data = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++) {
    const s = ((top + j) * src.width + left) * 4;
    data.set(src.data.subarray(s, s + w * 4), j * w * 4);
  }
  return { buffer: data.buffer, width: w, height: h, x0: left, y0: top };
}

/** A strip request sent to a worker. */
interface Sent {
  slot: Slot;
  id: number;
}

async function runInWorkers(pool: WorkerPool, slots: Slot[], image: ImageDataLike, plan: Plan, sent: Sent[], signal?: AbortSignal): Promise<ImageData> {
  const src = shrink(image, plan.levels);
  const { width, height } = plan;
  const ranges = splitRows(height, slots.length);
  const replies: Array<Promise<{ buffer: ArrayBuffer }>> = [];
  for (let i = 0; i < ranges.length; i++) {
    if (i > 0) {
      await yieldToEventLoop();
      throwIfAborted(signal);
    }
    const [y0, y1] = ranges[i];
    const bounds = sourceBounds(plan.mapping, width, y0, y1, src.width, src.height, plan.resample);
    const window = bounds ? copyWindow(src, bounds) : null;
    const id = nextId++;
    const message: WorkerRequest = {
      type: 'warp',
      id,
      window,
      width,
      y0,
      y1,
      mapping: plan.mapping,
      resample: plan.resample,
      background: plan.background,
      clampEdges: plan.clampEdges,
    };
    const reply = pool.request(slots[i], message, window ? [window.buffer] : []);
    // A strip may fail while later strips are still being sent; Promise.all below reports it.
    reply.catch(() => {});
    replies.push(reply);
    sent.push({ slot: slots[i], id });
  }
  if (replies.length === 1) return createImageData(new Uint8ClampedArray((await replies[0]).buffer), width, height);
  const out = new Uint8ClampedArray(width * height * 4);
  await Promise.all(
    replies.map(async (reply, i) => {
      out.set(new Uint8ClampedArray((await reply).buffer), ranges[i][0] * width * 4);
    }),
  );
  return createImageData(out, width, height);
}
