import { expect, test, type Page } from '@playwright/test';
import Point from 'ol/geom/Point.js';
import { ascii, dbf, gpkg, plainGeoTiff, shp, tokyoSjis } from './fixtures.js';
import { encodeGeometry } from '../src/geopackage.js';
import { readFileSync } from 'node:fs';

/*
 * Files beyond pictures and COGs: GeoTIFFs without overviews (rewritten with
 * them), Shapefiles, GeoJSON and GeoPackages (vector layers with the attribute
 * table; editing them is in vector-edit.spec.ts), and the DRA lock of each image.
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
  // The list and the panel say the viewer made its RSET; the progress panel is gone.
  await expect(page.locator('#images .tag')).toHaveText('RSET生成');
  await expect(page.locator('#info')).toContainText('生成済み（このビューアーで作成）・1/2〜1/8、3 レベル');
  await expect(page.locator('.rset-progress')).toBeHidden();
  // Fitted to the view the image is drawn from an RSET level; zoomed in, from its raw pixels.
  await expect(page.locator('.rset-shown')).toHaveText(/表示: RSET 1\/\d+/);
  await page.evaluate(() => window.viewer.map.getView().setZoom(window.viewer.map.getView().getZoom()! + 3));
  await expect(page.locator('.rset-shown')).toHaveText('表示: 生画素');
  expect(errors).toEqual([]);
});

test('a large GeoTIFF without overviews is on the map at once, drawn zoomed in only until its RSET is made', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  // Every image counts as large here, and the RSET waits until the test lets it go.
  await page.evaluate(() => {
    window.viewer.rset.showFirstAbove = 0;
    window.viewer.rset.hold = new Promise((resolve) => ((window as unknown as { release: () => void }).release = () => resolve(null)));
  });
  await choose(page, [{ name: 'stripes.tif', bytes: plainGeoTiff(1100, 700), type: 'image/tiff' }]);
  await expect(page.locator('#status')).toContainText('stripes.tif を開きました');
  await expect(page.locator('#images .tag')).toHaveText('RSET生成中');
  await expect(page.locator('.rset-progress')).toContainText('stripes.tif の RSET を生成中');
  await expect(page.locator('#info')).toContainText('生成中');
  const first = await page.evaluate(() => {
    const image = window.viewer.images.list()[0];
    return { levels: image.source.getTileGrid()!.getResolutions().length, max: image.layer.getMaxResolution() };
  });
  expect(first.levels).toBe(1);
  // Zoomed out, nothing is drawn yet; zoomed in near the raw pixels (down to half size), it is.
  expect(first.max).toBeLessThan(Infinity);
  const raw = first.max / 2 / 1.01; // a raw pixel, in the view's units
  await page.evaluate((raw) => window.viewer.map.getView().setResolution(raw * 4), raw);
  await expect(page.locator('.rset-shown')).toHaveText(/RSET 生成中: 1\/2 以上に拡大すると表示します/);
  await expect(page.locator('#images li').first()).toHaveClass(/out-of-scale/);
  await page.evaluate((raw) => window.viewer.map.getView().setResolution(raw * 1.5), raw);
  await expect(page.locator('.rset-shown')).toHaveText('表示: 生画素');
  await expect(page.locator('#images li').first()).not.toHaveClass(/out-of-scale/);
  // A correction made meanwhile stays when the RSET comes.
  await page.evaluate(() => {
    const source = window.viewer.images.list()[0].source;
    source.setPipeline(source.getPipeline().brightness(0.2));
  });
  await page.evaluate(() => (window as unknown as { release: () => void }).release());
  await expect(page.locator('#images .tag')).toHaveText('RSET生成');
  await expect(page.locator('.rset-progress')).toBeHidden();
  const after = await page.evaluate(() => {
    const image = window.viewer.images.list()[0];
    return {
      levels: image.source.getTileGrid()!.getResolutions().length,
      max: image.layer.getMaxResolution(),
      same: image.layer.getSource() === image.source,
      pipeline: image.source.getPipeline().toJSON(),
    };
  });
  expect(after.levels).toBeGreaterThan(1);
  expect(after.max).toBe(Infinity);
  expect(after.same).toBe(true);
  expect(JSON.stringify(after.pipeline)).toContain('brightness');
  // Now drawn at every scale, from an RSET level zoomed out.
  await page.evaluate((raw) => window.viewer.map.getView().setResolution(raw * 8), raw);
  await expect(page.locator('.rset-shown')).toHaveText(/表示: RSET 1\/\d+/);
  await expect(page.locator('#images li').first()).not.toHaveClass(/out-of-scale/);
  expect(errors).toEqual([]);
});

test('a GeoTIFF chosen with its GDAL .ovr uses its levels as the RSET instead of making one', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  const data = (name: string) => new Uint8Array(readFileSync(new URL(`./data/${name}`, import.meta.url)));
  await choose(page, [
    { name: 'rgb.tif', bytes: data('rgb.tif'), type: 'image/tiff' },
    { name: 'rgb.tif.ovr', bytes: data('rgb.tif.ovr') },
  ]);
  await expect(page.locator('#status')).toContainText('rgb.tif を開きました');
  expect(await names(page)).toEqual(['rgb.tif']); // the .ovr is no layer of its own
  await expect(page.locator('#images .tag')).toHaveText('RSET (OVR)');
  await expect(page.locator('#info')).toContainText('外部 OVR（rgb.tif.ovr）・1/2〜1/8、3 レベル');
  await expect(page.locator('.rset-shown')).toHaveText(/表示: RSET 1\/\d+/);
  expect(errors).toEqual([]);
});

test('an .ovr that does not fit the image is said so, and an RSET is made instead', async ({ page }) => {
  await open(page);
  const data = (name: string) => new Uint8Array(readFileSync(new URL(`./data/${name}`, import.meta.url)));
  await choose(page, [
    { name: 'stripes.tif', bytes: plainGeoTiff(1100, 700), type: 'image/tiff' },
    { name: 'stripes.tif.ovr', bytes: data('gray16.tif.ovr') },
  ]);
  await expect(page.locator('#images .tag')).toHaveText('RSET生成');
});

test('Shapefiles and GeoJSON open with their attributes in the table, editable', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);

  // A Shapefile chosen as its .shp and .dbf, Japanese text in Shift_JIS without a .cpg.
  await choose(page, [
    { name: 'sites.shp', bytes: shp([[139.7, 35.7], [135.5, 34.7]]) },
    { name: 'sites.dbf', bytes: dbf([{ name: 'NAME', length: 10 }, { name: 'POP', type: 'N', length: 8 }], [[tokyoSjis, ascii('100')], [ascii('Osaka'), ascii('20')]]) },
  ]);
  await expect(page.locator('#status')).toContainText('sites を開きました（✎ で編集できます）');
  expect(await names(page)).toEqual(['SHPsites']);
  await expect(page.locator('#info')).toContainText('Shapefile');
  await expect(page.locator('#info')).toContainText('Shift_JIS');
  await expect(page.locator('.table-count')).toContainText('全 2 件');
  await expect(rows(page).first()).toContainText('東京');
  // An edit button: files can be edited and saved again.
  await expect(page.locator('#images li').first().locator('[data-action=edit]')).toHaveCount(1);
  // The view went to the features (Japan).
  await expect.poll(() => page.evaluate(() => window.viewer.map.getView().getCenter()![0])).toBeGreaterThan(14_000_000);

  // GeoJSON.
  const geojson = JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[139, 35], [140, 36]] }, properties: { route: '国道1号', lanes: 4 } }],
  });
  await choose(page, [{ name: 'roads.geojson', bytes: geojson, type: 'application/geo+json' }]);
  await expect(page.locator('#status')).toContainText('roads を開きました');
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
      window.viewer.map.renderSync();
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

test('a GeoPackage opens with its features and attributes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  const wgs84 = { id: 4326, organization: 'EPSG', code: 4326, definition: 'undefined' };
  const bytes = await gpkg('stations', wgs84, 'POINT', [
    [encodeGeometry(new Point([139.7, 35.7]), 4326), '東京', 100, '2024-05-01'],
    [encodeGeometry(new Point([135.5, 34.7]), 4326), '大阪', 20, null],
  ]);
  await choose(page, [{ name: 'stations.gpkg', bytes }]);
  await expect(page.locator('#status')).toContainText('stations を開きました');
  expect(await names(page)).toEqual(['GPKGstations']);
  await expect(page.locator('#info')).toContainText('GeoPackage');
  await expect(page.locator('.table-count')).toContainText('全 2 件');
  await expect(rows(page).first()).toContainText('東京');
  await expect.poll(() => page.evaluate(() => window.viewer.map.getView().getCenter()![0])).toBeGreaterThan(14_000_000);
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
