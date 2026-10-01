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
      fitLonLat: (extent: number[]) => void;
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

/** Fixture pixel values (see examples/openlayers-cog/fixture.ts). */
const FX = { width: 768, height: 384, extent: [139.6, 35.6, 139.9, 35.75] };
const stripe = (x: number) => (Math.floor(x / 48) % 2 === 0 ? 0 : 24);
const fixtureR = (x: number) => Math.round((x / (FX.width - 1)) * 200) + stripe(x);
const fixtureG = (x: number, y: number) => Math.round((y / (FX.height - 1)) * 200) + stripe(x);

/** Turns DRA on with the given method and waits until its statistics are in and drawn. */
async function enableDra(page: Page, method: string) {
  await page.evaluate((method) => {
    (document.getElementById('draMethod') as HTMLSelectElement).value = method;
    (document.getElementById('dra') as HTMLInputElement).click();
  }, method);
  await page.waitForFunction(() => window.example.source.getEffectivePipeline().ops.some((op) => op.op === 'stretch'));
  await settle(page);
}

/** Moves the view to show `extent` (EPSG:4326) and waits for new DRA statistics. */
async function showExtent(page: Page, extent: number[]) {
  const before = await page.evaluate(() => JSON.stringify(window.example.source.getDraInfo()));
  await page.evaluate((extent) => window.example.fitLonLat(extent), extent);
  await page.waitForFunction((before) => JSON.stringify(window.example.source.getDraInfo()) !== before, before);
  await settle(page);
}

function stretchOp(page: Page) {
  return page.evaluate(() => {
    const op = window.example.source.getEffectivePipeline().ops.find((o) => o.op === 'stretch');
    return op && op.op === 'stretch' ? { black: op.black, white: op.white } : null;
  });
}

test('DRA stretches to the visible area and follows the view', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  const readsBefore = await page.evaluate(() => window.example.source.stats.reads);
  await enableDra(page, 'minMax');

  // Whole image visible: R and G span the fixture's full range, B (constant 120) is left alone.
  const whole = (await stretchOp(page))!;
  expect(whole.black[0] * 255).toBeCloseTo(0, 6);
  expect(whole.white[0] * 255).toBeCloseTo(224, 6);
  expect(whole.black[1] * 255).toBeCloseTo(0, 6);
  expect(whole.white[1] * 255).toBeCloseTo(224, 6);
  expect([whole.black[2], whole.white[2]]).toEqual([0, 1]);

  // Zoom into the left-bottom part: the range shrinks to what is on screen, computed from the fixture itself.
  await showExtent(page, [139.62, 35.61, 139.7, 35.66]);
  const info = (await page.evaluate(() => window.example.source.getDraInfo()))!;
  const px = (lon: number) => ((lon - FX.extent[0]) / (FX.extent[2] - FX.extent[0])) * FX.width;
  const py = (lat: number) => ((FX.extent[3] - lat) / (FX.extent[3] - FX.extent[1])) * FX.height;
  const cols = range(Math.floor(px(info.extent[0])), Math.ceil(px(info.extent[2])));
  const rows = range(Math.floor(py(info.extent[3])), Math.ceil(py(info.extent[1])));
  const rs = cols.map(fixtureR);
  const gs = cols.flatMap((x) => rows.map((y) => fixtureG(x, y)));
  const zoomed = (await stretchOp(page))!;
  expect(zoomed.black[0] * 255).toBeCloseTo(Math.min(...rs), 6);
  expect(zoomed.white[0] * 255).toBeCloseTo(Math.max(...rs), 6);
  expect(zoomed.black[1] * 255).toBeCloseTo(Math.min(...gs), 6);
  expect(zoomed.white[1] * 255).toBeCloseTo(Math.max(...gs), 6);
  expect(zoomed.white[0]).toBeLessThan(whole.white[0]);

  // Every visible tile is corrected with that one range: samples across the view match it (no per-tile ranges).
  const [w, h] = await page.evaluate(() => window.example.map.getSize()!);
  const points: Array<[number, number]> = [[w * 0.2, h * 0.2], [w * 0.5, h * 0.5], [w * 0.8, h * 0.8], [w * 0.8, h * 0.2]];
  const corrected = await Promise.all(points.map(([x, y]) => sample(page, x, y)));
  await page.evaluate(() => (document.getElementById('enabled') as HTMLInputElement).click());
  await page.waitForTimeout(50);
  await settle(page);
  const raw = await Promise.all(points.map(([x, y]) => sample(page, x, y)));
  const expected = await page.evaluate(
    ([raw, s]) =>
      raw.map((px) => Array.from(window.example.pipeline().stretch(s!).runSync({ data: new Uint8ClampedArray(px), width: 1, height: 1 }, { colorMode: 'rgb' }).data)),
    [raw, zoomed] as const,
  );
  expect(corrected).not.toEqual(raw);
  for (let i = 0; i < points.length; i++) {
    for (let c = 0; c < 3; c++) expect(Math.abs(corrected[i][c] - expected[i][c])).toBeLessThanOrEqual(3);
  }
  await page.evaluate(() => (document.getElementById('enabled') as HTMLInputElement).click());

  // Back to the whole image: the range comes back. Statistics reuse cached raw tiles.
  await showExtent(page, FX.extent);
  expect(await stretchOp(page)).toEqual(whole);
  const reads = await page.evaluate(() => window.example.source.stats.reads);
  expect(reads).toBe(readsBefore);

  // DRA off: no stretch left in the pipeline.
  await page.evaluate(() => (document.getElementById('dra') as HTMLInputElement).click());
  await page.waitForFunction(() => !window.example.source.getEffectivePipeline().ops.some((op) => op.op === 'stretch'));
  expect(errors).toEqual([]);
});

test('DRA statistics count only the image, not the empty map around it', async ({ page }) => {
  await open(page);
  await enableDra(page, 'minMax');
  // A view much larger than the image: the counted area is clipped to the image, so the range is unchanged.
  const whole = await stretchOp(page);
  await page.evaluate(() => window.example.map.getView().setZoom(window.example.map.getView().getZoom()! - 2));
  await page.waitForFunction(() => {
    const e = window.example.source.getDraInfo()!.extent;
    return e[0] <= 139.6 + 1e-9 && e[2] >= 139.9 - 1e-9;
  });
  expect(await stretchOp(page)).toEqual(whole);
});

function range(a: number, b: number): number[] {
  return Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
}
