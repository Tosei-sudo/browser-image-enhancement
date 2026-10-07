import { expect, test, type Page } from '@playwright/test';

/*
 * Vector tile base maps: an ArcGIS VectorTileServer (as on ArcGIS Online or an
 * ArcGIS Data Appliance, here the stand-in under /svc/), a Mapbox / MapLibre
 * style JSON, and plain {z}/{x}/{y}.pbf tiles. The stand-in tiles are one land
 * square per tile, so the whole map shows the land color.
 */

const server = 'http://localhost:4175/svc/arcgis/rest/services';

async function open(page: Page, baseMaps: object[]) {
  await page.request.get('/svc/reset');
  const config = { baseMaps, defaultBaseMap: (baseMaps[0] as { id: string }).id };
  await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config) }));
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.evaluate(() => window.viewer.baseMap.ready);
}

/** Whether the base map shows `color` ([r, g, b]) inside a tile, away from the tile seams at the middle of the map. */
const shows = (page: Page, color: number[]) =>
  page.evaluate((color) => {
    const canvas = document.querySelector<HTMLCanvasElement>('.basemap-layer canvas');
    if (!canvas || !canvas.width) return false;
    const data = canvas.getContext('2d')!.getImageData(Math.round(canvas.width * 0.4), Math.round(canvas.height * 0.4), 1, 1).data;
    return color.every((c, i) => Math.abs(data[i] - c) <= 3);
  }, color);

const tiles = async (page: Page): Promise<string[]> => (await page.request.get('/svc/vector-tiles')).json();

test('an ArcGIS VectorTileServer is drawn in its default style', async ({ page }) => {
  await open(page, [{ id: 'appliance', label: 'アプライアンス OSM', url: `${server}/OSM/VectorTileServer` }]);
  await expect(page.getByRole('combobox', { name: '背景地図' })).toHaveValue('appliance');
  // The land color of the server's root.json; tiles are asked for as ArcGIS names them, {z}/{y}/{x}.
  await expect.poll(() => shows(page, [46, 125, 50])).toBe(true);
  expect((await tiles(page)).every((t) => /\/OSM\/VectorTileServer\/tile\/\d+\/\d+\/\d+\.pbf$/.test(t))).toBe(true);
  // Its copyright text is the attribution; the missing sprite costs only the icons.
  await expect(page.locator('.ol-attribution')).toContainText('テスト地図');

  // Back to none removes it.
  await page.getByRole('combobox', { name: '背景地図' }).selectOption('');
  await expect(page.locator('.basemap-layer')).toHaveCount(0);
});

test('a secured VectorTileServer is asked with its token, and says so without one', async ({ page }) => {
  await open(page, [
    { id: 'secure', label: '社内', url: `${server}/SecureOSM/VectorTileServer`, token: 'secret' },
    { id: 'no-token', label: 'トークンなし', url: `${server}/SecureOSM/VectorTileServer` },
  ]);
  await expect.poll(() => shows(page, [46, 125, 50])).toBe(true);
  const asked = await tiles(page);
  expect(asked.length).toBeGreaterThan(0);
  expect(asked.every((t) => t.endsWith('?token=secret'))).toBe(true);

  await page.getByRole('combobox', { name: '背景地図' }).selectOption('no-token');
  await page.evaluate(() => window.viewer.baseMap.ready);
  await expect(page.locator('#status')).toContainText('トークン');
  await expect(page.locator('.basemap-layer')).toHaveCount(0);
});

test('a style JSON is drawn as it says, its ArcGIS sources included', async ({ page }) => {
  await open(page, [{ id: 'style', label: 'スタイル', url: `${server}/OSM/VectorTileServer/resources/styles/root.json`, attributions: '自社' }]);
  await expect.poll(() => shows(page, [46, 125, 50])).toBe(true);
  await expect(page.locator('.ol-attribution')).toContainText('自社');
});

test('plain .pbf tiles are drawn in the built-in style', async ({ page }) => {
  await open(page, [{ id: 'pbf', label: 'MVT', url: 'http://localhost:4175/svc/mvt/{z}/{x}/{y}.pbf' }]);
  await expect.poll(() => shows(page, [233, 231, 225])).toBe(true);
  expect((await tiles(page)).length).toBeGreaterThan(0);
});
