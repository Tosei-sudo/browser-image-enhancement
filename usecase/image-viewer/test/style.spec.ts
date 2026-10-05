import { expect, test, type Page } from '@playwright/test';

/*
 * Symbols and labels of vector layers: the style dialog changes the map as
 * it is edited, OK keeps the style (it is there again when the file is
 * opened again), Cancel goes back.
 */

async function open(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

async function choose(page: Page, name: string, text: string) {
  await page.evaluate(
    ([name, text]) => {
      const list = new DataTransfer();
      list.items.add(new File([text], name));
      const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
      input.files = list.files;
      input.dispatchEvent(new Event('change'));
    },
    [name, text],
  );
}

const square = (x: number, y: number, d = 0.01) => [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]];
const landuse = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: square(139.7, 35.68) }, properties: { name: '中央公園', use: '公園' } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: square(139.71, 35.68) }, properties: { name: '駅前', use: '商業' } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: square(139.7, 35.69) }, properties: { name: '北町', use: '住宅' } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: square(139.71, 35.69) }, properties: { name: '東町', use: '住宅' } },
  ],
});

/** The style of the layer on top, and what its style function draws for its first feature. */
const drawn = (page: Page) =>
  page.evaluate(() => {
    const service = (window.viewer.images.layers()[0] as { service: import('../src/services/index.js').ServiceLayer }).service;
    const layer = service.layer as import('ol/layer/Vector.js').default;
    const feature = service.vector!.source.getFeatures().find((f) => f.get('name') === '駅前')!;
    const out = (layer.getStyleFunction()!(feature, 1) ?? []) as import('ol/style/Style.js').default | import('ol/style/Style.js').default[];
    const styles = Array.isArray(out) ? out : [out];
    return {
      spec: service.style!.get(),
      fill: styles[0]?.getFill()?.getColor(),
      label: styles[1]?.getText()?.getText(),
    };
  });

test('a vector layer is colored by an attribute and labelled, and keeps its style when opened again', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await choose(page, 'landuse.geojson', landuse);
  await expect(page.locator('#status')).toContainText('landuse を開きました');

  await page.locator('#images li').first().getByRole('button', { name: 'スタイル・ラベル' }).click();
  const dialog = page.getByRole('dialog', { name: 'スタイル: landuse' });
  await expect(dialog).toBeVisible();
  // Files have no style of their own to go back to.
  await expect(dialog.locator('option[value=own]')).toBeHidden();
  await dialog.getByLabel('表示方法').selectOption('categorized');
  await dialog.getByLabel('色分けする属性').selectOption('use');
  await expect(dialog.locator('.style-category')).toHaveCount(4); // 3 values and 「その他」
  await expect(dialog.locator('.style-category').filter({ hasText: '住宅' })).toContainText('2');
  await dialog.getByLabel('商業 の色').fill('#ff8800');
  await dialog.getByLabel('ラベルにする属性').selectOption('name');
  await dialog.getByLabel('文字の大きさ').fill('16');
  // The map follows before OK.
  await expect.poll(async () => (await drawn(page)).label).toBe('駅前');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();

  let now = await drawn(page);
  expect(now.spec.mode).toBe('categorized');
  expect(now.fill).toEqual([255, 136, 0, 0.25]);
  expect(now.spec.label).toMatchObject({ field: 'name', size: 16 });

  // Cancel goes back to the style kept.
  await page.locator('#images li').first().getByRole('button', { name: 'スタイル・ラベル' }).click();
  await dialog.getByLabel('表示方法').selectOption('single');
  await dialog.getByLabel('ラベルにする属性').selectOption('');
  expect((await drawn(page)).label).toBeUndefined();
  await dialog.getByRole('button', { name: 'キャンセル' }).click();
  now = await drawn(page);
  expect(now.spec.mode).toBe('categorized');
  expect(now.label).toBe('駅前');

  // The same file, opened again after a reload, looks the same.
  await open(page);
  await choose(page, 'landuse.geojson', landuse);
  await expect(page.locator('#status')).toContainText('landuse を開きました');
  now = await drawn(page);
  expect(now.spec.mode).toBe('categorized');
  expect(now.fill).toEqual([255, 136, 0, 0.25]);
  expect(now.label).toBe('駅前');

  // 初期設定に戻す: one symbol again, no labels.
  await page.locator('#images li').first().getByRole('button', { name: 'スタイル・ラベル' }).click();
  await dialog.getByRole('button', { name: '初期設定に戻す' }).click();
  await dialog.getByRole('button', { name: 'OK' }).click();
  now = await drawn(page);
  expect(now.spec.mode).toBe('single');
  expect(now.label).toBeUndefined();
  expect(errors).toEqual([]);
});
