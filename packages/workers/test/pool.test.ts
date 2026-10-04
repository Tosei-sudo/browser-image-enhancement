import { describe, expect, it } from 'vitest';
import { WorkerPool, WorkerUnavailableError } from '../src/index.js';

type Listener = (event: { data: unknown; preventDefault?: () => void }) => void;

/** A worker that says `ready` after `readyAfter` ms and, optionally, dies `dieAfter` ms after that. */
class FakeWorker {
  private readonly listeners = new Map<string, Listener[]>();
  terminated = false;
  constructor(readyAfter: number, dieAfter?: number) {
    setTimeout(() => {
      if (this.terminated) return;
      this.emit('message', { data: { type: 'ready' } });
      if (dieAfter !== undefined) setTimeout(() => this.emit('error', { data: null, preventDefault: () => {} }), dieAfter);
    }, readyAfter);
  }
  postMessage(): void {}
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  terminate(): void {
    this.terminated = true;
  }
  private emit(type: string, event: Parameters<Listener>[0]): void {
    for (const l of this.listeners.get(type) ?? []) l(event);
  }
}

describe('WorkerPool', () => {
  it('leaves out a worker that died while the others were still starting', async () => {
    let n = 0;
    // The first worker is ready at once and dies 1 ms later; the second is ready after 10 ms.
    const pool = new WorkerPool<{ id: number }, { id: number }>({
      maxWorkers: 2,
      createWorker: () => (n++ === 0 ? new FakeWorker(0, 1) : new FakeWorker(10)) as never,
    });
    const slots = await pool.acquire(2);
    expect(slots.every((s) => !s.dead)).toBe(true);
    expect(pool.size).toBe(1);
  });

  it('stops workers that finish starting after terminate', async () => {
    const workers: FakeWorker[] = [];
    const pool = new WorkerPool<{ id: number }, { id: number }>({
      maxWorkers: 2,
      createWorker: () => {
        const w = new FakeWorker(10);
        workers.push(w);
        return w as never;
      },
    });
    const acquiring = pool.acquire(2);
    await new Promise((r) => setTimeout(r, 2));
    pool.terminate();
    await expect(acquiring).rejects.toBeInstanceOf(WorkerUnavailableError);
    expect(workers.length).toBe(2);
    expect(workers.every((w) => w.terminated)).toBe(true);
    expect(pool.size).toBe(0);
  });

  it('ignores NaN and zero settings instead of disabling the workers', async () => {
    const pool = new WorkerPool<{ id: number }, { id: number }>({
      maxWorkers: NaN,
      minStripPixels: NaN,
      startupTimeout: 0,
      createWorker: () => new FakeWorker(5) as never,
    });
    expect(pool.minStripPixels).toBe(1 << 18);
    expect(pool.maxWorkers).toBeGreaterThanOrEqual(1);
    expect((await pool.acquire(1)).length).toBe(1);
  });
});
