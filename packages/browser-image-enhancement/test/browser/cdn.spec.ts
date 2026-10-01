import { expect, test, type Page } from '@playwright/test';

/*
 * Loads the package from a different origin than the page (127.0.0.1 page,
 * localhost files), the way it is used from jsDelivr or unpkg. Browsers refuse
 * to start a worker straight from a cross-origin URL, so this checks that
 * workers still start and give the main-thread result.
 */

declare global {
  interface Window {
    workerStats(): { created: number; started: number };
  }
}

const CDN = 'http://localhost:4173';

async function open(page: Page, kind: string, csp?: string) {
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[browser]', m.text());
  });
  const query = new URLSearchParams({ kind, base: CDN });
  if (csp) query.set('csp', csp);
  await page.goto(`http://127.0.0.1:4173/test/browser/cdn.html?${query}`);
  await page.waitForFunction(() => window.ready === true);
}

function runBoth(page: Page) {
  return page.evaluate(async () => {
    const { lib } = window;
    lib.configureWorkers({ maxWorkers: 2, minStripPixels: 1000 });
    const w = 300;
    const h = 200;
    const data = new Uint8ClampedArray(w * h * 4).map((_, i) => ((i & 3) === 3 ? 255 : (i * 37) & 255));
    const img = new ImageData(data, w, h);
    const p = lib.pipeline().brightness(0.1).contrast(0.2).saturation(0.3).temperature(0.2).levels({ inBlack: 0.03 });
    const out = await p.run(img);
    const sync = p.runSync(img);
    return { same: out.data.every((v, i) => v === sync.data[i]), ...window.workerStats() };
  });
}

for (const kind of ['iife', 'esm', 'dist']) {
  test(`${kind}: workers start when the package is served from another origin`, async ({ page }) => {
    await open(page, kind);
    const r = await runBoth(page);
    expect(r.started).toBe(2);
    expect(r.same).toBe(true);
  });
}

test('iife exposes the API as the BrowserImageEnhancement global', async ({ page }) => {
  await open(page, 'iife');
  const names = await page.evaluate(() => Object.keys(window.lib).sort());
  expect(names).toEqual(expect.arrayContaining(['brightness', 'configureWorkers', 'levels', 'pipeline', 'terminateWorkers']));
});

test('inline worker blocked by CSP falls back to the main thread', async ({ page }) => {
  await open(page, 'esm', "worker-src 'self'");
  const r = await runBoth(page);
  expect(r.started).toBe(0);
  expect(r.same).toBe(true);
});
