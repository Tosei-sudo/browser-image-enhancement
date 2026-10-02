import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { ControlResponse } from '@browser-image/workers';
import { compile, processPixels } from '../../src/core/process.js';
import { normalizeOp } from '../../src/ops/index.js';
import type { OpSpec } from '../../src/types.js';
import { execute, executeOnMainThread, splitRows } from '../../src/worker/executor.js';
import { createWorkerHandler } from '../../src/worker/handler.js';
import { configureWorkers, getPool, terminateWorkers, WorkerPool, type WorkerLike } from '../../src/worker/pool.js';
import type { WorkerRequest, WorkerResponse } from '../../src/worker/protocol.js';
import { grayImage, image, isGrayPixels, noiseImage, pixel } from '../helpers.js';

type Behavior = 'ok' | 'throw' | 'error' | 'silent' | 'crash-on-first-job' | 'error-reply';

/**
 * Runs the real worker handler asynchronously, with real transfer semantics
 * (structuredClone detaches transferred buffers in the sender).
 */
class FakeWorker implements WorkerLike {
  static created = 0;
  static log: WorkerRequest['type'][] = [];
  private listeners: Record<string, Array<(e: any) => void>> = { message: [], error: [], messageerror: [] };
  private handle: (r: WorkerRequest) => void;
  terminated = false;

  constructor(private behavior: Behavior = 'ok') {
    if (behavior === 'throw') throw new DOMException('Blocked by CSP', 'SecurityError');
    FakeWorker.created++;
    this.handle = createWorkerHandler((msg, transfer) => this.emit('message', { data: structuredClone(msg, { transfer }) }));
    setTimeout(() => {
      if (behavior === 'error') this.emit('error', { preventDefault() {} });
      else if (behavior !== 'silent') this.emit('message', { data: { type: 'ready' } });
    }, 1);
  }

  postMessage(message: WorkerRequest, transfer: Transferable[]): void {
    const cloned = structuredClone(message, { transfer: transfer as any });
    FakeWorker.log.push(message.type);
    setTimeout(() => {
      if (this.terminated) return;
      if (this.behavior === 'crash-on-first-job') return this.emit('error', { preventDefault() {} });
      if (this.behavior === 'error-reply' && cloned.type !== 'release') {
        return this.emit('message', { data: { type: 'error', id: cloned.id, message: 'boom' } });
      }
      this.handle(cloned);
    }, 1);
  }

  addEventListener(type: string, listener: (e: any) => void): void {
    this.listeners[type].push(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  private emit(type: string, event: unknown): void {
    if (this.terminated) return;
    setTimeout(() => this.listeners[type].forEach((l) => l(event)), 0);
  }
}

const OPS: OpSpec[] = [
  { op: 'brightness', amount: 0.1 },
  { op: 'contrast', amount: 0.25 },
  { op: 'saturation', amount: 0.4 },
  { op: 'temperature', amount: -0.3 },
  { op: 'levels', inBlack: 0.05, inWhite: 0.95, gamma: 1.2, outBlack: 0, outWhite: 1 },
].map(normalizeOp);

function pool(behavior: Behavior = 'ok', maxWorkers = 4, extra: Partial<ConstructorParameters<typeof WorkerPool>[0]> = {}) {
  return new WorkerPool({ maxWorkers, minStripPixels: 100, startupTimeout: 200, createWorker: () => new FakeWorker(behavior), ...extra });
}

let warnSpy: MockInstance;
beforeEach(() => {
  FakeWorker.created = 0;
  FakeWorker.log = [];
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  terminateWorkers();
  configureWorkers({ maxWorkers: undefined, minStripPixels: undefined, createWorker: undefined, startupTimeout: undefined });
});

describe('splitRows', () => {
  it('covers every row exactly once with near-equal strips', () => {
    for (const [h, n] of [[10, 3], [100, 4], [7, 7], [1, 4], [5, 1], [1000, 8]]) {
      const ranges = splitRows(h, n);
      expect(ranges.length).toBe(Math.min(h, n));
      expect(ranges[0][0]).toBe(0);
      expect(ranges[ranges.length - 1][1]).toBe(h);
      for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1]);
      const sizes = ranges.map(([a, b]) => b - a);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }
  });
});

describe('worker message handler', () => {
  function collect() {
    const out: Array<WorkerResponse | ControlResponse> = [];
    return { out, handle: createWorkerHandler((m) => out.push(m)) };
  }

  it('run: processes the buffer in place and returns it', () => {
    const { out, handle } = collect();
    const img = noiseImage(8, 8);
    const buffer = img.data.slice().buffer;
    handle({ type: 'run', id: 1, buffer, width: 8, ops: OPS, colorMode: 'auto' });
    expect(out).toHaveLength(1);
    const done = out[0] as Extract<WorkerResponse, { type: 'done' }>;
    expect(done).toMatchObject({ type: 'done', id: 1, mode: 'rgb' });
    expect(new Uint8ClampedArray(done.buffer)).toEqual(executeOnMainThread(img, OPS).data);
  });

  it('run: detects monochrome strips', () => {
    const { out, handle } = collect();
    handle({ type: 'run', id: 2, buffer: grayImage(4, 4).data.slice().buffer, width: 4, ops: OPS, colorMode: 'auto' });
    expect(out[0]).toMatchObject({ type: 'done', mode: 'gray' });
  });

  it('detect then process uses the held strip', () => {
    const { out, handle } = collect();
    const img = grayImage(4, 4);
    handle({ type: 'detect', id: 3, buffer: img.data.slice().buffer, width: 4, core: [0, 4], stats: null });
    expect(out[0]).toEqual({ type: 'detected', id: 3, mono: true, stats: null });
    handle({ type: 'process', id: 3, ops: OPS, mode: 'rgb' });
    expect(out[1]).toMatchObject({ type: 'done', id: 3, mode: 'rgb' });
  });

  it('release drops a held strip', () => {
    const { out, handle } = collect();
    handle({ type: 'detect', id: 4, buffer: new ArrayBuffer(16), width: 4, core: [0, 1], stats: null });
    handle({ type: 'release', id: 4 });
    handle({ type: 'process', id: 4, ops: [], mode: 'rgb' });
    expect(out[1]).toMatchObject({ type: 'error', id: 4 });
  });

  it('reports errors instead of throwing', () => {
    const { out, handle } = collect();
    handle({ type: 'run', id: 5, buffer: new ArrayBuffer(4), width: 1, ops: [{ op: 'bogus' } as any], colorMode: 'rgb' });
    expect(out[0]).toMatchObject({ type: 'error', id: 5 });
  });
});

describe('execute with workers', () => {
  it('splits across workers and matches the main thread exactly', async () => {
    const p = pool('ok', 4);
    const img = noiseImage(37, 41, 5);
    const res = await execute(img, OPS, { pool: p });
    expect(res.usedWorker).toBe(true);
    expect(FakeWorker.created).toBe(4);
    expect(res.data).toEqual(executeOnMainThread(img, OPS).data);
    expect(res.mode).toBe('rgb');
  });

  it('never splits more than rows or than strips worth sending', async () => {
    const p = pool('ok', 8);
    await execute(noiseImage(200, 3), OPS, { pool: p });
    expect(FakeWorker.created).toBe(3);
    const q = new WorkerPool({ maxWorkers: 8, minStripPixels: 1 << 20, createWorker: () => new FakeWorker() });
    FakeWorker.created = 0;
    await execute(noiseImage(64, 64), OPS, { pool: q });
    expect(FakeWorker.created).toBe(1);
  });

  it('leaves the input untouched and attached', async () => {
    const img = noiseImage(20, 20, 2);
    const before = img.data.slice();
    await execute(img, OPS, { pool: pool() });
    expect(img.data.byteLength).toBe(before.byteLength);
    expect(img.data).toEqual(before);
  });

  it('auto mode: a fully gray image split across workers is computed as gray', async () => {
    const img = grayImage(30, 40, 3);
    const res = await execute(img, OPS, { pool: pool() });
    expect(res.mode).toBe('gray');
    expect(isGrayPixels(res.data)).toBe(true);
    expect(FakeWorker.log).toContain('detect');
    expect(res.data).toEqual(executeOnMainThread(img, OPS).data);
  });

  it('auto mode: one colored pixel in the last strip makes every strip rgb', async () => {
    // Gray everywhere except one pixel at the bottom. If strips decided on their own, the
    // gray strips would ignore temperature and the image would be inconsistent.
    const img = image(30, 40, (x, y) => (y === 39 && x === 0 ? [200, 10, 10, 255] : [120, 120, 120, 255]));
    const res = await execute(img, OPS, { pool: pool() });
    expect(res.mode).toBe('rgb');
    expect(res.data).toEqual(executeOnMainThread(img, OPS).data);
    const top = pixel({ data: res.data, width: 30, height: 40 }, 0, 0);
    expect(top[0]).not.toBe(top[2]); // temperature applied in the first strip too
  });

  it("explicit colorMode skips detection", async () => {
    const img = grayImage(30, 40);
    const res = await execute(img, OPS, { pool: pool(), colorMode: 'rgb' });
    expect(res.mode).toBe('rgb');
    expect(FakeWorker.log).not.toContain('detect');
    expect(res.data).toEqual(executeOnMainThread(img, OPS, 'rgb').data);
  });

  it('reuses started workers across runs', async () => {
    const p = pool('ok', 2);
    await execute(noiseImage(20, 20), OPS, { pool: p });
    await execute(noiseImage(20, 20), OPS, { pool: p });
    expect(FakeWorker.created).toBe(2);
  });

  it('runs concurrent jobs correctly', async () => {
    const p = pool('ok', 3);
    const imgs = [noiseImage(30, 30, 1), grayImage(30, 30, 2), noiseImage(17, 50, 3)];
    const results = await Promise.all(imgs.map((img) => execute(img, OPS, { pool: p })));
    results.forEach((r, i) => expect(r.data).toEqual(executeOnMainThread(imgs[i], OPS).data));
  });

  it('worker: false stays on the main thread', async () => {
    const res = await execute(noiseImage(20, 20), OPS, { pool: pool(), worker: false });
    expect(res.usedWorker).toBe(false);
    expect(FakeWorker.created).toBe(0);
  });
});

describe('autoStretch in workers', () => {
  const AUTO: OpSpec[] = [
    { op: 'exposure', ev: 0.4 },
    { op: 'autoStretch', method: 'percentClip', lowPercent: 1, highPercent: 2, stdDevs: 2, linked: false },
    { op: 'saturation', amount: 0.3 },
    { op: 'temperature', amount: 0.2 },
  ].map(normalizeOp);

  // Bright top, dark bottom: strips resolving on their own would each stretch differently.
  const split = () => image(31, 40, (x, y) => (y < 20 ? [150 + (x % 40), 160 + (y % 30), 140 + ((x + y) % 50), 255] : [10 + (x % 40), 20 + (y % 30), 5 + ((x + y) % 50), 255]));

  it('one range for the whole image, matching the main thread exactly', async () => {
    const img = split();
    const res = await execute(img, AUTO, { pool: pool('ok', 4) });
    expect(res.usedWorker).toBe(true);
    expect(FakeWorker.log.filter((t) => t === 'detect')).toHaveLength(4);
    expect(res.data).toEqual(executeOnMainThread(img, AUTO).data);
  });

  it('with an explicit color mode still collects statistics first', async () => {
    const img = split();
    for (const colorMode of ['rgb', 'gray'] as const) {
      FakeWorker.log = [];
      const res = await execute(img, AUTO, { pool: pool('ok', 3), colorMode });
      expect(FakeWorker.log).toContain('detect');
      expect(res.mode).toBe(colorMode);
      expect(res.data).toEqual(executeOnMainThread(img, AUTO, colorMode).data);
    }
  });

  it('monochrome images split across workers use the gray statistics', async () => {
    const img = grayImage(30, 40, 6);
    const res = await execute(img, AUTO, { pool: pool('ok', 4) });
    expect(res.mode).toBe('gray');
    expect(isGrayPixels(res.data)).toBe(true);
    expect(res.data).toEqual(executeOnMainThread(img, AUTO).data);
  });

  it('a single strip resolves inside the worker', async () => {
    const img = split();
    const res = await execute(img, AUTO, { pool: pool('ok', 1) });
    expect(FakeWorker.log).toEqual(['run']);
    expect(res.data).toEqual(executeOnMainThread(img, AUTO).data);
  });

  it('detect reports the strip histogram when asked', () => {
    const out: Array<WorkerResponse | ControlResponse> = [];
    const handle = createWorkerHandler((m) => out.push(m));
    const img = noiseImage(5, 4, 2);
    handle({ type: 'detect', id: 9, buffer: img.data.slice().buffer, width: 5, core: [0, 4], stats: 'rgb' });
    const reply = out[0] as Extract<WorkerResponse, { type: 'detected' }>;
    expect(reply.stats?.mode).toBe('rgb');
    expect(reply.stats?.count).toBe(Array.from({ length: 20 }, (_, i) => img.data[i * 4 + 3]).filter((a) => a > 0).length);
  });
});

describe('fallback to the main thread', () => {
  for (const behavior of ['throw', 'error', 'silent'] as const) {
    it(`when workers ${behavior === 'throw' ? 'cannot be constructed' : behavior === 'error' ? 'fail to load' : 'never start'}`, async () => {
      const p = pool(behavior, 2);
      const img = noiseImage(20, 20, 9);
      const res = await execute(img, OPS, { pool: p });
      expect(res.usedWorker).toBe(false);
      expect(res.data).toEqual(executeOnMainThread(img, OPS).data);
      expect(p.available).toBe(false);
      // Later runs go straight to the main thread.
      const created = FakeWorker.created;
      expect((await execute(img, OPS, { pool: p })).usedWorker).toBe(false);
      expect(FakeWorker.created).toBe(created);
    });
  }

  it('when a worker crashes during a job', async () => {
    const p = pool('crash-on-first-job', 2);
    const img = noiseImage(20, 20, 10);
    const res = await execute(img, OPS, { pool: p });
    expect(res.usedWorker).toBe(false);
    expect(res.data).toEqual(executeOnMainThread(img, OPS).data);
  });

  it('uses the workers that did start when some fail', async () => {
    let n = 0;
    const p = new WorkerPool({
      maxWorkers: 4,
      minStripPixels: 10,
      startupTimeout: 100,
      createWorker: () => new FakeWorker(n++ % 2 === 0 ? 'ok' : 'error'),
    });
    const img = noiseImage(20, 20);
    const res = await execute(img, OPS, { pool: p });
    expect(res.usedWorker).toBe(true);
    expect(p.size).toBe(2);
    expect(res.data).toEqual(executeOnMainThread(img, OPS).data);
    await execute(img, OPS, { pool: p });
    expect(n).toBe(4); // no retries of the failing ones
  });

  it('when the environment has no Worker at all (default pool in Node)', async () => {
    const img = noiseImage(8, 8);
    const res = await execute(img, OPS);
    expect(res.usedWorker).toBe(false);
    expect(getPool().available).toBe(false);
  });

  it('a worker error reply rejects instead of falling back', async () => {
    await expect(execute(noiseImage(8, 8), OPS, { pool: pool('error-reply', 1) })).rejects.toThrow('boom');
  });
});

describe('cancellation', () => {
  it('rejects with AbortError when aborted mid-run and releases held strips', async () => {
    const p = pool('ok', 2);
    const c = new AbortController();
    const job = execute(grayImage(20, 20), OPS, { pool: p, signal: c.signal });
    setTimeout(() => c.abort(), 3);
    await expect(job).rejects.toMatchObject({ name: 'AbortError' });
    // The pool keeps working afterwards.
    const img = noiseImage(20, 20);
    expect((await execute(img, OPS, { pool: p })).data).toEqual(executeOnMainThread(img, OPS).data);
  });

  it('rejects immediately for an already-aborted signal', async () => {
    const c = new AbortController();
    c.abort(new Error('stop'));
    await expect(execute(noiseImage(4, 4), OPS, { pool: pool(), signal: c.signal })).rejects.toThrow('stop');
    expect(FakeWorker.created).toBe(0);
  });
});

describe('configureWorkers', () => {
  it('controls the shared pool', async () => {
    configureWorkers({ maxWorkers: 2, minStripPixels: 50, createWorker: () => new FakeWorker() });
    const img = noiseImage(20, 20);
    const res = await execute(img, OPS);
    expect(res.usedWorker).toBe(true);
    expect(getPool().size).toBe(2);
    terminateWorkers();
    expect(getPool().size).toBe(0);
  });

  it('a strip failing while later strips are still being sent is not an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    const node = process as unknown as { on(e: string, f: typeof onUnhandled): void; off(e: string, f: typeof onUnhandled): void };
    node.on('unhandledRejection', onUnhandled);
    try {
      let posted = 0;
      const p: WorkerPool = new WorkerPool({
        maxWorkers: 3,
        minStripPixels: 10,
        createWorker: () => {
          const w = new FakeWorker();
          const post = w.postMessage.bind(w);
          w.postMessage = (m, t) => {
            post(m, t);
            // Kill the pool right after the first strip is sent, before the next one goes out.
            if (++posted === 1) p.terminate();
          };
          return w;
        },
      });
      const img = noiseImage(30, 30);
      const res = await execute(img, OPS, { pool: p });
      expect(res.data).toEqual(executeOnMainThread(img, OPS).data);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      node.off('unhandledRejection', onUnhandled);
    }
  });

  it('terminate rejects pending jobs, which then fall back', async () => {
    const p = pool('ok', 2);
    const img = noiseImage(20, 20);
    const job = execute(img, OPS, { pool: p });
    await new Promise((r) => setTimeout(r, 4));
    p.terminate();
    const res = await job;
    expect(res.data).toEqual(executeOnMainThread(img, OPS).data);
  });
});

it('main-thread execution equals compile + processPixels', () => {
  const img = noiseImage(10, 10);
  const out = new Uint8ClampedArray(img.data.length);
  processPixels(img.data, out, compile(OPS, 'rgb'));
  expect(executeOnMainThread(img, OPS).data).toEqual(out);
});

describe('sharpen in workers', () => {
  const SHARP: OpSpec[] = [
    { op: 'exposure', ev: 0.3 },
    { op: 'sharpen', amount: 1.5, radius: 1.4, threshold: 0 },
    { op: 'saturation', amount: 0.2 },
    { op: 'sharpen', amount: 0.6, radius: 2.1, threshold: 0.01 },
    { op: 'contrast', amount: 0.15 },
  ].map(normalizeOp);

  it('strips get a margin, so the result equals the main thread exactly', async () => {
    // Several strip counts, including strips thinner than the margin (16 rows).
    for (const workers of [2, 3, 5, 8]) {
      const img = noiseImage(29, 41, workers);
      const res = await execute(img, SHARP, { pool: pool('ok', workers), colorMode: 'rgb' });
      expect(res.usedWorker).toBe(true);
      expect(res.data).toEqual(executeOnMainThread(img, SHARP, 'rgb').data);
    }
  });

  it('auto mode and monochrome images too', async () => {
    for (const img of [noiseImage(30, 40, 3), grayImage(30, 40, 4)]) {
      const res = await execute(img, SHARP, { pool: pool('ok', 4) });
      const main = executeOnMainThread(img, SHARP);
      expect(res.mode).toBe(main.mode);
      expect(res.data).toEqual(main.data);
    }
  });

  it('with autoStretch, margin rows are not counted twice in the statistics', async () => {
    const ops = [{ op: 'autoStretch', method: 'minMax' }, { op: 'sharpen', amount: 1, radius: 3 }].map(normalizeOp);
    // A tall image whose rows differ: a strip's margin rows double-counted would move a percentile.
    const img = image(12, 60, (x, y) => [y * 3, 100 + (x % 5), 255 - y * 2, 255]);
    const clip = [{ op: 'autoStretch', method: 'percentClip', lowPercent: 10, highPercent: 10 }, ...ops.slice(1)].map(normalizeOp);
    for (const o of [ops, clip]) {
      const res = await execute(img, o, { pool: pool('ok', 4) });
      expect(FakeWorker.log).toContain('detect');
      expect(res.data).toEqual(executeOnMainThread(img, o).data);
    }
  });

  it('detect counts only the core rows of a strip', () => {
    const out: Array<WorkerResponse | ControlResponse> = [];
    const handle = createWorkerHandler((m) => out.push(m));
    const img = image(3, 5, (x, y) => [y * 10, 0, 0, 255]);
    handle({ type: 'detect', id: 11, buffer: img.data.slice().buffer, width: 3, core: [1, 3], stats: 'rgb' });
    const reply = out[0] as Extract<WorkerResponse, { type: 'detected' }>;
    expect(reply.stats?.count).toBe(6);
    expect(reply.stats?.bins[0][10]).toBe(3);
    expect(reply.stats?.bins[0][20]).toBe(3);
    expect(reply.stats?.bins[0][0]).toBe(0);
  });
});
