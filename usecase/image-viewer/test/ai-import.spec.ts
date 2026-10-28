import { expect, test, type Page } from '@playwright/test';

/*
 * AI results into 観測記録: an image opened from the image catalog brings
 * the results of its catalog id from an AI system's Esri layer
 * (config.json's aiResultSources, stand-ins behind page.route), shown as a
 * layer; 「観測記録へ取り込み…」 records them as points — a polygon at its
 * centroid, its class as a kind, its score as 確度 — and not twice.
 */

const catalogUrl = 'http://localhost:4175/svc/catalog/FeatureServer/0';
const resultsUrl = 'http://localhost:4175/svc/ai-results/FeatureServer/0';
const config = {
  imageCatalogs: [{ label: 'テストカタログ', url: catalogUrl, fields: { id: 'IMG_ID', acquired: 'ACQ_TIME', source: 'COG_URL' } }],
  aiResultSources: [{ label: '外部AI', url: resultsUrl, fields: { imageId: 'IMAGE_ID', class: 'CLASS', score: 'SCORE' } }],
  aiImport: { classes: { ship: '船舶' } },
};

const ring = (x0: number, y0: number, x1: number, y1: number) => [[[x0, y0], [x0, y1], [x1, y1], [x1, y0], [x0, y0]]];
/** Web Mercator of a longitude / latitude. */
const mercator = (lon: number, lat: number) => [(lon * 20037508.342789244) / 180, Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * 6378137];
const box = (lon: number, lat: number) => {
  const [x, y] = mercator(lon, lat);
  return { rings: [[[x, y], [x + 120, y], [x + 120, y - 40], [x, y - 40], [x, y]]] };
};

async function serve(page: Page): Promise<string[]> {
  const asked: string[] = [];
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config) }));
  await page.route(`${catalogUrl}**`, (route) => {
    if (!route.request().url().includes('/query')) {
      return route.fulfill(json({ id: 0, name: 'カタログ', geometryType: 'esriGeometryPolygon', fields: [{ name: 'OBJECTID', type: 'esriFieldTypeOID' }, { name: 'IMG_ID', type: 'esriFieldTypeString' }, { name: 'ACQ_TIME', type: 'esriFieldTypeDate' }] }));
    }
    const form = new URLSearchParams(route.request().postData() ?? '');
    if (form.get('returnCountOnly') === 'true') return route.fulfill(json({ count: 1 }));
    return route.fulfill(
      json({
        geometryType: 'esriGeometryPolygon',
        spatialReference: { wkid: 4326 },
        features: [{ attributes: { OBJECTID: 1, IMG_ID: 'IMG-A', ACQ_TIME: Date.UTC(2026, 8, 1, 1), COG_URL: 'http://localhost:4175/fixture.tif' }, geometry: { rings: ring(139.6, 35.6, 139.9, 35.75) } }],
      }),
    );
  });
  await page.route(`${resultsUrl}/query**`, (route) => {
    const form = new URLSearchParams(route.request().postData() ?? '');
    asked.push(form.get('where') ?? '');
    return route.fulfill(
      json({
        geometryType: 'esriGeometryPolygon',
        spatialReference: { wkid: 102100 },
        features: /IMAGE_ID = 'IMG-A'/.test(form.get('where') ?? '')
          ? [
              { attributes: { OBJECTID: 1, IMAGE_ID: 'IMG-A', CLASS: 'ship', SCORE: 0.93 }, geometry: box(139.7, 35.68) },
              { attributes: { OBJECTID: 2, IMAGE_ID: 'IMG-A', CLASS: 'ship', SCORE: 0.4 }, geometry: box(139.72, 35.68) },
              { attributes: { OBJECTID: 3, IMAGE_ID: 'IMG-A', CLASS: 'plane', SCORE: 0.85 }, geometry: box(139.74, 35.69) },
            ]
          : [],
      }),
    );
  });
  return asked;
}

test('results of an image opened from the catalog are shown and recorded as observation points', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const asked = await serve(page);
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);

  await page.locator('#catalog-open').click();
  const catalog = page.locator('.catalog-dialog');
  await catalog.locator('tbody tr').filter({ hasText: 'IMG-A' }).dblclick();
  // The results of its catalog id come as a layer of their own.
  await expect(page.locator('#images .name', { hasText: 'AI 結果 外部AI（IMG-A）' })).toHaveCount(1);
  expect(asked).toEqual(["IMAGE_ID = 'IMG-A'"]);
  await catalog.locator('.catalog-close').click();

  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#ai-import').click();
  const dialog = page.locator('.ai-import-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('select[name=layer] option:checked')).toHaveText('AI 結果 外部AI（IMG-A）');
  await expect(dialog.locator('select[name=image] option:checked')).toContainText('fixture.tif');
  await expect(dialog.locator('.ai-import-plan')).toHaveText('このブラウザ へ 3 件をポイントで記録');

  // Classes to kinds (config.json's, else by name), the lowest score.
  await dialog.locator('summary').click();
  await expect(dialog.locator('input[data-class=ship]')).toHaveValue('船舶');
  await dialog.locator('input[data-class=plane]').fill('航空機');
  await dialog.locator('input[name=minScore]').fill('0.5');
  await expect(dialog.locator('.ai-import-plan')).toHaveText('このブラウザ へ 2 件をポイントで記録（除外: スコア下限未満 1 件）');
  await dialog.getByRole('button', { name: '取り込み' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.obs-dialog')).toBeVisible();

  const records = await page.evaluate(() =>
    window.viewer.observations
      .records()
      .map((o) => ({ image: o.imageId, kind: o.kind, confidence: o.confidence, note: o.note, length: o.length, lon: Math.round(o.lon * 1e4) / 1e4, lat: Math.round(o.lat * 1e4) / 1e4 }))
      .sort((a, b) => a.lon - b.lon),
  );
  // At each box's centroid, 確度 by score (≥ 0.8: 推定), the long side as its length.
  expect(records).toEqual([
    { image: 'IMG-A', kind: '船舶', confidence: '推定', note: 'AI: ship 0.93（外部AI）', length: expect.any(Number), lon: 139.7005, lat: 35.6799 },
    { image: 'IMG-A', kind: '航空機', confidence: '推定', note: 'AI: plane 0.85（外部AI）', length: expect.any(Number), lon: 139.7405, lat: 35.6899 },
  ]);
  expect(records[0].length).toBeGreaterThan(90);

  // Importing again records nothing twice.
  await page.evaluate(() => void window.viewer.aiImport.open());
  await expect(dialog.locator('.ai-import-plan')).toHaveText('このブラウザ へ 1 件をポイントで記録（除外: 記録済みの位置 2 件）');
  // The kind given to a class is remembered.
  await expect(dialog.locator('input[data-class=plane]')).toHaveValue('航空機');
  expect(errors).toEqual([]);
});
