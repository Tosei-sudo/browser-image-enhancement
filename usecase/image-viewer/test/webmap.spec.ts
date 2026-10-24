import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/*
 * ArcGIS Web Maps, against the stand-in portal of test/portal.mjs: a web map
 * item opened by its item page (a feature layer of the stand-in Esri
 * service with a definition expression and its own renderer, a feature
 * collection, a web tiled base map, an unsupported layer, the extent and a
 * bookmark); a secured item with a token; saved as JSON and to the portal.
 */

const base = 'http://localhost:4175';
const WEBMAP_ID = '0123456789abcdef0123456789abcdef';
const SECURE_ID = 'fedcba9876543210fedcba9876543210';

async function open(page: Page) {
  await page.request.get(`${base}/svc/reset`);
  await page.request.get(`${base}/svc/portal/reset`);
  await page.route(/cyberjapandata\.gsi\.go\.jp|tile\.openstreetmap\.org/, (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

async function menu(page: Page, item: string) {
  await page.getByRole('button', { name: 'プロジェクト' }).click();
  await page.getByRole('button', { name: item }).click();
}

test('a web map opens as layers in its order, styles, view and bookmarks; what cannot be shown is listed', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await menu(page, 'ArcGIS Web マップを開く…');
  const dialog = page.getByRole('dialog', { name: 'ArcGIS Web マップを開く' });
  await dialog.getByRole('textbox', { name: 'Web マップのアイテム' }).fill(`${base}/svc/portal/home/item.html?id=${WEBMAP_ID}`);
  await dialog.getByRole('button', { name: '開く', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Web マップ「東京の公園」の 3 レイヤーを表示（1 レイヤーは読み込み失敗）');
  await expect(dialog.locator('.webmap-result')).toContainText('読み込み失敗: KML の層 — KML レイヤーには非対応');
  await expect(dialog.locator('.webmap-result')).toContainText('背景地図「テストの背景」はレイヤーとして下に追加');
  await expect(dialog.locator('.webmap-result')).toContainText('ブックマーク 1 件を追加');
  await dialog.getByRole('button', { name: '閉じる' }).click();

  await expect(page.locator('#images .name')).toHaveText(['一時メモ', 'EsriWeb マップの公園', 'Web マップ背景: テストのタイル']);
  const state = await page.evaluate(() => {
    const layers = window.viewer.images.layers();
    const parks = layers.find((l) => l.name === 'Web マップの公園')!;
    const memo = layers.find((l) => l.name === 'メモ')!;
    const p = parks.type === 'service' ? parks.service : null;
    const m = memo.type === 'service' ? memo.service : null;
    const view = window.viewer.map.getView();
    return {
      parks: p?.vector?.source.getFeatures().map((f) => f.get('KIND')),
      ref: p?.ref,
      opacity: parks.layer.getOpacity(),
      style: p?.style?.get(),
      memo: m?.vector?.source.getFeatures().map((f) => f.get('TEXT')),
      memoStyle: m?.style?.get().symbol.fill,
      center: view.getCenter(),
      basemap: window.viewer.baseMap.get(),
      bookmarks: window.viewer.bookmarks.get().map((b) => b.name),
    };
  });
  // The definition expression: only KIND = 1.
  expect(state.parks).toEqual([1, 1, 1, 1]);
  expect(state.ref).toMatchObject({ kind: 'esri', layer: '0', settings: { where: 'KIND = 1' } });
  expect(state.opacity).toBe(0.8);
  // The web map's renderer, as the viewer's style, with its labels.
  expect(state.style).toMatchObject({ mode: 'single', symbol: { fill: '#c800c8', shape: 'diamond', size: 16 }, label: { field: 'NAME' } });
  expect(state.memo).toEqual(['東京駅']);
  expect(state.memoStyle).toBe('#ff8c00');
  expect(state.center![0]).toBeCloseTo(15557500, -2);
  expect(state.basemap).toBe('');
  expect(state.bookmarks).toContain('皇居の周り');
  expect(errors).toEqual([]);
});

test('a secured web map needs its token', async ({ page }) => {
  await open(page);
  await menu(page, 'ArcGIS Web マップを開く…');
  const dialog = page.getByRole('dialog', { name: 'ArcGIS Web マップを開く' });
  await dialog.getByRole('textbox', { name: 'Web マップのアイテム' }).fill(SECURE_ID);
  await dialog.getByText('詳細（ポータル・トークン・ファイル）').click();
  await dialog.getByRole('textbox', { name: 'ポータルの URL' }).fill(`${base}/svc/portal`);
  await dialog.getByRole('button', { name: '開く', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('読み込み失敗: このサービスにはトークンが必要');
  await dialog.getByLabel('ポータルのトークン').fill('secret');
  await dialog.getByRole('button', { name: '開く', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Web マップ「非公開の地図」の 3 レイヤーを表示');
});

test('what is open saves as a web map: a JSON file, a new portal item after asking, and over it', async ({ page }) => {
  await open(page);
  await menu(page, 'ArcGIS Web マップを開く…');
  const openDialog = page.getByRole('dialog', { name: 'ArcGIS Web マップを開く' });
  await openDialog.getByRole('textbox', { name: 'Web マップのアイテム' }).fill(`${base}/svc/portal/apps/mapviewer/index.html?webmap=${WEBMAP_ID}`);
  await openDialog.getByRole('button', { name: '開く', exact: true }).click();
  await expect(openDialog.getByRole('status')).toContainText('3 レイヤーを表示');
  await openDialog.getByRole('button', { name: '閉じる' }).click();
  // Hide the collection: saved hidden.
  await page.locator('#images li', { hasText: 'メモ' }).locator('input[type=checkbox]').first().uncheck();

  await menu(page, 'ArcGIS Web マップとして保存…');
  const dialog = page.getByRole('dialog', { name: 'ArcGIS Web マップとして保存' });
  await expect(dialog.getByRole('textbox', { name: 'Web マップのタイトル' })).toHaveValue('東京の公園');
  await expect(dialog.locator('.webmap-summary')).toHaveText('2 レイヤーを書き込み: Web マップの公園、メモ');
  await dialog.getByRole('textbox', { name: 'Web マップのタイトル' }).fill('Tokyo parks');
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'JSON をダウンロード' }).click()]);
  expect(download.suggestedFilename()).toBe('Tokyo parks.json');
  await dialog.getByRole('textbox', { name: 'Web マップのタイトル' }).fill('東京の公園');
  const json = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(json.version).toMatch(/^2\./);
  const [parks, memo] = json.operationalLayers;
  expect(parks).toMatchObject({ layerType: 'ArcGISFeatureLayer', url: `${base}/svc/arcgis/rest/services/Test/FeatureServer/0`, opacity: 0.8, visibility: true, layerDefinition: { definitionExpression: 'KIND = 1' } });
  expect(parks.layerDefinition.drawingInfo.renderer).toMatchObject({ type: 'simple', symbol: { type: 'esriSMS', style: 'esriSMSDiamond', color: [200, 0, 200, 255] } });
  expect(memo).toMatchObject({ title: 'メモ', visibility: false });
  expect(memo.featureCollection.layers[0].featureSet.features[0].attributes.TEXT).toBe('東京駅');
  // The base map came as a layer, and goes back as the base map.
  expect(json.baseMap.baseMapLayers[0]).toMatchObject({ layerType: 'WebTiledLayer', title: 'テストのタイル' });
  expect(json.initialState.viewpoint.targetGeometry.spatialReference.wkid).toBe(102100);
  expect(json.bookmarks.map((b: { name: string }) => b.name)).toContain('皇居の周り');

  // To the portal: asked first, then written to the folder.
  await dialog.getByText('ポータルに保存', { exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '保存先のポータル' })).toHaveValue(`${base}/svc/portal`);
  await dialog.getByLabel('保存先のトークン').fill('secret');
  await dialog.getByRole('textbox', { name: 'フォルダー' }).fill('地図');
  await dialog.getByRole('textbox', { name: 'タグ' }).fill('公園, テスト');
  await dialog.getByRole('button', { name: 'ポータルに保存…' }).click();
  const ask = page.locator('dialog.folder-ask');
  await expect(ask).toContainText('ユーザー tester のフォルダー「地図」 に、Web マップ「東京の公園」を新規作成（2 レイヤー）');
  // Nothing is written before the answer.
  expect(await (await page.request.get(`${base}/svc/portal/saved`)).json()).toEqual([]);
  await ask.getByRole('button', { name: '作成' }).click();
  await expect(dialog.getByRole('status')).toContainText('保存完了（アイテム aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1）');
  let saved = await (await page.request.get(`${base}/svc/portal/saved`)).json();
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ op: 'addItem', folder: 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0', type: 'Web Map', title: '東京の公園', tags: '公園, テスト' });
  expect(JSON.parse(saved[0].text).operationalLayers).toHaveLength(2);
  expect(saved[0].extent.split(',')).toHaveLength(4);

  // Again, over the item just made.
  await dialog.getByRole('textbox', { name: 'Web マップのタイトル' }).fill('東京の公園（改）');
  await dialog.getByText('開いた Web マップ（aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1）に上書き').click();
  await dialog.getByRole('button', { name: 'ポータルに保存…' }).click();
  await page.locator('dialog.folder-ask').getByRole('button', { name: '上書き' }).click();
  await expect(dialog.getByRole('status')).toContainText('上書き保存');
  saved = await (await page.request.get(`${base}/svc/portal/saved`)).json();
  expect(saved[1]).toMatchObject({ op: 'update', id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', title: '東京の公園（改）' });
});
