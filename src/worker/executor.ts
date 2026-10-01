/**
 * Runs a chain of normalized ops on an image, in workers when possible.
 *
 * The image is cut into horizontal strips, one per worker. Each strip's pixels
 * are copied once into their own buffer and transferred to the worker and back.
 * In `auto` color mode with several strips, workers first report whether their
 * strip is monochrome so the whole image is computed in one mode.
 */
import { compile, processPixels, resolveMode, type ResolvedMode } from '../core/process.js';
import type { ColorMode, ImageDataLike, OpSpec } from '../types.js';
import { getPool, WorkerUnavailableError, type Slot, type WorkerPool } from './pool.js';
import type { WorkerResponse } from './protocol.js';

export interface ExecuteOptions {
  colorMode?: ColorMode;
  /** Use workers (default true). Falls back to the main thread when they cannot start. */
  worker?: boolean;
  signal?: AbortSignal;
  /** Pool to use; defaults to the shared one. */
  pool?: WorkerPool;
}

export interface ExecuteResult {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** The mode pixels were computed in. */
  mode: ResolvedMode;
  /** True when the work ran in workers. */
  usedWorker: boolean;
}

let nextId = 1;

export function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  if (typeof DOMException !== 'undefined') return new DOMException('The operation was aborted.', 'AbortError');
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

/** Processes on the calling thread. */
export function executeOnMainThread(image: ImageDataLike, ops: readonly OpSpec[], colorMode: ColorMode = 'auto'): ExecuteResult {
  const mode = resolveMode(image.data, colorMode);
  const data = new Uint8ClampedArray(image.data.length);
  processPixels(image.data, data, compile(ops, mode));
  return { data, width: image.width, height: image.height, mode, usedWorker: false };
}

/** Splits `height` rows into `count` contiguous ranges of near-equal size. */
export function splitRows(height: number, count: number): Array<[start: number, end: number]> {
  const n = Math.max(1, Math.min(count, height));
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) ranges.push([Math.floor((height * i) / n), Math.floor((height * (i + 1)) / n)]);
  return ranges;
}

/** Resolves with `promise`, or rejects as soon as `signal` aborts. */
function race<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

export async function execute(image: ImageDataLike, ops: readonly OpSpec[], options: ExecuteOptions = {}): Promise<ExecuteResult> {
  const { colorMode = 'auto', signal } = options;
  throwIfAborted(signal);
  if (options.worker === false) return executeOnMainThread(image, ops, colorMode);

  const pool = options.pool ?? getPool();
  if (!pool.available) return executeOnMainThread(image, ops, colorMode);

  const pixels = image.width * image.height;
  const wanted = Math.min(pool.maxWorkers, Math.ceil(pixels / pool.minStripPixels), image.height);
  let slots: Slot[];
  try {
    slots = await race(pool.acquire(wanted), signal);
  } catch (e) {
    if (e instanceof WorkerUnavailableError) return executeOnMainThread(image, ops, colorMode);
    throw e;
  }

  try {
    return await race(runInWorkers(pool, slots, image, [...ops], colorMode, signal), signal);
  } catch (e) {
    // The input was copied, not transferred, so a worker failure can be retried here.
    if (e instanceof WorkerUnavailableError) {
      throwIfAborted(signal);
      return executeOnMainThread(image, ops, colorMode);
    }
    throw e;
  }
}

/** Lets other main-thread tasks (rendering, input) run between strip copies. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type Done = Extract<WorkerResponse, { type: 'done' }>;

async function runInWorkers(
  pool: WorkerPool,
  slots: Slot[],
  image: ImageDataLike,
  ops: OpSpec[],
  colorMode: ColorMode,
  signal?: AbortSignal,
): Promise<ExecuteResult> {
  const rowBytes = image.width * 4;
  const ranges = splitRows(image.height, slots.length);
  const ids = ranges.map(() => nextId++);
  const twoPhase = ranges.length > 1 && colorMode === 'auto';
  const release = () => ids.forEach((id, i) => pool.notify(slots[i], { type: 'release', id }));

  // Copy and send one strip at a time so the main thread is never blocked for
  // the whole image; each worker starts as soon as its strip arrives.
  const sent: Array<Promise<WorkerResponse>> = [];
  for (let i = 0; i < ranges.length; i++) {
    if (i > 0) {
      await yieldToEventLoop();
      if (signal?.aborted) {
        if (twoPhase) release();
        throw abortError(signal);
      }
    }
    const [start, end] = ranges[i];
    const buffer = image.data.slice(start * rowBytes, end * rowBytes).buffer;
    const reply = twoPhase
      ? pool.request(slots[i], { type: 'detect', id: ids[i], buffer }, [buffer])
      : pool.request(slots[i], { type: 'run', id: ids[i], buffer, ops, colorMode }, [buffer]);
    // A strip may fail while later strips are still being sent; it is handled
    // by the Promise.all below, so don't let it surface as an unhandled rejection.
    reply.catch(() => {});
    sent.push(reply);
  }

  let pending = sent;
  if (twoPhase) {
    let detected: WorkerResponse[];
    try {
      detected = await Promise.all(sent);
    } catch (e) {
      release();
      throw e;
    }
    if (signal?.aborted) {
      release();
      throw abortError(signal);
    }
    const mode: ResolvedMode = detected.every((r) => r.type === 'detected' && r.mono) ? 'gray' : 'rgb';
    pending = ids.map((id, i) => pool.request(slots[i], { type: 'process', id, ops, mode }));
  }

  if (pending.length === 1) {
    const done = (await pending[0]) as Done;
    return { data: new Uint8ClampedArray(done.buffer), width: image.width, height: image.height, mode: done.mode, usedWorker: true };
  }
  const data = new Uint8ClampedArray(image.data.length);
  const modes = await Promise.all(
    pending.map(async (reply, i) => {
      const done = (await reply) as Done;
      data.set(new Uint8ClampedArray(done.buffer), ranges[i][0] * rowBytes);
      return done.mode;
    }),
  );
  return { data, width: image.width, height: image.height, mode: modes[0], usedWorker: true };
}
