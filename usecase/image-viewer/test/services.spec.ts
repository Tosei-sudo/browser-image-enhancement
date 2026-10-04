import { expect, test, type Page } from '@playwright/test';

/*
 * Service layers, against the stand-in services of test/services.mjs: WMS
 * (with GetFeatureInfo), WMTS, WFS and an editable Esri feature service; the
 * attribute table; editing and saving; tokens; base maps; `?service=` links.
 */

const base = 'http://localhost:4175';

async function open(page: Page, query = '') {
  await page.request.get(`${base}/svc/reset`);
  // Base map tiles come from the internet: answer them locally.
  await page.route(/cyberjapandata\.gsi\.go\.jp|tile\.openstreetmap\.org/, (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto(`/index.html${query}`);
  await page.waitForFunction(() => window.viewer !== undefined);
}

/** Adds layers of a service through the dialog, as a person would. */
async function addService(page: Page, url: string, options: { kind?: string; token?: string; expectLayers?: number } = {}) {
  await page.getByRole('button', { name: 'サービスを追加' }).click();
  const dialog = page.getByRole('dialog', { name: 'サービスを追加' });
  await dialog.getByRole('textbox', { name: 'サービスの URL' }).fill(url);
  if (options.kind) await dialog.getByRole('combobox', { name: 'サービスの種類' }).selectOption(options.kind);
  if (options.token) await dialog.getByLabel('トークン').fill(options.token);
  await dialog.getByRole('button', { name: '読み込む' }).click();
  await expect(dialog.locator('.service-layer')).toHaveCount(options.expectLayers ?? 1);
  await dialog.locator('.service-layer input[type=checkbox]').first().check();
  await dialog.getByRole('button', { name: '追加', exact: true }).click();
  await expect(dialog).toBeHidden();
}

const rows = (page: Page) => page.locator('.attributes tbody tr[data-index]');
// Column 1 is the first field (after the check box).
const cellTexts = (page: Page, column: number) => rows(page).locator(`td:nth-child(${column + 1})`).allTextContents();

/** The pixel of a map coordinate (EPSG:3857), on the page. */
async function pixelOf(page: Page, lon: number, lat: number) {
  // A zoom to a new layer may still be animating: its pixels would move under the click.
  await page.waitForFunction(() => !window.viewer.map.getView().getAnimating());
  const [x, y] = await page.evaluate(
    ([lon, lat]) => {
      const { map } = window.viewer;
      const c = [(lon * 20037508.342789244) / 180, Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * 6378137];
      return map.getPixelFromCoordinate(c);
    },
    [lon, lat],
  );
  const box = (await page.locator('#map').boundingBox())!;
  return { x: box.x + x, y: box.y + y };
}

/** Waits until the view stops moving (zooming to a new layer animates) and the map has drawn. */
async function settle(page: Page) {
  await page.waitForFunction(() => !window.viewer.map.getView().getAnimating());
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

test('WMS: added from its capabilities, corrected like an image, and asked what is at a point', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await addService(page, `${base}/svc/wms`);
  await expect(page.locator('#images .name')).toHaveText(['WMS東京の地図']);
  await expect(page.locator('#info')).toContainText('test:tokyo');
  await expect(page.locator('#info')).toContainText('EPSG:3857');
  expect(page.url()).toContain('service=');

  // The correction panel drives the layer's correction (on the GPU when there is one).
  const onGpu = await page.evaluate(() => window.viewer.onGpu);
  if (onGpu) {
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('.ol-enhance-row')].find((r) => r.firstElementChild?.textContent === '露出 (EV)')!;
      const input = row.querySelector('input')!;
      input.value = '1';
      input.dispatchEvent(new Event('input'));
    });
    await expect
      .poll(() => page.evaluate(() => (window.viewer.images.layers()[0] as { service: { correction: { getPipeline(): { ops: unknown[] } } | null } }).service.correction?.getPipeline().ops))
      .toEqual([{ op: 'exposure', ev: 1 }]);

    // DRA takes its statistics from the drawn map (the tiles are one gray-blue: 90, 110, 130).
    await page.locator('fieldset', { hasText: 'DRA' }).getByLabel('オン').check();
    await settle(page);
    const dra = await page.evaluate(() => {
      const c = (window.viewer.images.layers()[0] as { service: { correction: import('browser-image-enhancement/openlayers').TileCorrection } }).service.correction;
      return { info: c.getDraInfo(), ops: c.getEffectivePipeline().ops.map((o) => o.op) };
    });
    expect(dra.info?.pixels).toBeGreaterThan(0);
    expect(dra.ops).toEqual(['stretch', 'exposure']);
  }

  // A click asks GetFeatureInfo; the answer shows in the table.
  await expect(page.locator('.table-empty')).toContainText('地図をクリックすると');
  const at = await pixelOf(page, 139.75, 35.675);
  await page.mouse.click(at.x, at.y);
  await expect(page.locator('#status')).toContainText('1 件の地物があります');
  expect(await cellTexts(page, 1)).toEqual(['東京駅']);
  expect(errors).toEqual([]);
});

test('WMTS: REST capabilities with the tile matrix set to choose', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'サービスを追加' }).click();
  const dialog = page.getByRole('dialog', { name: 'サービスを追加' });
  await dialog.getByRole('textbox', { name: 'サービスの URL' }).fill(`${base}/svc/wmts/WMTSCapabilities.xml`);
  await dialog.getByRole('button', { name: '読み込む' }).click();
  await expect(dialog.locator('.service-status')).toContainText('WMTS「テスト WMTS」');
  await expect(dialog.locator('select[name=matrixSet]')).toHaveValue('GoogleMapsCompatible');
  await expect(dialog.locator('input[type=checkbox]')).toBeChecked(); // the only layer
  await dialog.getByRole('button', { name: '追加', exact: true }).click();
  await expect(page.locator('#images .name')).toHaveText(['WMTS東京のタイル']);
  await expect(page.locator('#info')).toContainText('GoogleMapsCompatible');
  // Tiles load (CORS allowed, so the layer stays correctable).
  await settle(page);
  expect(await page.evaluate(() => (window.viewer.images.layers()[0] as { service: { correction: unknown } }).service.correction !== null)).toBe(await page.evaluate(() => window.viewer.onGpu));
});

test('WFS: every feature in the table, all or only the selected ones, sorted, searched, saved as CSV', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await addService(page, `${base}/svc/wfs`);
  await expect(page.locator('#images .name')).toHaveText(['WFS駅']);
  await expect(page.locator('.table-count')).toContainText('全 3 件・選択 0 件');
  await expect(page.locator('.attributes th:not(.check)')).toHaveText(['name', 'passengers']);
  expect(await cellTexts(page, 1)).toEqual(['東京', '新宿', '品川']);

  // Lat / lon from the server ended up in the right place.
  const tokyo = await page.evaluate(() => {
    const f = window.viewer.table.rows()[0];
    return (f.getGeometry() as import('ol/geom/Point.js').default).getCoordinates();
  });
  expect(tokyo[0]).toBeCloseTo(15558802, -2);
  expect(tokyo[1]).toBeCloseTo(4256843, -2);

  // Sort by passengers, descending on the second click.
  await page.locator('.attributes th button', { hasText: 'passengers' }).click();
  expect(await cellTexts(page, 1)).toEqual(['品川', '東京', '新宿']);
  await page.locator('.attributes th button', { hasText: 'passengers' }).click();
  expect(await cellTexts(page, 1)).toEqual(['新宿', '東京', '品川']);

  // Search.
  await page.getByRole('searchbox', { name: '属性を検索' }).fill('品');
  expect(await cellTexts(page, 1)).toEqual(['品川']);
  await page.getByRole('searchbox', { name: '属性を検索' }).fill('');

  // Selecting: a row, then a feature on the map; "selected only" shows just those.
  await rows(page).filter({ hasText: '東京' }).click();
  await expect(page.locator('.table-count')).toContainText('選択 1 件');
  await settle(page);
  const shinjuku = await pixelOf(page, 139.7006, 35.6896);
  await page.keyboard.down('Shift');
  await page.mouse.click(shinjuku.x, shinjuku.y);
  await page.keyboard.up('Shift');
  await expect(page.locator('.table-count')).toContainText('選択 2 件');
  await page.getByRole('button', { name: '選択中のみ' }).click();
  expect((await cellTexts(page, 1)).sort()).toEqual(['新宿', '東京']);
  await page.getByRole('button', { name: '全件' }).click();
  await expect(rows(page)).toHaveCount(3);

  // CSV of the rows shown.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV 保存' }).click();
  const file = await download;
  let text = '';
  for await (const chunk of await file.createReadStream()) text += chunk;
  expect(text.replace(/^\uFEFF/, '').split('\r\n')).toEqual(['name,passengers', '新宿,650602', '東京,462589', '品川,271340']);
  expect(errors).toEqual([]);
});

test('Esri: the service symbols and domains, edits in the table and on the map, saved with applyEdits', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await open(page);
  await addService(page, `${base}/svc/arcgis/rest/services/Test/FeatureServer`);
  await expect(page.locator('#images .name')).toHaveText(['Esri公園']);
  // Read in batches of maxRecordCount (2): all 5 arrive.
  await expect(page.locator('.table-count')).toContainText('全 5 件');
  await expect(page.locator('.attributes th:not(.check)')).toHaveText(['OBJECTID', '名称', '種別', '面積', '編集者']);
  expect(await cellTexts(page, 3)).toEqual(['公園', '公園', '公園', '広場', '公園']); // coded values by name
  await expect(page.locator('#info')).toContainText('追加・更新・削除');

  // Edit mode: editable cells become inputs; OBJECTID and the editor field stay read-only.
  await page.locator('#images li').getByRole('button', { name: '編集' }).click();
  await expect(page.getByRole('toolbar', { name: '編集' })).toBeVisible();
  const first = rows(page).first();
  await expect(first.locator('td:not(.check)').nth(0).locator('input')).toHaveCount(0);
  await expect(first.locator('td:not(.check)').nth(4).locator('input')).toHaveCount(0);

  // Change a name, then undo and change it again.
  const name = first.getByRole('textbox', { name: '名称' });
  await name.fill('日比谷');
  await name.press('Enter');
  await expect(page.getByRole('button', { name: '保存 (1)' })).toBeEnabled();
  await page.getByRole('button', { name: '元に戻す' }).click();
  await expect(rows(page).first().getByRole('textbox', { name: '名称' })).toHaveValue('日比谷公園');
  await rows(page).first().getByRole('textbox', { name: '名称' }).fill('日比谷');
  await rows(page).first().getByRole('textbox', { name: '名称' }).press('Enter');
  await rows(page).first().getByRole('combobox', { name: '種別' }).selectOption('2');
  // Out of the range domain: refused.
  await rows(page).first().getByRole('spinbutton', { name: '面積' }).fill('5000');
  await rows(page).first().getByRole('spinbutton', { name: '面積' }).press('Enter');
  await expect(page.locator('#status')).toContainText('0〜1000 の範囲');
  await expect(rows(page).first().locator('td.dirty')).toHaveCount(2);

  // Delete the 4th feature (selected in the table).
  await rows(page).nth(3).locator('td:not(.check)').first().click();
  await page.getByRole('button', { name: '削除' }).click();
  await expect(rows(page)).toHaveCount(4);

  // Add a feature on the map; it gets the template's KIND and its row is ready for input.
  await page.getByRole('button', { name: '追加', exact: true }).click();
  const at = await pixelOf(page, 139.74, 35.68);
  await page.mouse.click(at.x, at.y);
  await expect(page.getByRole('button', { name: '選択中のみ' })).toHaveAttribute('aria-pressed', 'true');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first().getByRole('combobox', { name: '種別' })).toHaveValue('1');
  await rows(page).first().getByRole('textbox', { name: '名称' }).fill('新しい公園');
  await rows(page).first().getByRole('textbox', { name: '名称' }).press('Enter');
  await page.getByRole('button', { name: '追加', exact: true }).click(); // stop adding

  await expect(page.getByRole('button', { name: '保存 (3)' })).toBeEnabled();
  await page.getByRole('button', { name: '保存 (3)' }).click();
  await expect(page.locator('#status')).toContainText('3 件の変更を保存しました');

  const state = (await (await page.request.get(`${base}/svc/state`)).json()) as Array<{ attributes: Record<string, unknown>; geometry: { x: number; y: number } }>;
  expect(state.map((f) => f.attributes.NAME)).toEqual(['日比谷', '上野恩賜公園', '新宿御苑', '代々木公園', '新しい公園']);
  expect(state[0].attributes).toMatchObject({ KIND: 2, EDITOR: 'server' });
  expect(state[4].attributes).toMatchObject({ OBJECTID: 6, KIND: 1 });
  expect(state[4].geometry.x).toBeCloseTo((139.74 * 20037508.342789244) / 180, -2);
  // Read back from the server: the editor field the server filled in.
  await page.getByRole('button', { name: '全件' }).click();
  expect(await rows(page).first().locator('td:not(.check)').nth(4).textContent()).toBe('server');

  // A feature the server refuses stays unsaved, marked, with the reason.
  await rows(page).nth(1).getByRole('textbox', { name: '名称' }).fill('NG');
  await rows(page).nth(1).getByRole('textbox', { name: '名称' }).press('Enter');
  await page.getByRole('button', { name: '保存 (1)' }).click();
  await expect(page.locator('#status')).toContainText('1 件は保存できませんでした（名前が不正です）');
  await expect(rows(page).nth(1)).toHaveClass(/failed/);
  await expect(page.getByRole('button', { name: '保存 (1)' })).toBeEnabled();

  // Ending the edit discards it (after asking).
  await page.getByRole('button', { name: '編集終了' }).click();
  await expect(page.getByRole('toolbar', { name: '編集' })).toBeHidden();
  await expect(rows(page).nth(1).locator('td:not(.check)').nth(1)).toHaveText('上野恩賜公園');
  expect(errors).toEqual([]);
});

test('table: several features selected with Ctrl, Shift, check boxes, Ctrl+A and a box on the map; the row menu', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page);
  await addService(page, `${base}/svc/wfs`);
  await expect(rows(page)).toHaveCount(3);
  const count = page.locator('.table-count');

  // Click, Ctrl click (adds, then takes out), Shift click (the rows in between).
  await rows(page).nth(0).click();
  await rows(page).nth(2).click({ modifiers: ['ControlOrMeta'] });
  await expect(count).toContainText('選択 2 件');
  await rows(page).nth(2).click({ modifiers: ['ControlOrMeta'] });
  await expect(count).toContainText('選択 1 件');
  // From the last row clicked (the third) up to the first.
  await rows(page).nth(0).click({ modifiers: ['Shift'] });
  await expect(count).toContainText('選択 3 件');
  await rows(page).nth(1).click();
  await expect(count).toContainText('選択 1 件');
  await expect(rows(page).nth(1)).toHaveAttribute('aria-selected', 'true');

  // Check boxes add and take out; the header one checks every row shown.
  await rows(page).nth(0).getByRole('checkbox', { name: '選択' }).check();
  await expect(count).toContainText('選択 2 件');
  const all = page.getByRole('checkbox', { name: '表示中の行をすべて選択' });
  expect(await all.evaluate((b: HTMLInputElement) => b.indeterminate)).toBe(true);
  await all.check();
  await expect(count).toContainText('選択 3 件');
  await expect(rows(page).getByRole('checkbox', { name: '選択' })).toHaveCount(3);
  for (const box of await rows(page).getByRole('checkbox', { name: '選択' }).all()) await expect(box).toBeChecked();
  await all.uncheck();
  await expect(count).toContainText('選択 0 件');

  // Keys: Ctrl+A selects the rows shown (only the search hits), Escape clears.
  await page.getByRole('searchbox', { name: '属性を検索' }).fill('川');
  await page.locator('.table-scroll').focus();
  await page.keyboard.press('ControlOrMeta+a');
  await expect(count).toContainText('選択 1 件');
  await page.getByRole('searchbox', { name: '属性を検索' }).fill('');
  await page.locator('.table-scroll').focus();
  await page.keyboard.press('ControlOrMeta+a');
  await expect(count).toContainText('選択 3 件');
  await page.keyboard.press('Escape');
  await expect(count).toContainText('選択 0 件');

  // Ctrl + drag on the map: the features in the box (Tokyo and Shinjuku, not Shinagawa) join the selection.
  await settle(page);
  const shinjuku = await pixelOf(page, 139.7006, 35.6896);
  const tokyo = await pixelOf(page, 139.7671, 35.6812);
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.move(shinjuku.x - 10, Math.min(shinjuku.y, tokyo.y) - 10);
  await page.mouse.down();
  await page.mouse.move((shinjuku.x + tokyo.x) / 2, tokyo.y, { steps: 4 });
  await page.mouse.move(tokyo.x + 10, Math.max(shinjuku.y, tokyo.y) + 10, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('ControlOrMeta');
  await expect(count).toContainText('選択 2 件');
  await page.getByRole('button', { name: '選択中のみ' }).click();
  expect((await cellTexts(page, 1)).sort()).toEqual(['新宿', '東京']);
  await page.getByRole('button', { name: '全件' }).click();

  // Right click on a selected row: the menu works on the whole selection; WFS cannot delete.
  const menu = page.getByRole('menu', { name: '選択した地物' });
  await rows(page).filter({ hasText: '新宿' }).click({ button: 'right' });
  await expect(menu.getByRole('menuitem')).toHaveText(['選択中の 2 件にズーム', '選択中の 2 件の行をコピー', '選択を解除']);
  await menu.getByRole('menuitem', { name: '選択中の 2 件の行をコピー' }).click();
  await expect(menu).toBeHidden();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.split('\n')).toEqual(['name\tpassengers', '東京\t462589', '新宿\t650602']);

  // On a row not selected: that row alone becomes the selection, and the menu zooms to it.
  await rows(page).filter({ hasText: '品川' }).click({ button: 'right' });
  await expect(count).toContainText('選択 1 件');
  const before = await page.evaluate(() => window.viewer.map.getView().getZoom());
  await menu.getByRole('menuitem', { name: '地物にズーム' }).click();
  await settle(page);
  const view = await page.evaluate(() => ({ zoom: window.viewer.map.getView().getZoom()!, center: window.viewer.map.getView().getCenter()! }));
  expect(view.zoom).toBeGreaterThan(before!);
  expect(view.center[0]).toBeCloseTo((139.7387 * 20037508.342789244) / 180, -1);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('Esri: the row menu deletes the selected features, starting editing; saved with the others', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const asked: string[] = [];
  page.on('dialog', (d) => {
    asked.push(d.message());
    void d.accept();
  });
  await open(page);
  await addService(page, `${base}/svc/arcgis/rest/services/Test/FeatureServer`);
  await expect(page.locator('.table-count')).toContainText('全 5 件');
  await rows(page).nth(1).click();
  await rows(page).nth(2).click({ modifiers: ['ControlOrMeta'] });
  await rows(page).nth(2).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '選択した地物' });
  await menu.getByRole('menuitem', { name: '選択中の 2 件を削除…' }).click();
  expect(asked).toEqual(['2 件の地物を削除しますか？（「保存」を押すまでサーバーからは消えません）']);
  await expect(page.getByRole('toolbar', { name: '編集' })).toBeVisible();
  await expect(rows(page)).toHaveCount(3);
  await expect(page.locator('.table-count')).toContainText('選択 0 件');
  await page.getByRole('button', { name: '保存 (2)' }).click();
  await expect(page.locator('#status')).toContainText('2 件の変更を保存しました');
  const state = (await (await page.request.get(`${base}/svc/state`)).json()) as Array<{ attributes: Record<string, unknown> }>;
  expect(state.map((f) => f.attributes.NAME)).toEqual(['日比谷公園', '駅前広場', '代々木公園']);

  // The Delete key does the same while the table has focus.
  await rows(page).nth(0).locator('td.check input').check();
  await page.keyboard.press('Delete');
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole('button', { name: '保存 (1)' })).toBeEnabled();
  expect(errors).toEqual([]);
});

test('Esri: a secured service asks for a token', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'サービスを追加' }).click();
  const dialog = page.getByRole('dialog', { name: 'サービスを追加' });
  await dialog.getByRole('textbox', { name: 'サービスの URL' }).fill(`${base}/svc/arcgis/rest/services/Secure/FeatureServer/0`);
  await dialog.getByRole('button', { name: '読み込む' }).click();
  await expect(dialog.locator('.service-status')).toContainText('トークンが必要です');
  await dialog.getByLabel('トークン').fill('wrong');
  await dialog.getByRole('button', { name: '読み込む' }).click();
  await expect(dialog.locator('.service-status')).toContainText('トークンが無効か');
  await dialog.getByLabel('トークン').fill('secret');
  await dialog.getByRole('button', { name: '読み込む' }).click();
  await expect(dialog.locator('.service-layer')).toHaveCount(1);
  await dialog.getByRole('button', { name: '追加', exact: true }).click();
  await expect(page.locator('.table-count')).toContainText('全 5 件');
});

test('base map switch, and ?service= / ?base= links reopen the view', async ({ page }) => {
  await open(page);
  await page.getByRole('combobox', { name: '背景地図' }).selectOption('gsi-pale');
  expect(await page.evaluate(() => window.viewer.map.getLayers().getArray().some((l) => l.getZIndex() === -1))).toBe(true);
  await addService(page, `${base}/svc/wfs`);
  const link = new URL(page.url());
  expect(link.searchParams.get('base')).toBe('gsi-pale');

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page, link.search);
  await expect(page.locator('#images .name')).toHaveText(['WFS駅']);
  await expect(page.getByRole('combobox', { name: '背景地図' })).toHaveValue('gsi-pale');
  await page.getByRole('combobox', { name: '背景地図' }).selectOption('');
  expect(await page.evaluate(() => window.viewer.map.getLayers().getArray().some((l) => l.getZIndex() === -1))).toBe(false);
  expect(errors).toEqual([]);
});

test('Esri: a feature moved on the map is saved with its new geometry', async ({ page }) => {
  await open(page);
  await addService(page, `${base}/svc/arcgis/rest/services/Test/FeatureServer`);
  await expect(page.locator('.table-count')).toContainText('全 5 件');
  await page.locator('#images li').getByRole('button', { name: '編集' }).click();
  await settle(page);
  const from = await pixelOf(page, 139.7101, 35.6852); // 新宿御苑
  await page.mouse.click(from.x, from.y);
  await expect(page.locator('.table-count')).toContainText('選択 1 件');
  await page.getByRole('button', { name: '形状編集' }).click();
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 10, { steps: 5 });
  await page.mouse.move(from.x + 40, from.y + 20, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: '保存 (1)' })).toBeEnabled();
  await page.getByRole('button', { name: '保存 (1)' }).click();
  await expect(page.locator('#status')).toContainText('1 件の変更を保存しました');
  const state = (await (await page.request.get(`${base}/svc/state`)).json()) as Array<{ attributes: Record<string, unknown>; geometry: { x: number; y: number } }>;
  const moved = state.find((f) => f.attributes.NAME === '新宿御苑')!;
  expect(moved.geometry.x).toBeGreaterThan((139.7101 * 20037508.342789244) / 180 + 1);
  expect(moved.attributes.EDITOR).toBe('server');
});
