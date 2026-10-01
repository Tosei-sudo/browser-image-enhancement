import { expect, test, type Page } from '@playwright/test';

/*
 * The OpenLayers + COG example (examples/openlayers-cog), built with Vite, on a
 * GeoTIFF generated in the page so no network is needed.
 */

declare global {
  interface Window {
    example: {
      map: import('ol/Map.js').default;
      layer: import('ol/layer/WebGLTile.js').default;
      source: import('../../examples/openlayers-cog/enhanced-geotiff.js').default;
      inputs: Record<string, HTMLInputElement>;
      pipeline: typeof import('../../src/index.js').pipeline;
    };
  }
}

async function open(page: Page) {
  // The base map is not needed for these checks.
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort());
  await page.goto('/.example-dist/openlayers-cog/index.html?fixture');
  await page.waitForFunction(() => window.example?.source?.getState() === 'ready');
  await settle(page);
}

/** Waits until every visible tile has been loaded and drawn. */
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        window.example.map.once('rendercomplete', () => resolve());
        window.example.map.render();
      }),
  );
}

/** Tile data under a map pixel, as the WebGL layer holds it (after correction). */
function sample(page: Page, x: number, y: number) {
  return page.evaluate(([x, y]) => Array.from(window.example.layer.getData([x, y]) as Uint8Array), [x, y]);
}

test('tiles are corrected with the pipeline and re-corrected when it changes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);

  const [w, h] = await page.evaluate(() => window.example.map.getSize()!);
  const points: Array<[number, number]> = [
    [w * 0.5, h * 0.5],
    [w * 0.3, h * 0.45],
    [w * 0.7, h * 0.55],
  ];

  // Switch correction off to read the raw tile values.
  await page.evaluate(() => {
    (document.getElementById('enabled') as HTMLInputElement).click();
  });
  await page.waitForTimeout(50);
  await settle(page);
  const raw = await Promise.all(points.map(([x, y]) => sample(page, x, y)));
  for (const px of raw) expect(px.length).toBe(4); // RGB + alpha added by OpenLayers

  // Back on, with exposure +1 and warmer color.
  await page.evaluate(() => {
    (document.getElementById('enabled') as HTMLInputElement).click();
    const { inputs } = window.example;
    inputs.exposure.value = '1';
    inputs.temperature.value = '0.5';
    inputs.exposure.dispatchEvent(new Event('input'));
  });
  await page.waitForTimeout(50);
  await settle(page);
  const corrected = await Promise.all(points.map(([x, y]) => sample(page, x, y)));

  const expected = await page.evaluate(
    (raw) =>
      raw.map((px) => {
        const data = new Uint8ClampedArray(px);
        const out = window.example
          .pipeline()
          .exposure(1)
          .brightness(0)
          .contrast(0)
          .gamma(1)
          .levels({ inBlack: 0, inWhite: 1, gamma: 1 })
          .temperature(0.5)
          .saturation(0)
          .runSync({ data, width: 1, height: 1 }, { colorMode: 'rgb' });
        return Array.from(out.data);
      }),
    raw,
  );

  for (let i = 0; i < points.length; i++) {
    expect(corrected[i]).not.toEqual(raw[i]);
    // Reprojection to Web Mercator resamples after correction, so allow a little slack.
    for (let c = 0; c < 4; c++) expect(Math.abs(corrected[i][c] - expected[i][c])).toBeLessThanOrEqual(3);
  }

  const stats = await page.evaluate(() => ({ ...window.example.source.stats }));
  expect(stats.tiles).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('changing the pipeline re-corrects cached tiles without reading the COG again', async ({ page }) => {
  await open(page);
  const before = await page.evaluate(() => ({ ...window.example.source.stats }));
  expect(before.reads).toBeGreaterThan(0);

  for (const ev of ['0.5', '1', '1.5']) {
    await page.evaluate((ev) => {
      window.example.inputs.exposure.value = ev;
      window.example.inputs.exposure.dispatchEvent(new Event('input'));
    }, ev);
    await page.waitForTimeout(50);
    await settle(page);
  }

  const after = await page.evaluate(() => ({ ...window.example.source.stats }));
  expect(after.reads).toBe(before.reads);
  expect(after.tiles).toBeGreaterThan(0); // reset on each change, so these are the latest re-corrections
});
