import { expect, test, type Page } from '@playwright/test';

/*
 * Esri image services (ImageServer) and the map of map services (MapServer),
 * against the stand-ins of test/services.mjs: opening an image service from
 * the URL box, its display rules (an attribute condition, the stacking order,
 * a raster function), config.json's named rules, `?service=` links,
 * identify, bringing the view in as an image, and a map service's layers.
 */

const base = 'http://localhost:4175';
const scenes = `${base}/svc/arcgis/rest/services/Scenes/ImageServer`;
const mapService = `${base}/svc/arcgis/rest/services/Base/MapServer`;

interface RasterRequest {
  service: string;
  op: string;
  [key: string]: string;
}

async function open(page: Page, query = '', config?: object) {
  await page.request.get(`${base}/svc/reset`);
  await page.route(/cyberjapandata\.gsi\.go\.jp|tile\.openstreetmap\.org/, (route) => route.fulfill({ status: 404, body: '' }));
  if (config) await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config) }));
  await page.goto(`/index.html${query}`);
  await page.waitForFunction(() => window.viewer !== undefined);
}

const requests = async (page: Page, op: string): Promise<RasterRequest[]> =>
  ((await (await page.request.get(`${base}/svc/raster-requests`)).json()) as RasterRequest[]).filter((r) => r.op === op);

/** The mosaic rules of the exportImage requests since `from`. */
const mosaicRules = async (page: Page, from = 0) => (await requests(page, 'exportImage')).slice(from).map((r) => (r.mosaicRule ? JSON.parse(r.mosaicRule) : null));

async function openFromUrlBox(page: Page, url: string) {
  await page.getByRole('button', { name: 'URL を開く（COG・Esri ImageServer）' }).click();
  await page.getByRole('textbox', { name: 'URL を開く（COG・Esri ImageServer）' }).fill(url);
  await page.getByRole('button', { name: '開く', exact: true }).click();
}

test('an image service opens from the URL box and draws with exportImage', async ({ page }) => {
  await open(page);
  await openFromUrlBox(page, scenes);
  const row = page.locator('#images li', { hasText: 'Scenes' });
  await expect(row).toBeVisible();
  await expect(row.locator('.badge')).toHaveText('Esri');
  await expect.poll(async () => (await requests(page, 'exportImage')).length).toBeGreaterThan(0);
  const first = (await requests(page, 'exportImage'))[0];
  expect(first).toMatchObject({ bboxSR: '3857', imageSR: '3857', size: '512,512', f: 'image' });
  // The service's own mosaicking until rules are set.
  expect(first.mosaicRule).toBeUndefined();
  await expect(page.locator('#info')).toContainText('Esri イメージサービス');
  await expect(page.locator('#info')).toContainText('4');
});

test('display rules: a condition, the stacking order and a raster function', async ({ page }) => {
  await open(page);
  await openFromUrlBox(page, scenes);
  const row = page.locator('#images li', { hasText: 'Scenes' });
  await row.getByRole('button', { name: /表示ルール/ }).click();
  const dialog = page.getByRole('dialog', { name: '表示ルール: Scenes' });
  await expect(dialog).toBeVisible();
  // No rules in config.json: no rule list.
  await expect(dialog.getByRole('combobox', { name: 'ルール', exact: true })).toBeHidden();
  await expect(dialog.getByText('条件に合う画像: 3 件')).toBeVisible();

  // A condition put together from an attribute, an operator and a value.
  await dialog.getByRole('combobox', { name: '条件の属性' }).selectOption('CloudCover');
  await dialog.getByRole('combobox', { name: '比べ方' }).selectOption('<=');
  await dialog.getByRole('combobox', { name: '条件の値' }).fill('0.2');
  await dialog.getByRole('button', { name: '条件に追加（AND）' }).click();
  await expect(dialog.getByRole('textbox', { name: '条件', exact: true })).toHaveValue('CloudCover <= 0.2');
  await expect(dialog.getByText('条件に合う画像: 2 件')).toBeVisible();
  await dialog.getByRole('combobox', { name: '並び順の属性' }).selectOption('AcquisitionDate');
  await dialog.getByRole('combobox', { name: 'ラスター関数' }).selectOption('NDVI');

  const before = (await requests(page, 'exportImage')).length;
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await requests(page, 'exportImage')).length).toBeGreaterThan(before);
  const after = (await requests(page, 'exportImage')).slice(before);
  expect(JSON.parse(after[0].mosaicRule)).toEqual({ mosaicMethod: 'esriMosaicAttribute', where: 'CloudCover <= 0.2', sortField: 'AcquisitionDate', ascending: false, mosaicOperation: 'MT_FIRST' });
  expect(JSON.parse(after[0].renderingRule)).toEqual({ rasterFunction: 'NDVI' });
  await expect(page.locator('#info')).toContainText('CloudCover <= 0.2');

  // The link keeps the rules, and opens the layer with them again.
  const link = new URL(page.url()).search;
  expect(new URLSearchParams(link).get('service')).toContain('CloudCover');
  await page.request.get(`${base}/svc/reset`);
  await page.goto(`/index.html${link}`);
  await page.waitForFunction(() => window.viewer !== undefined);
  await expect(page.locator('#images li', { hasText: 'Scenes' })).toBeVisible();
  await expect.poll(async () => (await mosaicRules(page)).length).toBeGreaterThan(0);
  expect((await mosaicRules(page))[0]).toMatchObject({ where: 'CloudCover <= 0.2', sortField: 'AcquisitionDate' });

  // Cancel goes back to what was drawn; a bad rendering rule is refused.
  await page.locator('#images li', { hasText: 'Scenes' }).getByRole('button', { name: /表示ルール/ }).click();
  await dialog.getByText('詳細').click();
  await dialog.getByRole('textbox', { name: 'レンダリングルール' }).fill('{not json');
  await dialog.getByRole('button', { name: '適用' }).click();
  await expect(dialog.locator('.raster-status')).toHaveText('レンダリングルールが JSON として読めません');
  await dialog.getByRole('button', { name: 'キャンセル' }).click();
  await expect(dialog).toBeHidden();
});

test('config.json rules: one applies on open, and others can be chosen', async ({ page }) => {
  await open(page, '', {
    serviceRules: [
      { label: '雲なし・新しい順', match: 'Scenes/ImageServer', default: true, where: 'CloudCover <= 0.1', sortField: 'AcquisitionDate' },
      { label: 'WV3 のみ', match: 'Scenes/ImageServer', where: "Sensor = 'WV3'", rasterFunction: 'Natural Color' },
      { label: '別のサービス', match: 'Other/ImageServer', where: 'X = 1' },
    ],
  });
  await openFromUrlBox(page, scenes);
  await expect(page.locator('#images li', { hasText: 'Scenes' })).toBeVisible();
  await expect.poll(async () => (await mosaicRules(page)).length).toBeGreaterThan(0);
  expect((await mosaicRules(page))[0]).toMatchObject({ where: 'CloudCover <= 0.1', sortField: 'AcquisitionDate' });
  await expect(page.locator('#info')).toContainText('雲なし・新しい順');

  await page.locator('#images li', { hasText: 'Scenes' }).getByRole('button', { name: /表示ルール/ }).click();
  const dialog = page.getByRole('dialog', { name: '表示ルール: Scenes' });
  const rule = dialog.getByRole('combobox', { name: 'ルール', exact: true });
  await expect(rule).toHaveValue('雲なし・新しい順');
  expect(await rule.locator('option').allTextContents()).toEqual(['サービスの既定', '雲なし・新しい順', 'WV3 のみ', 'カスタム']);
  await rule.selectOption('WV3 のみ');
  await expect(dialog.getByRole('textbox', { name: '条件', exact: true })).toHaveValue("Sensor = 'WV3'");
  await expect(dialog.getByText('条件に合う画像: 2 件')).toBeVisible();
  const before = (await requests(page, 'exportImage')).length;
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect.poll(async () => (await requests(page, 'exportImage')).length).toBeGreaterThan(before);
  const next = (await requests(page, 'exportImage')).slice(before)[0];
  expect(JSON.parse(next.mosaicRule).where).toBe("Sensor = 'WV3'");
  expect(JSON.parse(next.renderingRule)).toEqual({ rasterFunction: 'Natural Color' });
  await expect(page.locator('#info')).toContainText('WV3 のみ');

  // Editing a field makes the rules the user's own.
  await page.locator('#images li', { hasText: 'Scenes' }).getByRole('button', { name: /表示ルール/ }).click();
  await dialog.getByRole('textbox', { name: '条件', exact: true }).fill("Sensor = 'WV2'");
  await expect(rule).toHaveValue('');
  await dialog.getByRole('button', { name: '既定に戻す' }).click();
  await expect(rule).toHaveValue('\u0000default');
  await expect(dialog.getByRole('textbox', { name: '条件', exact: true })).toHaveValue('');
});

test('a click identifies the pixel and the images under it, and the view comes in as an image', async ({ page }) => {
  await open(page);
  await openFromUrlBox(page, scenes);
  await expect(page.locator('#images li', { hasText: 'Scenes' })).toBeVisible();
  await page.waitForFunction(() => !window.viewer.map.getView().getAnimating());
  const box = (await page.locator('#map').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('#status')).toHaveText('3 件の地物があります');
  const rows = page.locator('.attributes tbody tr[data-index]');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('表示中');
  await expect(rows.first()).toContainText('120, 80, 60, 200');
  await expect(rows.first()).toContainText('S1');

  // 「表示範囲を画像として開く」: the stored values as a GeoTIFF, a new image layer.
  await page.locator('#images li', { hasText: 'Scenes' }).getByRole('button', { name: /表示ルール/ }).click();
  const dialog = page.getByRole('dialog', { name: '表示ルール: Scenes' });
  await dialog.getByRole('button', { name: '表示範囲を画像として開く' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#images li', { hasText: /^.*Scenes_\d+\.tif/ })).toBeVisible();
  const exported = (await requests(page, 'exportImage')).find((r) => r.format === 'tiff')!;
  expect(JSON.parse(exported.renderingRule)).toEqual({ rasterFunction: 'None' });
});

test('a map service: its map as a picture, the layers drawn and a condition on each', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'サービスを追加' }).click();
  const add = page.getByRole('dialog', { name: 'サービスを追加' });
  await add.getByRole('textbox', { name: 'サービスの URL' }).fill(mapService);
  await add.getByRole('button', { name: '読み込む' }).click();
  await expect(add.locator('.service-layer')).toHaveCount(3);
  await expect(add.locator('.service-layer .title').first()).toHaveText('Base（地図画像）');
  await add.locator('.service-layer input[type=checkbox]').first().check();
  await add.getByRole('button', { name: '追加', exact: true }).click();
  await expect(add).toBeHidden();
  await expect.poll(async () => (await requests(page, 'export')).length).toBeGreaterThan(0);
  const first = (await requests(page, 'export'))[0];
  expect(first).toMatchObject({ format: 'png32', transparent: 'true', f: 'image' });
  expect(first.layers).toBeUndefined();

  const row = page.locator('#images li', { hasText: 'Base' });
  await row.getByRole('button', { name: /表示ルール/ }).click();
  const dialog = page.getByRole('dialog', { name: '表示ルール: Base' });
  await expect(dialog.getByRole('checkbox', { name: '道路 を表示' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: '建物 を表示' })).not.toBeChecked();
  await dialog.getByRole('checkbox', { name: '道路 を表示' }).uncheck();
  await dialog.getByRole('checkbox', { name: '建物 を表示' }).check();
  await dialog.getByRole('textbox', { name: '建物 の条件' }).fill('HEIGHT > 30');
  const before = (await requests(page, 'export')).length;
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect.poll(async () => (await requests(page, 'export')).length).toBeGreaterThan(before);
  const next = (await requests(page, 'export')).slice(before)[0];
  expect(next.layers).toBe('show:1');
  expect(JSON.parse(next.layerDefs)).toEqual({ '1': 'HEIGHT > 30' });

  // A click asks identify of the layers drawn.
  await page.waitForFunction(() => !window.viewer.map.getView().getAnimating());
  const box = (await page.locator('#map').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('#status')).toHaveText('1 件の地物があります');
  const identify = (await requests(page, 'identify')).at(-1)!;
  expect(identify.layers).toBe('visible:1');
  await expect(page.locator('.attributes tbody tr[data-index]').first()).toContainText('中央通り');
});
