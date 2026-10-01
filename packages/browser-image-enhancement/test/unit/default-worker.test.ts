import { describe, expect, it } from 'vitest';
import { crossOriginWorkerUrl } from '../../src/worker/default-worker.js';

describe('crossOriginWorkerUrl', () => {
  const lib = 'https://cdn.jsdelivr.net/npm/browser-image-enhancement@0.1.0/dist/worker/pool.js';

  it('starts the worker file directly when it is same-origin with the page', () => {
    expect(crossOriginWorkerUrl('https://example.com/assets/pool.js', 'https://example.com')).toBeNull();
  });

  it('starts directly when there is no page origin (not in a window)', () => {
    expect(crossOriginWorkerUrl(lib, undefined)).toBeNull();
  });

  it('wraps a cross-origin worker in a Blob module that imports it', async () => {
    const url = crossOriginWorkerUrl(lib, 'https://example.com');
    expect(url).toMatch(/^blob:/);
    const source = await (await fetch(url!)).text();
    expect(source).toBe('import "https://cdn.jsdelivr.net/npm/browser-image-enhancement@0.1.0/dist/worker/worker.js";');
  });

  it('reuses one Blob URL per worker script', () => {
    expect(crossOriginWorkerUrl(lib, 'https://example.com')).toBe(crossOriginWorkerUrl(lib, 'https://other.example'));
  });
});
