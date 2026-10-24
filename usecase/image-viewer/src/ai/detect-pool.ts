/**
 * Workers that run a detection model over tiles, side by side: on the GPU
 * (WebGPU) one worker, on the CPU (WebAssembly) several, each with its own
 * session (cpuPlan says how many, and on how many threads). The page only
 * cuts the tiles out and gathers what is found.
 */
import type { Detection } from './detect.js';
import type { DetectRequest } from './detect-worker.js';
import type { DetectorSpec } from './model-config.js';
import type { Backend } from './runtime.js';

type Reply = { type: 'loaded'; backend: Backend } | { type: 'done'; id: number; found: Detection[] } | { type: 'error'; id: number; message: string };

export interface DetectPool {
  backend: Backend;
  /** Workers running tiles side by side. */
  size: number;
  /** The objects in an RGBA tile (its buffer is handed to the worker), in the tile's pixels. */
  run(rgba: Uint8ClampedArray, width: number, height: number, spec: DetectorSpec): Promise<Detection[]>;
  /** Whether a worker has stopped (or the pool was terminated): every run fails, so the pool is made again. */
  readonly dead: boolean;
  terminate(): void;
}

/**
 * How the CPU (WebAssembly) runs the tiles: how many workers (each holds the
 * model) and how many threads each. One core is left to the page, the GPU
 * process and the map's own workers, so the page stays quick to answer.
 * - Cross-origin isolated (the service worker makes the page so): ONNX
 *   Runtime runs a session on several threads, which beats more sessions on
 *   one thread each (measured on 4 cores: 1 × 3 threads took 7.3 s where 2 × 1
 *   took 12.3 s for 3 large tiles, 9.7 s against 13.3 s for 30 small ones);
 *   a second worker only from 6 cores, threads at most 4 each.
 * - Otherwise one thread per session: half the cores in workers, at most 3.
 */
export function cpuPlan(cores = navigator.hardwareConcurrency || 2, isolated = globalThis.crossOriginIsolated === true): { workers: number; threads: number } {
  if (!isolated) return { workers: Math.max(1, Math.min(3, Math.floor(cores / 2))), threads: 1 };
  const budget = Math.max(1, Math.min(8, cores - 1));
  const workers = budget >= 6 ? 2 : 1;
  return { workers, threads: Math.min(4, Math.floor(budget / workers)) };
}

/** How many CPU workers run tiles side by side. */
export const cpuWorkers = () => cpuPlan().workers;

/** Starts the workers and loads the model (`bytes`) in each. */
export async function createDetectPool(bytes: Uint8Array, name: string, useGpu = true): Promise<DetectPool> {
  const workers: Worker[] = [];
  const start = async (gpu: boolean): Promise<{ worker: Worker; backend: Backend }> => {
    const worker = new Worker(new URL('./detect-worker.ts', import.meta.url), { type: 'module' });
    workers.push(worker);
    const backend = await new Promise<Backend>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<Reply>) => (e.data.type === 'loaded' ? resolve(e.data.backend) : e.data.type === 'error' ? reject(new Error(e.data.message)) : undefined);
      worker.onerror = (e) => reject(new Error(e.message || 'ワーカーの起動に失敗'));
      worker.postMessage({ type: 'load', bytes: bytes.slice(), name, useGpu: gpu, threads: cpuPlan().threads } satisfies DetectRequest);
    });
    return { worker, backend };
  };
  try {
    const first = await start(useGpu);
    const ready = [first.worker];
    if (first.backend === 'wasm') ready.push(...(await Promise.all(Array.from({ length: cpuWorkers() - 1 }, () => start(false)))).map((w) => w.worker));
    return pool(ready, first.backend);
  } catch (error) {
    for (const w of workers) w.terminate();
    throw error;
  }
}

function pool(workers: Worker[], backend: Backend): DetectPool {
  const idle = [...workers];
  const queue: Array<{ send: (worker: Worker) => void; reject: (error: Error) => void }> = [];
  const pending = new Map<number, { resolve: (found: Detection[]) => void; reject: (error: Error) => void; worker: Worker }>();
  let next = 0;
  let dead: Error | null = null;
  const release = (worker: Worker) => {
    const waiting = queue.shift();
    if (waiting) waiting.send(worker);
    else idle.push(worker);
  };
  /** Fails every job (running, or waiting for a worker) with `error`. */
  const fail = (error: Error) => {
    dead = error;
    for (const job of pending.values()) job.reject(error);
    pending.clear();
    for (const job of queue.splice(0)) job.reject(error);
  };
  for (const worker of workers) {
    worker.onmessage = (e: MessageEvent<Reply>) => {
      const reply = e.data;
      if (reply.type === 'loaded') return;
      const job = pending.get(reply.id);
      if (!job) return;
      pending.delete(reply.id);
      release(worker);
      if (reply.type === 'done') job.resolve(reply.found);
      else job.reject(new Error(reply.message));
    };
    worker.onerror = (e) => {
      // One stopped worker fails the pool: what was sent to the others is let go too, and the pool is made again next time.
      for (const w of workers) w.terminate();
      fail(new Error(e.message || 'ワーカーが停止'));
    };
  }
  return {
    backend,
    size: workers.length,
    get dead() {
      return dead !== null;
    },
    run(rgba, width, height, spec) {
      if (dead) return Promise.reject(dead);
      return new Promise((resolve, reject) => {
        const send = (worker: Worker) => {
          const id = next++;
          pending.set(id, { resolve, reject, worker });
          worker.postMessage({ type: 'run', id, rgba, width, height, spec } satisfies DetectRequest, [rgba.buffer]);
        };
        const worker = idle.pop();
        if (worker) send(worker);
        else queue.push({ send, reject });
      });
    },
    terminate() {
      for (const w of workers) w.terminate();
      fail(new Error('中止'));
    },
  };
}
