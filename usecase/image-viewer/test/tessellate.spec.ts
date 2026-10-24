import { expect, test, type Page } from '@playwright/test';

/*
 * 格子の敷き詰め: the person draws an area and gets hexagons over it as a
 * temporary layer; the view and a projection work too, and a script can run it.
 */

async function open(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.evaluate(() => window.viewer.map.getView().setCenter([15557000, 4257000]));
  await page.evaluate(() => window.viewer.map.getView().setZoom(13));
  await page.waitForFunction(() => !window.viewer.map.getView().getAnimating());
}

const dialog = (page: Page) => page.getByRole('dialog', { name: '格子の敷き詰め' });
const cellCount = (page: Page) =>
  page.evaluate(() => {
    const layers = window.viewer.images.layers();
    const top = layers.find((l) => l.type === 'service' && l.name.startsWith('格子'));
    return top && top.type === 'service' ? top.service.vector!.source.getFeatures().length : 0;
  });

test('hexagons over a drawn box, cut to it, as a temporary layer', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.getByRole('button', { name: '格子の敷き詰め…' }).click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  await d.getByRole('radio', { name: '六角形' }).check();
  await d.getByLabel('大きさ', { exact: true }).fill('300');
  await expect(d.locator('.tessellate-size-note')).toContainText('面積 23.38 ha');
  await d.getByLabel('範囲の端のセル').selectOption('clip');
  await d.getByRole('button', { name: '□ 四角を作図' }).click();
  await expect(d).toBeHidden();
  const box = (await page.locator('#map').boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.click(x - 200, y - 120);
  await page.mouse.move(x, y, { steps: 5 });
  await page.mouse.move(x + 200, y + 120, { steps: 5 });
  await page.mouse.click(x + 200, y + 120);
  await expect(d).toBeVisible();
  await expect(d.locator('.tessellate-drawn')).toContainText('描いた範囲');
  await d.getByRole('button', { name: '実行' }).click();
  await expect(d).toBeHidden();
  await expect(page.locator('#images li')).toContainText('格子_六角形');
  expect(await cellCount(page)).toBeGreaterThan(10);
  // Attributes: id, row, column, label from the top left, area on the ellipsoid.
  const first = await page.evaluate(() => {
    const layer = window.viewer.images.layers().find((l) => l.type === 'service' && l.name === '格子_六角形');
    const f = layer && layer.type === 'service' ? layer.service.vector!.source.getFeatures() : [];
    return f.map((x) => x.getProperties()).find((p) => p.id === 1);
  });
  expect(first).toMatchObject({ id: 1, row: 1, label: 'A1' });
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/hexagons.png` });
  expect(errors).toEqual([]);
});

test('squares of a plane rectangular zone over the view, lined up with its origin', async ({ page }) => {
  await open(page);
  const d = dialog(page);
  await page.evaluate(() => window.viewer.tessellate.open());
  await d.getByLabel('敷き詰め方').selectOption('crs');
  await d.getByLabel('座標系').selectOption('EPSG:6677');
  await d.getByLabel('範囲', { exact: true }).selectOption('view');
  await d.getByLabel('大きさ', { exact: true }).fill('1');
  await d.getByLabel('単位').selectOption('km');
  await d.getByText('詳細設定').click();
  await d.getByLabel('格子の基準').selectOption('crs');
  if (process.env.SHOT_DIR) {
    await page.setViewportSize({ width: 1280, height: 1100 });
    await d.screenshot({ path: `${process.env.SHOT_DIR}/dialog.png` });
  }
  await d.getByRole('button', { name: '実行' }).click();
  await expect(d).toBeHidden();
  const corners = await page.evaluate(() => {
    const layer = window.viewer.images.layers().find((l) => l.type === 'service' && l.name === '格子_正方形');
    const f = layer && layer.type === 'service' ? layer.service.vector!.source.getFeatures()[0] : null;
    const g = f!.getGeometry()!.clone().transform('EPSG:3857', 'EPSG:6677') as unknown as { getCoordinates(): number[][][] };
    return g.getCoordinates()[0];
  });
  for (const [x, y] of corners) {
    expect(Math.abs(x / 1000 - Math.round(x / 1000))).toBeLessThan(1e-6);
    expect(Math.abs(y / 1000 - Math.round(y / 1000))).toBeLessThan(1e-6);
  }
});

test('triangles from a script, and a clear message when nothing was drawn', async ({ page }) => {
  await open(page);
  const d = dialog(page);
  await page.evaluate(() => window.viewer.tessellate.open());
  await d.getByRole('button', { name: '実行' }).click();
  await expect(d.locator('.processing-note')).toContainText('地図に範囲を作図');
  await d.getByRole('button', { name: '閉じる' }).click();
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.getByRole('button', { name: 'スクリプト…' }).click();
  const scripts = page.getByRole('dialog', { name: 'スクリプト' });
  await scripts.getByLabel('スクリプト（JavaScript）').fill("const made = await viewer.tool('tessellate', { shape: 'triangle', size: 500, area: 'view', clip: 'center' });\nprint('made', made.layers.length);");
  await scripts.getByRole('button', { name: '実行' }).click();
  await expect(scripts.locator('.script-output')).toContainText('made 1');
  expect(await cellCount(page)).toBeGreaterThan(10);
});
