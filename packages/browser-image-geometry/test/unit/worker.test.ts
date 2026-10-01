import type { ControlResponse } from '@browser-image/workers';
import { afterEach, describe, expect, it } from 'vitest';
import { affine, fitTransform, identity, projective, rotation, scaling, warpImageData, type CoordinateTransform, type Point } from '../../src/index.js';
import { planWarp, type OutputOptions } from '../../src/plan.js';
import type { Transform } from '../../src/types.js';
import { execute } from '../../src/worker/executor.js';
import { createWorkerHandler } from '../../src/worker/handler.js';
import { terminateWorkers, WorkerPool, type WorkerLike } from '../../src/worker/pool.js';
import type { WorkerRequest, WorkerResponse } from '../../src/worker/protocol.js';
import { noiseImage } from '../helpers.js';

type Behavior = 'ok' | 'throw' | 'crash-on-first-job' | 'error-reply';

/** Runs the real handler asynchronously with real transfer semantics. */
class FakeWorker implements WorkerLike {
  static jobs: Array<{ y0: number; y1: number; windowPixels: number }> = [];
  private listeners: Record<string, Array<(e: any) => void>> = { message: [], error: [], messageerror: [] };
  private handle: (r: WorkerRequest) => void;
  private terminated = false;

  constructor(private behavior: Behavior = 'ok') {
    if (behavior === 'throw') throw new DOMException('Blocked by CSP', 'SecurityError');
    this.handle = createWorkerHandler((msg, transfer) => this.emit('message', { data: structuredClone(msg, { transfer }) }));
    setTimeout(() => this.emit('message', { data: { type: 'ready' } }), 1);
  }

  postMessage(message: WorkerRequest, transfer: Transferable[]): void {
    const cloned = structuredClone(message, { transfer: transfer as any });
    FakeWorker.jobs.push({ y0: message.y0, y1: message.y1, windowPixels: message.window ? message.window.width * message.window.height : 0 });
    setTimeout(() => {
      if (this.terminated) return;
      if (this.behavior === 'crash-on-first-job') return this.emit('error', { preventDefault() {} });
      if (this.behavior === 'error-reply') return this.emit('message', { data: { type: 'error', id: cloned.id, message: 'boom' } });
      this.handle(cloned);
    }, 1);
  }

  addEventListener(type: string, listener: (e: any) => void): void {
    this.listeners[type].push(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  private emit(type: string, event: { data?: WorkerResponse | ControlResponse } | object): void {
    if (this.terminated) return;
    setTimeout(() => this.listeners[type].forEach((l) => l(event)), 0);
  }
}

function pool(behavior: Behavior = 'ok', maxWorkers = 4) {
  return new WorkerPool({ maxWorkers, minStripPixels: 50, startupTimeout: 200, createWorker: () => new FakeWorker(behavior) });
}

afterEach(() => {
  FakeWorker.jobs = [];
  terminateWorkers();
});

const R = 6378137;
const mercator: CoordinateTransform = {
  forward: ([lon, lat]) => [(R * lon * Math.PI) / 180, R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))],
  inverse: ([x, y]) => [(x / R) * (180 / Math.PI), (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI)],
};

const grid: Point[] = [];
for (let y = 0; y <= 3; y++) for (let x = 0; x <= 3; x++) grid.push([x * 20 + 1, y * 15 + 2]);
const poly = fitTransform(
  grid.map((p) => ({ pixel: p, world: [p[0] * 1.1 + 0.002 * p[0] * p[1], p[1] * 0.9 + 0.001 * p[0] * p[0]] as Point })),
  { model: 'polynomial3', target: 'image' },
).transform;

const cases: Array<[string, Transform, OutputOptions]> = [
  ['identity', identity(), {}],
  ['rotation, bicubic', rotation(23, [30, 25]), { resample: 'bicubic' }],
  ['rotation, nearest, background', rotation(-71, [30, 25]), { resample: 'nearest', background: [9, 8, 7, 255] }],
  ['projective', projective([1.1, 0.2, 3, -0.1, 0.95, 2, 0.002, -0.001, 1]), {}],
  ['polynomial', poly, { resample: 'bicubic' }],
  ['shrink 5x (pre-halved)', scaling(0.2), {}],
  ['coordinate transform grid', affine([0.2, 0, 130, 0, -0.2, 45], { yUp: true }), { coordinateTransform: mercator, gridStep: 8 }],
  ['partial extent', identity(), { extent: [-10, 20, 30, 80], width: 37, height: 53 }],
];

describe('workers', () => {
  for (const [name, t, options] of cases) {
    it(`${name}: worker strips match the main thread exactly`, async () => {
      const img = noiseImage(61, 50);
      const sync = warpImageData(img, t, options);
      for (const n of [2, 3, 4]) {
        const res = await execute(img, planWarp(img.width, img.height, t, options), { pool: pool('ok', n) });
        expect(res.usedWorker).toBe(true);
        expect(res.image.width).toBe(sync.width);
        expect(Array.from(res.image.data)).toEqual(Array.from(sync.image.data));
      }
    });
  }

  it('sends each strip only the source rows it reads', async () => {
    const img = noiseImage(40, 400);
    await execute(img, planWarp(40, 400, identity()), { pool: pool('ok', 4) });
    expect(FakeWorker.jobs).toHaveLength(4);
    for (const job of FakeWorker.jobs) expect(job.windowPixels).toBeLessThanOrEqual(40 * (job.y1 - job.y0 + 4));
  });

  for (const behavior of ['throw', 'crash-on-first-job'] as const) {
    it(`falls back to the main thread when workers ${behavior}`, async () => {
      const img = noiseImage(30, 30);
      const plan = planWarp(30, 30, rotation(10, [15, 15]));
      const res = await execute(img, plan, { pool: pool(behavior, 2) });
      expect(res.usedWorker).toBe(false);
      expect(Array.from(res.image.data)).toEqual(Array.from(warpImageData(img, rotation(10, [15, 15])).image.data));
    });
  }

  it('reports a worker error', async () => {
    const img = noiseImage(30, 30);
    await expect(execute(img, planWarp(30, 30, identity()), { pool: pool('error-reply', 2) })).rejects.toThrow('boom');
  });

  it('can be aborted', async () => {
    const img = noiseImage(30, 30);
    const controller = new AbortController();
    const pending = execute(img, planWarp(30, 30, identity()), { pool: pool('ok', 2), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  });

  it('runs on the main thread when asked', async () => {
    const img = noiseImage(10, 10);
    const res = await execute(img, planWarp(10, 10, identity()), { worker: false, pool: pool() });
    expect(res.usedWorker).toBe(false);
  });
});
