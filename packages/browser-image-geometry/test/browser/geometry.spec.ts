import { expect, test, type Page } from '@playwright/test';

/*
 * Runs the built package in a real browser: module workers with transfer,
 * canvas/Blob I/O, CDN loading from another origin, and the CSP fallback.
 */

declare global {
  interface Window {
    lib: typeof import('../../src/index.js');
    ready: boolean;
    workerStats(): { created: number; started: number };
  }
}

const CDN = 'http://localhost:4174';

async function open(page: Page, url: string) {
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[browser]', m.text());
  });
  await page.goto(url);
  await page.waitForFunction(() => window.ready === true);
}

/** Warps a noise image in workers and on the main thread; reports whether they agree. */
function runBoth(page: Page) {
  return page.evaluate(async () => {
    const { lib } = window;
    lib.configureWorkers({ maxWorkers: 3, minStripPixels: 1000 });
    const w = 320;
    const h = 240;
    let seed = 7;
    const data = new Uint8ClampedArray(w * h * 4).map(() => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed >>> 24));
    const img = new ImageData(data, w, h);
    const fit = lib.fitTransform(
      [
        { pixel: [0, 0], world: [139.7, 35.7] },
        { pixel: [320, 10], world: [139.8, 35.7] },
        { pixel: [5, 240], world: [139.7, 35.62] },
        { pixel: [330, 250], world: [139.8, 35.62] },
      ],
      { model: 'projective' },
    );
    const options = { resample: 'bicubic' as const };
    const out = await lib.warp(img, fit.transform, options);
    const sync = lib.warpImageData(img, fit.transform, options);
    const same = out.image.data.length === sync.image.data.length && out.image.data.every((v, i) => v === sync.image.data[i]);
    return { same, usedWorker: out.usedWorker, extent: out.extent, size: [out.width, out.height] };
  });
}

test('warps in workers with the same result as the main thread', async ({ page }) => {
  await open(page, '/test/browser/cdn.html?kind=dist&base=');
  const r = await runBoth(page);
  expect(r.usedWorker).toBe(true);
  expect(r.same).toBe(true);
  expect(r.extent[0]).toBeCloseTo(139.7, 2);
});

for (const kind of ['iife', 'esm', 'dist']) {
  test(`${kind}: workers start when the package is served from another origin`, async ({ page }) => {
    await open(page, `http://127.0.0.1:4174/test/browser/cdn.html?kind=${kind}&base=${CDN}`);
    const r = await runBoth(page);
    expect(r.usedWorker).toBe(true);
    expect(r.same).toBe(true);
    expect((await page.evaluate(() => window.workerStats())).started).toBe(3);
  });
}

test('falls back to the main thread when a CSP forbids workers', async ({ page }) => {
  await open(page, `http://127.0.0.1:4174/test/browser/cdn.html?kind=esm&base=${CDN}&csp=${encodeURIComponent("worker-src 'none'")}`);
  const r = await runBoth(page);
  expect(r.usedWorker).toBe(false);
  expect(r.same).toBe(true);
});

test('takes a Blob and returns a canvas or a PNG', async ({ page }) => {
  await open(page, '/test/browser/cdn.html?kind=dist&base=');
  const r = await page.evaluate(async () => {
    const { lib } = window;
    const canvas = new OffscreenCanvas(40, 20);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#f00';
    ctx.fillRect(0, 0, 20, 20);
    ctx.fillStyle = '#00f';
    ctx.fillRect(20, 0, 20, 20);
    const blob = await canvas.convertToBlob();
    const rotated = await lib.warp(blob, lib.rotation(90, [20, 10]), { output: 'canvas', pixelSize: 1 });
    const c = rotated.image as OffscreenCanvas | HTMLCanvasElement;
    const px = (c.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, c.width, c.height).data;
    const png = await lib.warp(blob, lib.identity(), { output: 'blob' });
    // After a clockwise quarter turn, the red left half is on top.
    return { size: [c.width, c.height], top: Array.from(px.slice(0, 4)), bottom: Array.from(px.slice(px.length - 4)), type: png.image.type };
  });
  expect(r.size).toEqual([20, 40]);
  expect(r.top).toEqual([255, 0, 0, 255]);
  expect(r.bottom).toEqual([0, 0, 255, 255]);
  expect(r.type).toBe('image/png');
});
