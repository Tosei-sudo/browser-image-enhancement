import { expect, test, type Page } from '@playwright/test';
import { plainGeoTiff } from './fixtures.js';

/*
 * The image catalog panel against a stand-in Esri feature layer whose
 * attribute names are mapped in config.json: search, sort, choose and open
 * a COG; an image known only by a local path is listed but not opened.
 */

const layerUrl = 'http://localhost:4175/svc/catalog/FeatureServer/0';
const config = {
  imageCatalogs: [
    {
      label: 'テストカタログ',
      url: layerUrl,
      fields: { id: 'IMG_ID', acquired: 'ACQ_TIME', registered: 'REG_TIME', sensor: 'SENSOR', angle: 'OFF_NADIR', source: ['COG_URL', 'FILE_PATH'] },
      labels: { angle: 'オフナディア角' },
      columns: [{ field: 'CLOUD', label: '雲量' }],
    },
  ],
};

const ring = (x0: number, y0: number, x1: number, y1: number) => [[[x0, y0], [x0, y1], [x1, y1], [x1, y0], [x0, y0]]];
const features = [
  { attributes: { OBJECTID: 1, IMG_ID: 'IMG-A', ACQ_TIME: Date.UTC(2026, 8, 1, 1), REG_TIME: Date.UTC(2026, 8, 2), SENSOR: 'S1', OFF_NADIR: 10, CLOUD: 5, COG_URL: 'http://localhost:4175/fixture.tif', FILE_PATH: null }, geometry: { rings: ring(139.6, 35.6, 139.9, 35.75) } },
  { attributes: { OBJECTID: 2, IMG_ID: 'IMG-B', ACQ_TIME: Date.UTC(2026, 9, 1, 1), REG_TIME: Date.UTC(2026, 9, 2), SENSOR: 'S2', OFF_NADIR: 25, CLOUD: 40, COG_URL: '', FILE_PATH: '\\\\nas\\img\\b.tif' }, geometry: { rings: ring(139.65, 35.62, 139.8, 35.7) } },
  { attributes: { OBJECTID: 3, IMG_ID: 'IMG-C', ACQ_TIME: Date.UTC(2026, 7, 1, 1), REG_TIME: Date.UTC(2026, 7, 2), SENSOR: 'S2', OFF_NADIR: 5, CLOUD: 0, COG_URL: 'http://localhost:4175/fixture16.tif', FILE_PATH: null }, geometry: { rings: ring(139.6, 35.6, 139.9, 35.75) } },
];

/** Serves the stand-in catalog; returns the `where` of each search. */
async function serveCatalog(page: Page, list = features, settings: object = config): Promise<string[]> {
  const searches: string[] = [];
  await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(settings) }));
  await page.route(`${layerUrl}**`, async (route) => {
    const request = route.request();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (!request.url().includes('/query')) {
      return json({
        id: 0,
        name: 'カタログ',
        geometryType: 'esriGeometryPolygon',
        fields: [
          { name: 'OBJECTID', type: 'esriFieldTypeOID' },
          { name: 'IMG_ID', type: 'esriFieldTypeString' },
          { name: 'ACQ_TIME', type: 'esriFieldTypeDate' },
          { name: 'REG_TIME', type: 'esriFieldTypeDate' },
          { name: 'SENSOR', type: 'esriFieldTypeString' },
          { name: 'OFF_NADIR', type: 'esriFieldTypeDouble' },
        ],
        advancedQueryCapabilities: { supportsPagination: true, supportsOrderBy: true },
      });
    }
    const form = new URLSearchParams(request.postData() ?? '');
    if (form.get('returnDistinctValues') === 'true') return json({ features: [...new Set(list.map((f) => f.attributes.SENSOR))].map((SENSOR) => ({ attributes: { SENSOR } })) });
    const where = form.get('where') ?? '';
    const sensor = /SENSOR = '([^']*)'/.exec(where)?.[1];
    const angle = /OFF_NADIR <= ([\d.]+)/.exec(where)?.[1];
    const found = list.filter((f) => (!sensor || f.attributes.SENSOR === sensor) && (!angle || f.attributes.OFF_NADIR <= Number(angle)));
    if (form.get('returnCountOnly') === 'true') return json({ count: found.length });
    searches.push(where);
    return json({ geometryType: 'esriGeometryPolygon', spatialReference: { wkid: 4326 }, features: found });
  });
  return searches;
}

test('no catalog in config.json, no button', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  await expect(page.locator('#catalog-open')).toBeHidden();
  expect(errors).toEqual([]);
});

test('searches, sorts, and opens a COG from the catalog', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const searches = await serveCatalog(page);
  await page.goto('/index.html');

  await page.locator('#catalog-open').click();
  const dialog = page.locator('.catalog-dialog');
  const rows = dialog.locator('tbody tr');
  // Opening lists what is in view, newest first.
  await expect(rows).toHaveCount(3);
  await expect(rows.locator('td:nth-child(4)')).toHaveText(['IMG-B', 'IMG-A', 'IMG-C']);
  await expect(dialog.locator('thead')).toContainText('オフナディア角');
  await expect(dialog.locator('thead')).toContainText('雲量');
  await expect(rows.nth(0).locator('.catalog-kind')).toHaveText('ローカル');
  await expect(dialog.locator('.service-status')).toContainText('3 件（うちローカルパスのみ 1 件）');
  expect(await page.evaluate(() => window.viewer.catalog.footprints.getSource()!.getFeatures().length)).toBe(3);

  // Sensor and angle narrow the search.
  await dialog.locator('select[name=sensor]').selectOption('S2');
  await dialog.locator('input[name=maxAngle]').fill('20');
  await dialog.locator('button.catalog-search').click();
  await expect(rows).toHaveCount(1);
  expect(searches.at(-1)).toBe("SENSOR = 'S2' AND OFF_NADIR <= 20");

  await dialog.locator('select[name=sensor]').selectOption('');
  await dialog.locator('input[name=maxAngle]').fill('');
  await dialog.locator('button.catalog-search').click();
  await expect(rows).toHaveCount(3);

  // Sort by the angle, smallest first.
  await dialog.locator('thead button', { hasText: 'オフナディア角' }).click();
  await expect(rows.locator('td:nth-child(4)')).toHaveText(['IMG-C', 'IMG-A', 'IMG-B']);

  // A local path cannot be opened yet; its path can be copied.
  await rows.filter({ hasText: 'IMG-B' }).click();
  await expect(dialog.locator('button[value=open]')).toBeDisabled();
  await expect(dialog.locator('button[value=copy]')).toBeEnabled();

  // Open the COG with a double click: the image comes with the catalog's attributes.
  await rows.filter({ hasText: 'IMG-A' }).dblclick();
  await expect(page.locator('#images li')).toHaveCount(1);
  await page.locator('#images li .name').first().click();
  await expect(page.locator('#info')).toContainText('IMG-A');
  await expect(page.locator('#info')).toContainText('テストカタログ');
  expect(errors).toEqual([]);
});

test('local paths open from a folder allowed once, or through a URL', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // The folder picker gives a folder of the origin's private file system, which IndexedDB can keep.
  await page.addInitScript(() => {
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle('img');
  });
  const local = [
    { attributes: { ...features[1].attributes, IMG_ID: 'IMG-L', FILE_PATH: '\\\\NAS\\img\\2026\\Scene.TIF' }, geometry: features[1].geometry },
    { attributes: { ...features[2].attributes, IMG_ID: 'IMG-U', COG_URL: '', FILE_PATH: 'Z:\\cog\\fixture16.tif' }, geometry: features[2].geometry },
  ];
  const settings = {
    ...config,
    pathMappings: [
      { prefix: '\\\\nas\\img', label: '画像NAS' },
      { prefix: 'Z:/cog', url: 'http://localhost:4175/' },
    ],
  };
  await serveCatalog(page, local, settings);
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.evaluate(async (bytes) => {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('img', { create: true })).getDirectoryHandle('2026', { create: true });
    for (const name of ['scene.tif', 'other.tif']) {
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(new Uint8Array(bytes));
      await writable.close();
    }
  }, Array.from(plainGeoTiff(300, 200)));

  await page.locator('#catalog-open').click();
  const dialog = page.locator('.catalog-dialog');
  const rows = dialog.locator('tbody tr');
  await expect(rows).toHaveCount(2);

  // A path under a URL mapping opens as a COG.
  await rows.filter({ hasText: 'IMG-U' }).dblclick();
  await expect(page.locator('#images .name')).toHaveText(['fixture16.tif']);

  // The first path under the NAS asks for its folder, once; the file is found whatever its case.
  await rows.filter({ hasText: 'IMG-L' }).click();
  await dialog.locator('button[value=open]').click();
  const ask = page.locator('dialog.folder-ask');
  await expect(ask).toContainText('「画像NAS」のフォルダ');
  await ask.getByRole('button', { name: 'フォルダを選ぶ…' }).click();
  await expect(page.locator('#images .name')).toHaveText(['scene.tif', 'fixture16.tif']);
  await page.locator('#images .name', { hasText: 'scene.tif' }).click();
  await expect(page.locator('#info')).toContainText('IMG-L');
  await expect(page.locator('#info')).toContainText('300 × 200 px');

  // After a reload the folder is remembered.
  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.locator('#catalog-open').click();
  await rows.filter({ hasText: 'IMG-L' }).dblclick();
  await expect(page.locator('#images .name')).toHaveText(['scene.tif']);
  await expect(ask).toHaveCount(0);

  // Forgotten, it asks again; cancelling opens nothing.
  await dialog.locator('summary').click();
  await dialog.getByRole('button', { name: 'フォルダの許可を消去' }).click();
  await rows.filter({ hasText: 'IMG-L' }).dblclick();
  await ask.getByRole('button', { name: 'キャンセル' }).click();
  await expect(page.locator('#status')).toHaveText('キャンセルしました');
  await expect(page.locator('#images .name')).toHaveCount(1);
  expect(errors).toEqual([]);
});
