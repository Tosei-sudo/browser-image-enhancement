import { expect, test, type Page } from '@playwright/test';

/*
 * Vector layers drawn on the GPU (`?vectorgl=always` draws every layer there;
 * by default only layers of many features are, on browsers with a GPU): the
 * WebGL layer shows and hides with the layer, clicks select the feature
 * under them, and features of hidden categories are neither drawn nor
 * selected.
 */

async function open(page: Page, query = '?vectorgl=always') {
  await page.goto(`/index.html${query}`);
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
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: square(139.72, 35.68) }, properties: { name: '駅前', use: '商業' } },
  ],
});

/** Puts the feature named `name` in the middle of the map (clear of the panels over it) and clicks it. */
async function clickOn(page: Page, name: string) {
  await page.waitForFunction(() => !window.viewer.map.getView().getAnimating());
  const pixel = await page.evaluate((name) => {
    const map = window.viewer.map;
    const f = window.viewer.table.rows().find((r) => r.get('name') === name)!;
    const [minX, minY, maxX, maxY] = f.getGeometry()!.getExtent();
    map.getView().setCenter([(minX + maxX) / 2, (minY + maxY) / 2]);
    map.renderSync();
    return [map.getSize()![0] / 2, map.getSize()![1] / 2];
  }, name);
  const box = (await page.locator('#map').boundingBox())!;
  await page.mouse.click(box.x + pixel[0], box.y + pixel[1]);
}

const glCanvases = (page: Page) => page.locator('#map .gl-vector');

test('a vector layer drawn on the GPU shows, selects and hides like any other', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await choose(page, 'landuse.geojson', landuse);
  await expect(page.locator('#status')).toContainText('landuse を開きました');
  expect(await page.evaluate(() => (window.viewer.images.layers()[0] as { service: import('../src/services/index.js').ServiceLayer }).service.style!.onGpu())).toBe(true);
  await expect(glCanvases(page)).toHaveCount(1);

  // A click on a polygon selects it.
  await expect(async () => {
    await clickOn(page, '駅前');
    await expect(page.locator('.table-count')).toContainText('選択 1 件', { timeout: 1500 });
  }).toPass();
  expect(await page.evaluate(() => window.viewer.selection.features.item(0)?.get('name'))).toBe('駅前');

  // A hidden category is not drawn, so a click there selects nothing.
  await page.evaluate(() => {
    const style = (window.viewer.images.layers()[0] as { service: import('../src/services/index.js').ServiceLayer }).service.style!;
    const spec = style.get();
    spec.mode = 'categorized';
    spec.field = 'use';
    spec.categories = [
      { value: '公園', color: '#00aa00', visible: true },
      { value: '商業', color: '#ff8800', visible: false },
    ];
    style.set(spec);
  });
  await clickOn(page, '駅前');
  await expect(page.locator('.table-count')).toContainText('選択 0 件');
  await clickOn(page, '中央公園');
  await expect(page.locator('.table-count')).toContainText('選択 1 件');

  // Hiding the layer hides its drawing; closing it takes the drawing away.
  const row = page.locator('#images li').first();
  await row.locator('input[type=checkbox]').uncheck();
  await expect(glCanvases(page)).toHaveCount(0);
  await row.locator('input[type=checkbox]').check();
  await expect(glCanvases(page)).toHaveCount(1);
  page.on('dialog', (d) => void d.accept());
  await row.getByRole('button', { name: '閉じる' }).click();
  await expect(page.locator('#images li')).toHaveCount(0);
  await expect(glCanvases(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('small layers stay on the canvas', async ({ page }) => {
  await open(page, '');
  await choose(page, 'landuse.geojson', landuse);
  await expect(page.locator('#status')).toContainText('landuse を開きました');
  expect(await page.evaluate(() => (window.viewer.images.layers()[0] as { service: import('../src/services/index.js').ServiceLayer }).service.style!.onGpu())).toBe(false);
  await expect(glCanvases(page)).toHaveCount(0);
});
