import { describe, expect, it } from 'vitest';
import { abortError, crossOriginWorkerUrl, race, splitRows, stripCount } from '../src/index.js';

describe('splitRows', () => {
  it('covers every row once with strips that differ by at most one row', () => {
    for (const [h, n] of [[10, 3], [7, 7], [1, 4], [1000, 8]]) {
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

describe('stripCount', () => {
  it('uses one strip per minStripPixels, capped by workers and rows', () => {
    expect(stripCount(1000, 10, 8, 300)).toBe(4);
    expect(stripCount(1000, 10, 2, 300)).toBe(2);
    expect(stripCount(1000, 3, 8, 100)).toBe(3);
    expect(stripCount(10, 10, 8, 300)).toBe(1);
  });
});

describe('race', () => {
  it('rejects with the abort reason as soon as the signal aborts', async () => {
    const controller = new AbortController();
    const pending = race(new Promise(() => {}), controller.signal);
    controller.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop');
  });

  it('passes the value through without a signal', async () => {
    await expect(race(Promise.resolve(3))).resolves.toBe(3);
  });

  it('builds an AbortError when the signal has no Error reason', () => {
    expect(abortError().name).toBe('AbortError');
  });
});

describe('crossOriginWorkerUrl', () => {
  const script = new URL('https://cdn.jsdelivr.net/npm/pkg@1.0.0/dist/worker/worker.js');

  it('returns null for a same-origin script or outside a window', () => {
    expect(crossOriginWorkerUrl(new URL('https://example.com/a/worker.js'), 'https://example.com')).toBeNull();
    expect(crossOriginWorkerUrl(script, undefined)).toBeNull();
  });

  it('wraps a cross-origin script in a reusable Blob module that imports it', async () => {
    const url = crossOriginWorkerUrl(script, 'https://example.com');
    expect(url).toMatch(/^blob:/);
    expect(await (await fetch(url!)).text()).toBe(`import "${script.href}";`);
    expect(crossOriginWorkerUrl(script, 'https://other.example')).toBe(url);
  });
});
