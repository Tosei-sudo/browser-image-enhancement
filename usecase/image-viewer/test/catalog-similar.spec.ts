import { expect, test, type Page } from '@playwright/test';

/*
 * 「似た画像を探す」 against a stand-in Esri catalog: from the layer of an
 * image opened from the catalog, the panel lists the images of the same
 * sensor with near angles over the same ground, the most alike first.
 */

const layerUrl = 'http://localhost:4175/svc/similar/FeatureServer/0';
const config = {
  imageCatalogs: [
    {
      label: 'テストカタログ',
      url: layerUrl,
      fields: { id: 'IMG_ID', acquired: 'ACQ_TIME', sensor: 'SENSOR', angle: 'OFF_NADIR', azimuth: 'AZIMUTH', source: 'COG_URL' },
      labels: { angle: 'オフナディア角' },
    },
  ],
};

const ring = (x0: number, y0: number, x1: number, y1: number) => [[[x0, y0], [x0, y1], [x1, y1], [x1, y0], [x0, y0]]];
const image = (id: string, day: number, sensor: string, angle: number, azimuth: number, rings: number[][][]) => ({
  attributes: { OBJECTID: day, IMG_ID: id, ACQ_TIME: Date.UTC(2026, 8, day), SENSOR: sensor, OFF_NADIR: angle, AZIMUTH: azimuth, COG_URL: `http://localhost:4175/fixture.tif?${id}` },
  geometry: { rings },
});
const whole = ring(139.6, 35.6, 139.9, 35.75);
const features = [
  image('IMG-A', 1, 'S1', 10, 120, whole),
  // Alike: the same ground, 2° and 5° away.
  image('IMG-B', 2, 'S1', 12, 125, whole),
  // Half of the ground, 1° and 2° away.
  image('IMG-C', 3, 'S1', 11, 118, ring(139.75, 35.6, 139.9, 35.75)),
  // Taken alike, elsewhere.
  image('IMG-D', 4, 'S1', 10, 120, ring(140.2, 36, 140.3, 36.1)),
  // Another sensor; a far angle.
  image('IMG-E', 5, 'S2', 10, 120, whole),
  image('IMG-F', 6, 'S1', 30, 120, whole),
];

/** Serves the stand-in catalog, minding the sensor and the angle limits; returns the `where` of each search. */
async function serveCatalog(page: Page): Promise<string[]> {
  const searches: string[] = [];
  await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config) }));
  await page.route(`${layerUrl}**`, async (route) => {
    const request = route.request();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (!request.url().includes('/query')) {
      return json({
        id: 0,
        geometryType: 'esriGeometryPolygon',
        fields: ['OBJECTID', 'IMG_ID', 'SENSOR', 'COG_URL'].map((name) => ({ name, type: 'esriFieldTypeString' })).concat([{ name: 'ACQ_TIME', type: 'esriFieldTypeDate' }]),
        advancedQueryCapabilities: { supportsPagination: true, supportsOrderBy: true },
      });
    }
    const form = new URLSearchParams(request.postData() ?? '');
    if (form.get('returnDistinctValues') === 'true') return json({ features: [...new Set(features.map((f) => f.attributes.SENSOR))].map((SENSOR) => ({ attributes: { SENSOR } })) });
    const where = form.get('where') ?? '';
    const sensor = /SENSOR = '([^']*)'/.exec(where)?.[1];
    const low = Number(/OFF_NADIR >= ([\d.]+)/.exec(where)?.[1] ?? -Infinity);
    const high = Number(/OFF_NADIR <= ([\d.]+)/.exec(where)?.[1] ?? Infinity);
    const found = features.filter((f) => (!sensor || f.attributes.SENSOR === sensor) && f.attributes.OFF_NADIR >= low && f.attributes.OFF_NADIR <= high).reverse();
    if (form.get('returnCountOnly') === 'true') return json({ count: found.length });
    searches.push(where);
    return json({ geometryType: 'esriGeometryPolygon', spatialReference: { wkid: 4326 }, features: found });
  });
  return searches;
}

test('finds images taken like one opened from the catalog', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const searches = await serveCatalog(page);
  await page.goto('/index.html');

  await page.locator('#catalog-open').click();
  const dialog = page.locator('.catalog-dialog');
  const rows = dialog.locator('tbody tr');
  await expect(rows).toHaveCount(6);
  await rows.filter({ hasText: 'IMG-A' }).dblclick();
  await expect(page.locator('#images li.image')).toHaveCount(1);
  await dialog.locator('.catalog-close').click();

  // The layer's menu: 「似た画像を探す…」.
  await page.locator('#images li.image .name').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '似た画像を探す…' }).click();
  await expect(dialog).toBeVisible();
  const box = dialog.locator('.catalog-similar');
  await expect(box).toBeVisible();
  await expect(box).toContainText('IMG-A');
  await expect(box).toContainText('同じセンサー（S1）');
  await expect(box).toContainText('オフナディア角（10°）');
  await expect(dialog.locator('select[name=sensor]')).toBeHidden();
  await expect.poll(() => searches.at(-1)).toBe("SENSOR = 'S1' AND AZIMUTH >= 100 AND AZIMUTH <= 140 AND (OFF_NADIR >= 5 AND OFF_NADIR <= 15)");
  // The most alike first, with the share of the ground; the image itself and one elsewhere left out.
  await expect(rows).toHaveCount(2);
  await expect(rows.locator('td:nth-child(6)')).toHaveText(['IMG-B', 'IMG-C']);
  await expect(rows.locator('td:nth-child(1)')).toHaveText(['100%', '50%']);
  await expect(dialog.locator('.service-status')).toContainText('似た画像 2 件');
  // Its footprint stays on the map beside theirs.
  expect(await page.evaluate(() => window.viewer.catalog.footprints.getSource()!.getFeatures().length)).toBe(3);

  // Narrower tolerances; a least share of the ground.
  await box.locator('input[name=angleTolerance]').fill('1');
  await dialog.locator('button.catalog-search').click();
  await expect.poll(() => searches.at(-1)).toContain('OFF_NADIR >= 9 AND OFF_NADIR <= 11');
  await expect(rows.locator('td:nth-child(6)')).toHaveText(['IMG-C']);
  await box.locator('input[name=angleTolerance]').fill('5');
  await box.locator('input[name=minOverlap]').fill('60');
  await dialog.locator('button.catalog-search').click();
  await expect(rows.locator('td:nth-child(6)')).toHaveText(['IMG-B']);
  await box.locator('input[name=minOverlap]').fill('0');

  // Any sensor: the other one comes in, after the same sensor's.
  await box.locator('input[name=sameSensor]').uncheck();
  await dialog.locator('button.catalog-search').click();
  await expect(rows.locator('td:nth-child(6)')).toHaveText(['IMG-B', 'IMG-C', 'IMG-E']);

  // The tolerances are remembered.
  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.locator('#catalog-open').click();
  await expect(rows).toHaveCount(6);
  await expect(dialog.locator('input[name=sameSensor]')).not.toBeChecked();

  // From the list: one image chosen, 「似た画像を探す」; back to the everyday search.
  await rows.filter({ hasText: 'IMG-B' }).click();
  await dialog.getByRole('button', { name: '似た画像を探す' }).click();
  await expect(box).toContainText('IMG-B');
  await expect(rows.locator('td:nth-child(6)')).toHaveText(['IMG-A', 'IMG-C', 'IMG-E']);
  await box.locator('input[name=sameSensor]').check();
  await dialog.locator('button.catalog-search').click();
  await expect(rows.locator('td:nth-child(6)')).toHaveText(['IMG-A', 'IMG-C']);
  await box.getByRole('button', { name: 'ふつうの検索に戻る' }).click();
  await expect(box).toBeHidden();
  await expect(rows).toHaveCount(6);
  await expect(dialog.locator('thead')).not.toContainText('重なり');
  expect(errors).toEqual([]);
});
