import { expect, test, type Page } from '@playwright/test';
import { plainGeoTiff } from './fixtures.js';

/*
 * 「観測記録」: things recorded image by image with a click, carried over to
 * the next image, and each thing's flow in image-time order whatever order
 * the images were opened and recorded in; kept in the browser, or in an Esri
 * point layer (a stand-in behind page.route).
 */

/** Opens three images of the same place, out of time order. */
async function openImages(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  const bytes = Array.from(plainGeoTiff(400, 300));
  await page.evaluate(async (data) => {
    const files = ['site_20261005.tif', 'site_20261001.tif', 'site_20261003.tif'].map((name) => new File([new Uint8Array(data)], name, { type: 'image/tiff' }));
    await window.viewer.project.openFiles(files);
  }, bytes);
  await expect(page.locator('#images .name')).toHaveCount(3);
  await page.waitForFunction(() => window.viewer.map.getView().getResolution() !== undefined);
}

async function openPanel(page: Page) {
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#observe-open').click();
  const panel = page.locator('.obs-dialog');
  await expect(panel).toBeVisible();
  // The images' middle at a quarter of the map's width, clear of the panel at the right.
  await page.evaluate(() => {
    const map = window.viewer.map;
    const view = map.getView();
    const size = map.getSize()!;
    view.centerOn(view.getCenter()!, size, [size[0] / 4, size[1] / 2]);
  });
  return panel;
}

const flows = (page: Page) =>
  page.evaluate(() => window.viewer.observations.flows().map((f) => ({ name: f.name, images: f.observations.map((o) => o.imageName), steps: f.steps.map((s) => (s.present ? s.activity : 'いない')) })));

test('things are recorded image by image, carried over, and followed in time order', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openImages(page);
  const panel = await openPanel(page);
  // The images in time order, whatever order they were opened in.
  await expect(panel.locator('select[name=image] option')).toHaveText([/2026-10-01.*site_20261001\.tif/, /2026-10-03/, /2026-10-05/]);
  await panel.locator('select[name=image]').selectOption({ index: 1 });
  await expect(panel.getByRole('button', { name: 'クリック記録中' })).toHaveAttribute('aria-pressed', 'true');

  const map = page.locator('#map');
  const box = (await map.boundingBox())!;
  // A click, a name, an activity, Enter.
  await map.click({ position: { x: box.width / 4, y: box.height / 2 } });
  const form = panel.locator('.obs-form');
  await expect(form.locator('input[name=object]')).toBeFocused();
  await form.locator('input[name=object]').fill('タンカーA');
  await form.getByRole('radio', { name: /停泊/ }).click();
  await form.locator('input[name=object]').press('Enter');
  await expect(panel.locator('.service-status')).toContainText('タンカーA（停泊）を記録');
  // A second with no name gets one by its kind; the kind and activity stay as last used.
  await map.click({ position: { x: box.width / 4 + 30, y: box.height / 2 + 20 } });
  await expect(form).toBeVisible();
  await form.locator('input[name=object]').press('Enter');
  await expect(panel.locator('.obs-list tbody tr')).toHaveCount(2);
  await expect(panel.locator('.obs-list tbody')).toContainText('船舶-1');
  const first = await page.evaluate(() => window.viewer.observations.records()[0]);
  expect(first).toMatchObject({ imageId: 'site_20261003.tif', imageName: 'site_20261003.tif', objectName: 'タンカーA', kind: '船舶', activity: '停泊', present: true, deletedAt: null });
  expect(first.imageTime).toBe(new Date(2026, 9, 3).getTime());
  expect(first.createdAt).toBeGreaterThan(0);

  // The image before: both things are offered (from the later image); all of them are still there.
  await page.keyboard.press('PageUp');
  await expect(panel.locator('select[name=image]')).toHaveValue('0');
  await expect(panel.locator('.obs-carry')).toHaveText('前後の画像のモノ 2 件');
  await panel.getByRole('button', { name: 'すべて継続' }).click();
  await expect(panel.locator('.obs-carry')).toHaveText('');
  await expect(panel.getByRole('tab', { name: /この画像/ })).toContainText('2');

  // The last image: one has gone, the other is under way (a click on its mark, 2 = 航行, Enter).
  await panel.getByRole('button', { name: '次の画像' }).click();
  await panel.getByRole('button', { name: '次の画像' }).click();
  await expect(panel.locator('select[name=image]')).toHaveValue('2');
  await panel.locator('.obs-ghost', { hasText: '船舶-1' }).getByRole('button', { name: '不在' }).click();
  await expect(panel.locator('.obs-ghost')).toHaveCount(1);
  await panel.locator('.obs-ghost', { hasText: 'タンカーA' }).click();
  await expect(form.getByRole('button', { name: '継続（Enter）' })).toBeFocused();
  await page.keyboard.press('2');
  await expect(form.locator('input[name=activity]')).toHaveValue('航行');
  await page.keyboard.press('Enter');
  await expect(panel.locator('.service-status')).toContainText('タンカーA（航行）を記録');

  // The flows, in image-time order.
  await expect
    .poll(() => flows(page))
    .toEqual([
      { name: 'タンカーA', images: ['site_20261001.tif', 'site_20261003.tif', 'site_20261005.tif'], steps: ['停泊', '航行'] },
      { name: '船舶-1', images: ['site_20261001.tif', 'site_20261003.tif', 'site_20261005.tif'], steps: ['停泊', 'いない'] },
    ]);
  await panel.getByRole('tab', { name: /モノ/ }).click();
  await panel.locator('.obs-list tbody tr', { hasText: 'タンカーA' }).click();
  const flow = panel.locator('.obs-flow');
  await expect(flow.locator('h3')).toContainText('タンカーA（船舶・OBJ-');
  await expect(flow.locator('.obs-summary')).toContainText('3 画像で確認・移動 0 m・最新: 航行');
  await expect(flow.locator('.obs-steps tbody tr')).toHaveCount(2);
  await expect(flow.locator('.obs-strip rect.obs-step')).toHaveCount(2);

  // Renamed in all its records.
  await flow.locator('summary').click();
  await flow.locator('input[name=rename]').fill('タンカー「あさひ」');
  await flow.getByRole('button', { name: '名前・種別の変更' }).click();
  await expect(flow.locator('h3')).toContainText('タンカー「あさひ」');

  // Kept in the browser.
  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.evaluate(() => window.viewer.observations.reload());
  expect((await flows(page)).map((f) => [f.name, f.images.length])).toEqual([
    ['タンカー「あさひ」', 3],
    ['船舶-1', 3],
  ]);
  expect(errors).toEqual([]);
});

test('a record is moved, deleted (kept marked), brought back, and written as CSV', async ({ page }) => {
  await openImages(page);
  const panel = await openPanel(page);
  const map = page.locator('#map');
  const box = (await map.boundingBox())!;
  await map.click({ position: { x: box.width / 4, y: box.height / 2 } });
  await panel.locator('.obs-form input[name=object]').fill('倉庫');
  await panel.locator('.obs-form input[name=kind]').fill('建物');
  await panel.locator('.obs-form input[name=object]').press('Enter');
  await expect(panel.locator('.service-status')).toContainText('倉庫を記録');
  const before = await page.evaluate(() => window.viewer.observations.records()[0]);

  // Dragged to where it really is.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.mouse.move(box.x + box.width / 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 4 + 40, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(panel.locator('.service-status')).toContainText('倉庫 の位置を修正');
  const moved = await page.evaluate(() => window.viewer.observations.records()[0]);
  expect(moved.lon).toBeGreaterThan(before.lon);
  expect(moved.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  expect(moved.createdAt).toBe(before.createdAt);

  // Deleted from its row's form: kept, marked, and shown again on request.
  await panel.locator('.obs-list tbody tr').first().click();
  await panel.locator('.obs-form').getByRole('button', { name: '削除' }).click();
  await expect(panel.locator('.service-status')).toContainText('1 件の記録を削除');
  expect(await page.evaluate(() => window.viewer.observations.records()[0].deletedAt)).toBeGreaterThan(0);
  await expect(panel.locator('.obs-list tbody')).toContainText('記録なし');
  await panel.locator('.catalog-more > summary').first().click();
  await panel.locator('input[name=deleted]').check();
  await panel.locator('.obs-deleted').getByRole('button', { name: '復元' }).click();
  await expect(panel.locator('.service-status')).toContainText('1 件の記録を復元');
  expect(await page.evaluate(() => window.viewer.observations.records()[0].deletedAt)).toBeNull();

  const download = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'CSV 保存' }).click();
  const csv = await (await download).createReadStream().then(async (stream) => {
    let text = '';
    for await (const chunk of stream) text += chunk;
    return text;
  });
  expect(csv).toContain('観測ID,モノID,モノ,種別,分類1,活動,有無,撮像日時');
  expect(csv).toContain(',倉庫,建物,建物,');

  // A layer of the records, for the table, the timeline and export.
  await panel.getByRole('button', { name: 'レイヤー化' }).click();
  await expect(page.locator('#images .name')).toContainText(['観測記録']);
});

test('observations are kept in an Esri point layer when config.json names one', async ({ page }) => {
  const url = 'https://gis.example.com/arcgis/rest/services/Obs/FeatureServer/0';
  const rows: Array<{ attributes: Record<string, unknown>; geometry: { x: number; y: number } }> = [];
  const names = ['OBS_ID', 'IMAGE_ID', 'IMAGE_NAME', 'IMAGE_TIME', 'OBJECT_ID', 'OBJECT_NAME', 'KIND', 'ACTIVITY', 'PRESENT', 'NOTE', 'CREATED_AT', 'UPDATED_AT', 'DELETED_AT'];
  const types: Record<string, string> = { OBJECTID: 'esriFieldTypeOID', IMAGE_TIME: 'esriFieldTypeDate', CREATED_AT: 'esriFieldTypeDate', UPDATED_AT: 'esriFieldTypeDate', DELETED_AT: 'esriFieldTypeDate', PRESENT: 'esriFieldTypeSmallInteger' };
  await page.route(`${url}**`, (route) => {
    const request = route.request();
    const target = request.url().split('?')[0];
    const params = Object.fromEntries(new URLSearchParams(request.postData() ?? request.url().split('?')[1] ?? ''));
    let body: unknown;
    if (target === url) body = { objectIdField: 'OBJECTID', geometryType: 'esriGeometryPoint', fields: ['OBJECTID', ...names].map((name) => ({ name, type: types[name] ?? 'esriFieldTypeString' })) };
    else if (target.endsWith('/applyEdits')) {
      const adds = JSON.parse(params.adds ?? '[]') as typeof rows;
      const updates = JSON.parse(params.updates ?? '[]') as typeof rows;
      body = {
        addResults: adds.map((f) => {
          const objectId = rows.length + 1;
          rows.push({ attributes: { ...f.attributes, OBJECTID: objectId }, geometry: f.geometry });
          return { success: true, objectId };
        }),
        updateResults: updates.map((u) => {
          const row = rows.find((r) => r.attributes.OBJECTID === u.attributes.OBJECTID)!;
          Object.assign(row.attributes, u.attributes);
          return { success: true };
        }),
      };
    } else body = { features: rows };
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ observationStores: [{ label: '観測DB', url, activities: ['入港', '出港'] }] }) }));
  await openImages(page);
  const panel = await openPanel(page);
  await expect(panel.locator('select[name=store] option')).toHaveText(['観測DB', 'このブラウザ']);
  await expect(panel.locator('.service-status')).toContainText('観測DB: 0 件の記録');
  const map = page.locator('#map');
  const box = (await map.boundingBox())!;
  await map.click({ position: { x: box.width / 4, y: box.height / 2 } });
  // The store's own activities come first.
  await expect(panel.locator('.obs-chips button').first()).toHaveText('1 入港');
  await panel.locator('.obs-form input[name=object]').fill('貨物船');
  await page.keyboard.press('Tab');
  await panel.locator('.obs-chips button').first().click();
  await panel.locator('.obs-form').getByRole('button', { name: '記録（Enter）' }).click();
  await expect.poll(() => rows.length).toBe(1);
  expect(rows[0].attributes).toMatchObject({ OBJECT_NAME: '貨物船', ACTIVITY: '入港', PRESENT: 1, IMAGE_NAME: expect.stringMatching(/^site_2026100\d\.tif$/) });
  expect(typeof rows[0].attributes.IMAGE_TIME).toBe('number');
  expect(rows[0].attributes.DELETED_AT).toBeNull();
  // Deleting marks it in the layer.
  await panel.locator('.obs-list tbody tr').first().click();
  await panel.locator('.obs-form').getByRole('button', { name: '削除' }).click();
  await expect.poll(() => typeof rows[0].attributes.DELETED_AT).toBe('number');
  expect(rows).toHaveLength(1);
});

test('the panel opens in the bottom dock until it is put in a window, and comes back with the layout reset', async ({ page }) => {
  await openImages(page);
  const panel = await openPanel(page);
  await expect(page.locator('.dock-bottom .obs-dialog')).toBeVisible();
  // Recording at the left, the lists at the right.
  const main = (await panel.locator('.obs-main').boundingBox())!;
  const side = (await panel.locator('.obs-side').boundingBox())!;
  expect(side.x).toBeGreaterThan(main.x + main.width - 1);

  // Put in a window: it stays one, also after closing and opening again and a reload.
  await panel.locator('.dock-button').click();
  await page.getByRole('menuitem', { name: 'ウィンドウに復帰' }).click();
  await expect(page.locator('.dock-bottom .obs-dialog')).toHaveCount(0);
  await panel.locator('.catalog-close').click();
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#observe-open').click();
  await expect(panel).toBeVisible();
  await expect(page.locator('.dock-bottom .obs-dialog')).toHaveCount(0);
  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#observe-open').click();
  await expect(page.locator('.obs-dialog')).toBeVisible();
  await expect(page.locator('.dock-bottom .obs-dialog')).toHaveCount(0);

  // 「レイアウトの初期化」: at home again.
  await page.locator('.obs-dialog .catalog-close').click();
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#layout-reset').click();
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#observe-open').click();
  await expect(page.locator('.dock-bottom .obs-dialog')).toBeVisible();
});

test('kinds are chosen down a classification whose branches name their own levels, and follow its changes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openImages(page);
  const panel = await openPanel(page);
  // A class added several levels at once, and a known individual of it.
  await panel.getByRole('tab', { name: /分類/ }).click();
  await panel.locator('input[name=taxon-root]').fill('船舶 > 支援船 > 〇〇級');
  await panel.getByRole('button', { name: '追加', exact: true }).last().click();
  await expect(panel.locator('.service-status')).toContainText('分類「船舶 > 支援船 > 〇〇級」を追加');
  await expect(panel.locator('.obs-taxon h3')).toContainText('船舶 > 支援船 > 〇〇級（級');
  await panel.locator('input[name=taxon-members]').fill('△△、□□');
  await panel.locator('.obs-taxon').getByRole('button', { name: '変更', exact: true }).click();
  await expect(panel.locator('.service-status')).toContainText('分類「船舶 > 支援船 > 〇〇級」を変更');
  await expect(panel.locator('.obs-list tbody tr', { hasText: '支援船' })).toContainText('種別');

  // Recording: down the levels with chips, then the individual by name.
  const map = page.locator('#map');
  const box = (await map.boundingBox())!;
  await map.click({ position: { x: box.width / 4, y: box.height / 2 } });
  const form = panel.locator('.obs-form');
  const path = form.locator('.obs-kind-path');
  await expect(form.locator('input[name=kind]')).toHaveValue('船舶');
  await expect(form.locator('.obs-object-label')).toHaveText('モノ（船名）');
  await expect(path).toContainText('種別:');
  await path.getByRole('button', { name: '支援船' }).click();
  await expect(path).toContainText('級:');
  await path.getByRole('button', { name: '〇〇級' }).click();
  await expect(form.locator('input[name=kind]')).toHaveValue('船舶 > 支援船 > 〇〇級');
  await path.getByRole('button', { name: '△△' }).click();
  await expect(form.locator('input[name=object]')).toHaveValue('△△');
  await form.locator('input[name=object]').press('Enter');
  await expect(panel.locator('.service-status')).toContainText('△△');
  // Typing a known individual's name brings its class.
  await map.click({ position: { x: box.width / 4 + 30, y: box.height / 2 + 20 } });
  await form.locator('input[name=kind]').fill('航空機');
  await form.locator('input[name=object]').fill('□□');
  await form.locator('input[name=object]').dispatchEvent('change');
  await expect(form.locator('input[name=kind]')).toHaveValue('船舶 > 支援船 > 〇〇級');
  await form.locator('input[name=object]').press('Enter');
  await expect.poll(() => page.evaluate(() => window.viewer.observations.records().map((o) => o.kind))).toEqual(['船舶 > 支援船 > 〇〇級', '船舶 > 支援船 > 〇〇級']);

  // Renaming a class rewrites the records below it.
  await panel.getByRole('tab', { name: /分類/ }).click();
  await panel.locator('.obs-list tbody tr', { hasText: '支援船' }).click();
  await panel.locator('input[name=taxon-name]').fill('補助艦');
  await panel.locator('.obs-taxon').getByRole('button', { name: '変更', exact: true }).click();
  await expect(panel.locator('.service-status')).toContainText('「船舶 > 補助艦」に変更（記録 2 件）');
  expect(await page.evaluate(() => window.viewer.observations.records().map((o) => o.kind))).toEqual(['船舶 > 補助艦 > 〇〇級', '船舶 > 補助艦 > 〇〇級']);
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('image-viewer.obs-taxonomy:このブラウザ') ?? '[]') as Array<{ path: string[] }>);
  expect(kept.map((t) => t.path.join(' > '))).toContain('船舶 > 補助艦 > 〇〇級');

  // A class limits the list of things to it and below.
  await panel.locator('.obs-list tbody tr', { hasText: '補助艦' }).dblclick();
  await expect(panel.getByRole('tab', { name: /モノ/ })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.locator('.obs-class-filter')).toContainText('分類: 船舶 > 補助艦 以下');
  await expect(panel.locator('.obs-list tbody tr')).toHaveCount(2);
  await panel.getByRole('button', { name: '分類の絞り込み解除' }).click();
  await expect(panel.locator('.obs-class-filter')).toBeHidden();
  expect(errors).toEqual([]);
});
