import { expect, test, type Page } from '@playwright/test';

/*
 * The clipboard: GeoJSON, WKT and tables from Excel pasted (Ctrl+V or the
 * menu) become the temporary layer 「貼り付け」; a URL is only opened when the
 * person says so; selected features copy as GeoJSON (row menu, Ctrl+C on the
 * map) and WKT; the view copies as a PNG; a pasted picture opens.
 */

const rows = (page: Page) => page.locator('.attributes tbody tr[data-index]');
const status = (page: Page) => page.locator('#status');

async function open(page: Page): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

const write = (page: Page, text: string) => page.evaluate((t) => navigator.clipboard.writeText(t), text);
const read = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

/** Ctrl+V with nothing focused (the map). */
async function pasteOnMap(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+V');
}

/** 「クリップボードから貼り付け」 in the ツール menu. */
async function pasteFromMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.getByRole('button', { name: 'クリップボードから貼り付け' }).click();
}

const pastedLayers = (page: Page) =>
  page.evaluate(() =>
    window.viewer.images
      .layers()
      .filter((l) => l.type === 'service' && l.service.title === '貼り付け')
      .map((l) => (l.type === 'service' ? l.service.vector!.source.getFeatures().length : 0)),
  );

test('GeoJSON pasted with Ctrl+V on the map becomes the temporary layer 「貼り付け」, zoomed to', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  const fc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { name: '<img src=x onerror=alert(1)>東京', n: 1 }, geometry: { type: 'Point', coordinates: [139.7671, 35.6812] } },
      { type: 'Feature', properties: { name: '区域', n: 2 }, geometry: { type: 'Polygon', coordinates: [[[139.7, 35.6], [139.8, 35.6], [139.8, 35.7], [139.7, 35.6]]] } },
    ],
  };
  await write(page, JSON.stringify(fc, null, 2));
  await pasteOnMap(page);
  await expect(status(page)).toContainText('GeoJSONとして読み、図形 2 個を一時レイヤー「貼り付け」に追加しました');
  await expect(page.locator('.clip-toast')).toBeVisible();
  await expect(page.locator('#images li', { hasText: '貼り付け' })).toHaveCount(1);
  expect(await pastedLayers(page)).toEqual([2]);
  await page.waitForFunction(() => !window.viewer.map.getView().getAnimating());
  const lon = await page.evaluate(() => (window.viewer.map.getView().getCenter()![0] / 20037508.34) * 180);
  expect(lon).toBeGreaterThan(139.6);
  expect(lon).toBeLessThan(139.9);
  // Labels are text.
  await page.locator('#images li', { hasText: '貼り付け' }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).first()).toContainText('<img src=x onerror=alert(1)>東京');
  await page.screenshot({ path: '/mnt/project-files/integrations/clipboard-paste-geojson.png' }).catch(() => {});

  // Ctrl+V in a text field is the field's own.
  await write(page, 'POINT(139 35)');
  await page.locator('#jump input').focus();
  await page.keyboard.press('ControlOrMeta+V');
  await expect(page.locator('#jump input')).toHaveValue('POINT(139 35)');
  expect(await pastedLayers(page)).toEqual([2]);
  expect(errors).toEqual([]);
});

test('WKT and a table from Excel paste from the menu; rows copy as GeoJSON and WKT, Ctrl+C copies the selection', async ({ page }) => {
  await open(page);
  await write(page, 'LINESTRING(139.70 35.60, 139.80 35.70)\nPOINT(139.75 35.65)');
  await pasteFromMenu(page);
  await expect(status(page)).toContainText('WKTとして読み、図形 2 個');

  // Copied from Excel: tab-separated, latitude and longitude columns, an empty row.
  await write(page, '名前\t緯度\t経度\r\n東京駅\t35.6812\t139.7671\r\n大阪駅\t34.7025\t135.4959\r\n\t\t\r\n');
  await pasteOnMap(page);
  await expect(status(page)).toContainText('表（緯度「緯度」・経度「経度」）として読み、図形 2 個');
  expect(await pastedLayers(page)).toEqual([2, 2]);

  // The table's layer is the selected one (the last added): its rows' menu copies GeoJSON in WGS 84.
  await page.locator('#images li', { hasText: '貼り付け' }).first().click();
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).first()).toContainText('東京駅');
  await rows(page).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'GeoJSON でコピー' }).click();
  await expect(status(page)).toContainText('地物 1 件を GeoJSON でコピーしました');
  const copied = JSON.parse(await read(page));
  expect(copied.type).toBe('FeatureCollection');
  expect(copied.features[0].geometry).toEqual({ type: 'Point', coordinates: [139.7671, 35.6812] });
  expect(copied.features[0].properties.名前).toBe('東京駅');

  await rows(page).nth(1).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'WKT でコピー' }).click();
  expect(await read(page)).toBe('POINT(135.4959 34.7025)');

  // Ctrl+C on the map with both selected: GeoJSON of the two.
  await page.evaluate(() => {
    const layer = window.viewer.images.selectedLayer();
    if (layer?.type === 'service') window.viewer.selection.set(layer.service.vector!.source.getFeatures());
  });
  await write(page, '');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+C');
  await expect(status(page)).toContainText('選択した地物 2 件を GeoJSON でコピーしました');
  expect(JSON.parse(await read(page)).features).toHaveLength(2);
});

test('X / Y columns ask their CRS; a URL is opened only when asked; nonsense says so', async ({ page }) => {
  await open(page);
  await write(page, 'X\tY\tid\n15558338\t4256426\t1\n15559338\t4257426\t2');
  await pasteOnMap(page);
  const dialog = page.locator('dialog.paste-columns');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('X の列')).toHaveValue('X');
  await dialog.getByLabel('値の座標系').selectOption({ label: 'Web メルカトル' });
  await dialog.getByRole('button', { name: '追加' }).click();
  await expect(status(page)).toContainText('図形 2 個を一時レイヤー「貼り付け」');
  const first = await page.evaluate(() => {
    const layer = window.viewer.images.layers().find((l) => l.type === 'service' && l.service.title === '貼り付け');
    return layer?.type === 'service' ? (layer.service.vector!.source.getFeatures()[0].getGeometry() as import('ol/geom/Point.js').default).getCoordinates() : null;
  });
  expect(first?.map(Math.round)).toEqual([15558338, 4256426]);

  // A URL: asked, and nothing is fetched when the person says no.
  const fetched: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('pasted-cog.tif')) fetched.push(r.url());
  });
  await write(page, 'http://localhost:4175/pasted-cog.tif');
  await pasteOnMap(page);
  const ask = page.locator('dialog.folder-ask');
  await expect(ask).toContainText('http://localhost:4175/pasted-cog.tif');
  await ask.getByRole('button', { name: 'キャンセル' }).click();
  await expect(status(page)).toContainText('URL は開きませんでした');
  expect(fetched).toEqual([]);

  await write(page, 'これは図形ではありません');
  await pasteOnMap(page);
  await expect(page.locator('.clip-toast')).toContainText('図形として読める内容がありません');
});

test('the view copies as a PNG, and a pasted picture opens without a projection', async ({ page }) => {
  await open(page);
  await write(page, 'POLYGON((139.70 35.60, 139.80 35.60, 139.80 35.70, 139.70 35.60))');
  await pasteOnMap(page);
  await expect(status(page)).toContainText('図形 1 個');
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.getByRole('button', { name: '表示範囲の画像をコピー' }).click();
  await expect(status(page)).toContainText('表示範囲の画像をコピーしました');
  const types = await page.evaluate(async () => (await navigator.clipboard.read()).flatMap((i) => i.types));
  expect(types).toContain('image/png');

  // That picture pasted back opens as a picture.
  await pasteFromMenu(page);
  await expect(page.locator('#images li', { hasText: '貼り付け.png' })).toHaveCount(1);
  const kind = await page.evaluate(() => window.viewer.images.layers().find((l) => l.name === '貼り付け.png')?.type);
  expect(kind).toBe('image');
});
