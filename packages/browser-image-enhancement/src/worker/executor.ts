/**
 * Runs a chain of normalized ops on an image, in workers when possible.
 *
 * The image is cut into horizontal strips, one per worker. Each strip's pixels
 * are copied once into their own buffer and transferred to the worker and back.
 * In `auto` color mode with several strips, workers first report whether their
 * strip is monochrome so the whole image is computed in one mode. With
 * `autoStretch` they also report their strip's histogram, and the main thread
 * resolves one stretch for the whole image from the sum.
 */
import { abortError, race, splitRows, stripCount, throwIfAborted, yieldToEventLoop } from '@browser-image/workers';
import { grayFromRgb, mergeHistograms, needsStats, resolveForPixels, resolveOps } from '../core/histogram.js';
import { compile, processPixels, resolveMode, type ResolvedMode } from '../core/process.js';
import type { ColorMode, Histogram, ImageDataLike, OpSpec } from '../types.js';
import { getPool, WorkerUnavailableError, type Slot, type WorkerPool } from './pool.js';
import type { WorkerResponse } from './protocol.js';

export { abortError, splitRows };

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

/** Processes on the calling thread. */
export function executeOnMainThread(image: ImageDataLike, ops: readonly OpSpec[], colorMode: ColorMode = 'auto'): ExecuteResult {
  const mode = resolveMode(image.data, colorMode);
  const data = new Uint8ClampedArray(image.data.length);
  processPixels(image.data, data, compile(resolveForPixels(ops, image.data, mode), mode));
  return { data, width: image.width, height: image.height, mode, usedWorker: false };
}

export async function execute(image: ImageDataLike, ops: readonly OpSpec[], options: ExecuteOptions = {}): Promise<ExecuteResult> {
  const { colorMode = 'auto', signal } = options;
  throwIfAborted(signal);
  if (options.worker === false) return executeOnMainThread(image, ops, colorMode);

  const pool = options.pool ?? getPool();
  if (!pool.available) return executeOnMainThread(image, ops, colorMode);

  const pixels = image.width * image.height;
  const wanted = stripCount(pixels, image.height, pool.maxWorkers, pool.minStripPixels);
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
  const stats = needsStats(ops);
  const twoPhase = ranges.length > 1 && (colorMode === 'auto' || stats);
  // In auto mode a gray result means every pixel is gray, so the R histogram is the gray one.
  const statsMode: ResolvedMode | null = stats ? (colorMode === 'gray' ? 'gray' : 'rgb') : null;
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
      ? pool.request(slots[i], { type: 'detect', id: ids[i], buffer, stats: statsMode }, [buffer])
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
    const reports = detected as Array<Extract<WorkerResponse, { type: 'detected' }>>;
    const mode: ResolvedMode = colorMode === 'auto' ? (reports.every((r) => r.mono) ? 'gray' : 'rgb') : colorMode;
    let resolved = ops;
    if (stats) {
      const merged = mergeHistograms(reports.map((r) => r.stats as Histogram));
      resolved = resolveOps(ops, mode === 'gray' ? grayFromRgb(merged) : merged);
    }
    pending = ids.map((id, i) => pool.request(slots[i], { type: 'process', id, ops: resolved, mode }));
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
