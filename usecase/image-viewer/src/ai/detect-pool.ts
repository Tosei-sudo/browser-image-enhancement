/**
 * Workers that run a detection model over tiles, side by side: on the GPU
 * (WebGPU) one worker, on the CPU (WebAssembly) several, each with its own
 * session, since without cross-origin isolation ONNX Runtime runs one thread
 * per session. The page only cuts the tiles out and gathers what is found.
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
  terminate(): void;
}

/**
 * How many CPU workers: half the cores, at most 3 (each holds the model). The
 * rest are left to the page, the GPU process and the map's own workers, so
 * the page stays quick to answer while the tiles run.
 */
export const cpuWorkers = () => Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency || 2) / 2)));

/** Starts the workers and loads the model (`bytes`) in each. */
export async function createDetectPool(bytes: Uint8Array, name: string, useGpu = true): Promise<DetectPool> {
  const workers: Worker[] = [];
  const start = async (gpu: boolean): Promise<{ worker: Worker; backend: Backend }> => {
    const worker = new Worker(new URL('./detect-worker.ts', import.meta.url), { type: 'module' });
    workers.push(worker);
    const backend = await new Promise<Backend>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<Reply>) => (e.data.type === 'loaded' ? resolve(e.data.backend) : e.data.type === 'error' ? reject(new Error(e.data.message)) : undefined);
      worker.onerror = (e) => reject(new Error(e.message || 'ワーカーを起動できませんでした'));
      worker.postMessage({ type: 'load', bytes: bytes.slice(), name, useGpu: gpu } satisfies DetectRequest);
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
  const queue: Array<(worker: Worker) => void> = [];
  const pending = new Map<number, { resolve: (found: Detection[]) => void; reject: (error: Error) => void; worker: Worker }>();
  let next = 0;
  let dead: Error | null = null;
  const release = (worker: Worker) => {
    const waiting = queue.shift();
    if (waiting) waiting(worker);
    else idle.push(worker);
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
      dead = new Error(e.message || 'ワーカーが止まりました');
      for (const [id, job] of pending) {
        if (job.worker !== worker) continue;
        pending.delete(id);
        job.reject(dead);
      }
    };
  }
  return {
    backend,
    size: workers.length,
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
        else queue.push(send);
      });
    },
    terminate() {
      dead = new Error('中止しました');
      for (const w of workers) w.terminate();
      for (const job of pending.values()) job.reject(dead);
      pending.clear();
      queue.length = 0;
    },
  };
}
