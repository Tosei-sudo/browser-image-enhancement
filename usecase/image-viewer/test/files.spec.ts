import { expect, test, type Page } from '@playwright/test';
import { ascii, dbf, plainGeoTiff, shp, tokyoSjis } from './fixtures.js';

/*
 * Files beyond pictures and COGs: GeoTIFFs without overviews (rewritten with
 * them), Shapefiles and GeoJSON (read-only vector layers with the attribute
 * table), and the DRA lock of each image.
 */

async function open(page: Page, query = '') {
  await page.goto(`/index.html${query}`);
  await page.waitForFunction(() => window.viewer !== undefined);
}

/** Chooses files with the file chooser, as a person would. */
async function choose(page: Page, files: Array<{ name: string; bytes: Uint8Array | string; type?: string }>) {
  const sent = files.map((f) => ({ name: f.name, type: f.type ?? 'application/octet-stream', bytes: typeof f.bytes === 'string' ? f.bytes : Array.from(f.bytes) }));
  await page.evaluate((files) => {
    const list = new DataTransfer();
    for (const f of files) list.items.add(new File([typeof f.bytes === 'string' ? f.bytes : new Uint8Array(f.bytes)], f.name, { type: f.type }));
    const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
    input.files = list.files;
    input.dispatchEvent(new Event('change'));
  }, sent);
}

const names = (page: Page) => page.locator('#images .name').allTextContents();
const rows = (page: Page) => page.locator('.attributes tbody tr[data-index]');

test('a GeoTIFF without overviews gets them, so it is not sampled sparsely when zoomed out', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await choose(page, [{ name: 'stripes.tif', bytes: plainGeoTiff(1100, 700), type: 'image/tiff' }]);
  await expect(page.locator('#status')).toContainText('stripes.tif を開きました');
  await expect(page.locator('#info')).toContainText('1,100 × 700 px');
  const levels = await page.evaluate(() => window.viewer.images.list()[0].source.getTileGrid()!.getResolutions().length);
  expect(levels).toBeGreaterThan(1);
  expect(errors).toEqual([]);
});

test('Shapefiles and GeoJSON open read-only, with their attributes in the table', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);

  // A Shapefile chosen as its .shp and .dbf, Japanese text in Shift_JIS without a .cpg.
  await choose(page, [
    { name: 'sites.shp', bytes: shp([[139.7, 35.7], [135.5, 34.7]]) },
    { name: 'sites.dbf', bytes: dbf([{ name: 'NAME', length: 10 }, { name: 'POP', type: 'N', length: 8 }], [[tokyoSjis, ascii('100')], [ascii('Osaka'), ascii('20')]]) },
  ]);
  await expect(page.locator('#status')).toContainText('sites を開きました（読み取り専用）');
  expect(await names(page)).toEqual(['SHPsites']);
  await expect(page.locator('#info')).toContainText('Shapefile（読み取り専用）');
  await expect(page.locator('#info')).toContainText('Shift_JIS');
  await expect(page.locator('.table-count')).toContainText('全 2 件');
  await expect(rows(page).first()).toContainText('東京');
  // No edit button: the layer is read-only.
  await expect(page.locator('#images li').first().locator('[data-action=edit]')).toHaveCount(0);
  // The view went to the features (Japan).
  await expect.poll(() => page.evaluate(() => window.viewer.map.getView().getCenter()![0])).toBeGreaterThan(14_000_000);

  // GeoJSON.
  const geojson = JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[139, 35], [140, 36]] }, properties: { route: '国道1号', lanes: 4 } }],
  });
  await choose(page, [{ name: 'roads.geojson', bytes: geojson, type: 'application/geo+json' }]);
  await expect(page.locator('#status')).toContainText('roads を開きました（読み取り専用）');
  expect(await names(page)).toEqual(['GeoJSONroads', 'SHPsites']);
  await expect(page.locator('.table-count')).toContainText('全 1 件');
  await expect(rows(page).first()).toContainText('国道1号');

  // A click on a feature selects it.
  await page.locator('#images .name', { hasText: 'sites' }).click();
  // The view may still be moving to the last file opened: aim again until the click lands.
  await expect(async () => {
    await page.waitForFunction(() => !window.viewer.map.getView().getAnimating());
    const pixel = await page.evaluate(() => {
      const f = window.viewer.table.rows()[0];
      return window.viewer.map.getPixelFromCoordinate((f.getGeometry() as unknown as { getCoordinates(): number[] }).getCoordinates());
    });
    const box = (await page.locator('#map').boundingBox())!;
    await page.mouse.click(box.x + pixel[0], box.y + pixel[1]);
    await expect(page.locator('.table-count')).toContainText('選択 1 件', { timeout: 1500 });
  }).toPass();

  // The links of the page do not name local files.
  expect(page.url()).not.toContain('service=');

  // A .dbf without its .shp says what is missing.
  await choose(page, [{ name: 'lonely.dbf', bytes: dbf([{ name: 'ID', length: 4 }], []) }]);
  await expect(page.locator('#status')).toContainText('lonely.shp がありません');
  expect(errors).toEqual([]);
});

test('DRA can be locked per image: the range then stays while the view moves', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page, '?url=/fixture.tif');
  await expect(page.locator('#status')).toContainText('fixture.tif を開きました');

  const dra = page.locator('.ol-enhance fieldset', { hasText: 'DRA' });
  await dra.getByRole('checkbox', { name: 'オン' }).check();
  const info = () => page.evaluate(() => window.viewer.images.list()[0].source.getDraInfo()?.extent.join(',') ?? null);
  await expect.poll(info).not.toBeNull();

  const lock = dra.getByRole('checkbox', { name: '範囲を固定' });
  await lock.check();
  expect(await page.evaluate(() => window.viewer.images.list()[0].source.isDraLocked())).toBe(true);
  const locked = await info();

  const zoomIn = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const map = window.viewer.map;
          map.once('moveend', () => resolve());
          map.getView().setZoom(map.getView().getZoom()! + 1);
        }),
    );
  await zoomIn();
  await page.waitForTimeout(500);
  expect(await info()).toBe(locked);

  // Another image has its own lock, off.
  await choose(page, [{ name: 'small.tif', bytes: plainGeoTiff(64, 64), type: 'image/tiff' }]);
  await expect(page.locator('#status')).toContainText('small.tif を開きました');
  await expect(lock).not.toBeChecked();
  await page.locator('#images .name', { hasText: 'fixture.tif' }).click();
  await expect(lock).toBeChecked();

  // Unlocked, DRA follows the view again.
  await lock.uncheck();
  await expect.poll(info).not.toBe(locked);
  expect(errors).toEqual([]);
});
