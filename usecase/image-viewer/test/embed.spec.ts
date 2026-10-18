import { expect, test, type Page } from '@playwright/test';

/*
 * The embedding API: embed-example.html, served from another origin
 * (127.0.0.1 rather than localhost), shows the viewer in an iframe
 * (`?embed=1`) and drives it through embed-client.js. Only origins in
 * config.json's `embed.allowedOrigins` get an answer.
 */

const PARENT = 'http://127.0.0.1:4175';
const VIEWER = 'http://localhost:4175';

async function openExample(page: Page, embed: unknown, timeout = 15000) {
  await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ embed }) }));
  const viewer = encodeURIComponent(`${VIEWER}/index.html?embed=1`);
  await page.goto(`${PARENT}/embed-example.html?viewer=${viewer}&timeout=${timeout}`);
}

const call = (page: Page, method: string, params?: unknown) =>
  page.evaluate(
    async ([m, p]) => {
      try {
        return { result: await (window as never as { viewerClient: { call: (m: string, p: unknown) => Promise<unknown> } }).viewerClient.call(m as string, p) };
      } catch (error) {
        return { code: (error as { code: string }).code, message: (error as Error).message };
      }
    },
    [method, params] as const,
  );
const events = (page: Page, name: string) => page.evaluate((n) => (window as never as { embedLog: { events: Array<{ name: string; data: unknown }> } }).embedLog.events.filter((e) => e.name === n).map((e) => e.data), name);

test('a page of an allowed origin opens a COG, moves the view, adds shapes and reads the selection', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openExample(page, { allowedOrigins: [PARENT] });
  await expect(page.locator('#state')).toHaveText('接続しました（操作可）');
  await expect.poll(() => events(page, 'ready')).toHaveLength(1);

  // The iframe shows the map alone.
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#map')).toBeVisible();
  await expect(frame.locator('header.bar')).toBeHidden();
  await expect(frame.locator('aside.side')).toBeHidden();

  // Opening a COG of the viewer's own server asks nothing.
  const opened = await call(page, 'open', { url: `${VIEWER}/fixture.tif` });
  expect(opened.result).toEqual([expect.objectContaining({ kind: 'raster', name: `${VIEWER}/fixture.tif`, width: 512, height: 256 })]);
  await expect.poll(async () => ((await events(page, 'layers')).at(-1) as { layers: unknown[] } | undefined)?.layers.length).toBe(1);

  // The view, and its event (throttled).
  const view = await call(page, 'setView', { center: [139.75, 35.68], zoom: 12 });
  expect(view.result).toMatchObject({ zoom: 12 });
  const got = (await call(page, 'getView')).result as { center: number[]; zoom: number; bbox: number[] };
  expect(got.center[0]).toBeCloseTo(139.75, 5);
  expect(got.center[1]).toBeCloseTo(35.68, 5);
  expect(got.zoom).toBe(12);
  await expect.poll(async () => ((await events(page, 'view')).at(-1) as { zoom?: number } | undefined)?.zoom).toBe(12);

  // Shapes as a temporary layer (link-shapes.ts), labelled.
  const added = await call(page, 'addShapes', { wkt: ['POLYGON((139.70 35.65, 139.80 35.65, 139.80 35.72, 139.70 35.65))', '35.6812, 139.7671'], labels: ['区域', '東京駅'], name: '埋め込み', zoom: false });
  expect(added.result).toMatchObject({ count: 2 });
  const layerId = (added.result as { layer: string }).layer;
  const layers = (await call(page, 'listLayers')).result as Array<{ id: string; name: string; kind: string; count?: number }>;
  expect(layers.find((l) => l.id === layerId)).toMatchObject({ name: '埋め込み', kind: 'vector', count: 2 });

  // Nothing selected yet; a click on the point selects it and is sent with its latitude and longitude.
  expect((await call(page, 'getSelection')).result).toEqual({ layer: null, ids: [] });
  await call(page, 'selectLayer', { layer: layerId });
  await call(page, 'setView', { center: [139.7671, 35.6812], zoom: 14 });
  const iframe = page.frames().find((f) => f.url().startsWith(VIEWER))!;
  const pixel = await iframe.evaluate(() => {
    const map = (window as never as { viewer: { map: import('ol/Map.js').default } }).viewer.map;
    return map.getPixelFromCoordinate(map.getView().getCenter()!);
  });
  await frame.locator('#map').click({ position: { x: pixel[0], y: pixel[1] } });
  await expect.poll(async () => (await events(page, 'click')).length).toBe(1);
  const click = (await events(page, 'click'))[0] as { lon: number; lat: number };
  expect(click.lon).toBeCloseTo(139.7671, 3);
  expect(click.lat).toBeCloseTo(35.6812, 3);
  await expect.poll(async () => ((await events(page, 'selection')).at(-1) as { ids: string[] } | undefined)?.ids.length).toBe(1);
  const selection = (await call(page, 'getSelection', { features: true })).result as { layer: string; ids: string[]; features: { features: Array<{ properties: { label: string }; geometry: { type: string } }> } };
  expect(selection.layer).toBe(layerId);
  expect(selection.ids).toHaveLength(1);
  expect(selection.features.features[0]).toMatchObject({ properties: { label: '東京駅' }, geometry: { type: 'Point' } });

  await page.screenshot({ path: '/mnt/project-files/integrations/embed-example.png' }).catch(() => {});

  // Layers shown and hidden.
  expect((await call(page, 'setVisible', { layer: layerId, visible: false })).result).toBe(true);
  await expect.poll(async () => ((await events(page, 'layers')).at(-1) as { layers: Array<{ id: string; visible: boolean }> }).layers.find((l) => l.id === layerId)?.visible).toBe(false);

  // Strict parameters, a fixed list of methods, no downloads.
  expect(await call(page, 'setView', { center: 'Tokyo' })).toMatchObject({ code: 'bad-request' });
  expect(await call(page, 'saveEdits')).toMatchObject({ code: 'unknown-method' });
  expect(await call(page, 'runTool', { id: 'save-view' })).toMatchObject({ code: 'failed' });
  expect(((await call(page, 'listTools')).result as Array<{ id: string }>).map((t) => t.id)).not.toContain('save-view');
  // A server the viewer does not use is asked about; declined, nothing opens.
  page.on('dialog', (d) => void d.dismiss());
  expect(await call(page, 'open', { url: 'https://elsewhere.example.com/a.tif' })).toMatchObject({ code: 'failed', message: expect.stringContaining('許可されませんでした') });
  expect(errors).toEqual([]);

});

test('read-only embedding moves the view but changes no layers', async ({ page }) => {
  await openExample(page, { allowedOrigins: [PARENT], readOnly: true });
  await expect(page.locator('#state')).toHaveText('接続しました（読み取り専用）');
  expect(await call(page, 'open', { url: `${VIEWER}/fixture.tif` })).toMatchObject({ code: 'read-only' });
  expect(await call(page, 'addShapes', { wkt: ['POINT(139.7 35.6)'] })).toMatchObject({ code: 'read-only' });
  expect((await call(page, 'setView', { zoom: 5 })).result).toMatchObject({ zoom: 5 });
  expect((await call(page, 'listLayers')).result).toEqual([]);
});

test('a page of another origin gets no answer', async ({ page }) => {
  await openExample(page, { allowedOrigins: [VIEWER] }, 2500);
  await expect(page.locator('#state')).toContainText('接続できませんでした', { timeout: 10_000 });
  const log = await page.evaluate(() => (window as never as { embedLog: { received: number; error: string } }).embedLog);
  expect(log).toEqual({ events: [], received: 0, error: 'timeout' });
});

test('without embed in config.json the API is off', async ({ page }) => {
  await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.goto(`${PARENT}/embed-example.html?viewer=${encodeURIComponent(`${VIEWER}/index.html?embed=1`)}&timeout=2500`);
  await expect(page.locator('#state')).toContainText('接続できませんでした', { timeout: 10_000 });
  expect(await page.evaluate(() => (window as never as { embedLog: { received: number } }).embedLog.received)).toBe(0);
});
