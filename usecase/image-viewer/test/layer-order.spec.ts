import { expect, test, type Page } from '@playwright/test';
import { plainGeoTiff } from './fixtures.js';

/*
 * Reordering the layer list: Ctrl+click and Shift+click pick several layers,
 * which ↑ ↓ and the right-click menu move together; rows and groups are
 * dragged to their place (onto a group's row: into it). A group's vector
 * layers take one style at once from the group's ◐.
 */

async function open(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

/** Opens files one by one, as from 「開く」. */
async function choose(page: Page, name: string, bytes: Uint8Array | string) {
  await page.evaluate(
    ([name, data, text]) => {
      const list = new DataTransfer();
      list.items.add(new File([text ? data : Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], name));
      const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
      input.files = list.files;
      input.dispatchEvent(new Event('change'));
    },
    [name, typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('base64'), typeof bytes === 'string'] as const,
  );
  await expect(page.locator('#status')).toContainText(`${name.replace(/\.geojson$/, '')} を開きました`);
}

const names = (page: Page) => page.evaluate(() => window.viewer.images.layers().map((l) => l.name));
const row = (page: Page, name: string) => page.locator('#images li.image').filter({ has: page.locator('.name', { hasText: name }) });

test('picked layers move up and down together, and rows are dragged into place', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  for (const name of ['a.tif', 'b.tif', 'c.tif', 'd.tif']) await choose(page, name, plainGeoTiff(64, 64));
  expect(await names(page)).toEqual(['d.tif', 'c.tif', 'b.tif', 'a.tif']);

  // b, then Ctrl+click a: both picked, b still the selected one.
  await row(page, 'b.tif').locator('.name').click();
  await row(page, 'a.tif').locator('.name').click({ modifiers: ['Control'] });
  await expect(page.locator('#images li.image.picked')).toHaveCount(2);
  await expect(page.locator('#images li.image.selected .name')).toHaveText('b.tif');
  // ↑ on either moves both; at the top they stay.
  await row(page, 'a.tif').getByRole('button', { name: '上へ' }).click();
  expect(await names(page)).toEqual(['d.tif', 'b.tif', 'a.tif', 'c.tif']);
  await row(page, 'b.tif').getByRole('button', { name: '上へ' }).click();
  await expect(row(page, 'b.tif').getByRole('button', { name: '上へ' })).toBeDisabled();
  await row(page, 'a.tif').getByRole('button', { name: '上へ' }).click();
  expect(await names(page)).toEqual(['b.tif', 'a.tif', 'd.tif', 'c.tif']);
  // The right-click menu: to the bottom.
  await row(page, 'a.tif').locator('.name').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '選択した 2 件をいちばん下へ' }).click();
  expect(await names(page)).toEqual(['d.tif', 'c.tif', 'b.tif', 'a.tif']);
  // Map order follows.
  expect(await page.evaluate(() => window.viewer.images.layers().map((l) => l.layer.getZIndex()))).toEqual([4, 3, 2, 1]);

  // A plain click picks one again; Shift+click picks a run.
  await row(page, 'd.tif').locator('.name').click();
  await expect(page.locator('#images li.image.picked')).toHaveCount(0);
  await row(page, 'b.tif').locator('.name').click({ modifiers: ['Shift'] });
  await expect(page.locator('#images li.image.picked')).toHaveCount(3);
  await row(page, 'd.tif').locator('.name').click();

  // Dragging one row below another.
  const box = await row(page, 'b.tif').boundingBox();
  await row(page, 'd.tif').locator('.name').dragTo(row(page, 'b.tif'), { targetPosition: { x: 20, y: box!.height - 4 } });
  expect(await names(page)).toEqual(['c.tif', 'b.tif', 'd.tif', 'a.tif']);
  // Above the top one.
  await row(page, 'a.tif').locator('.name').dragTo(row(page, 'c.tif'), { targetPosition: { x: 20, y: 3 } });
  expect(await names(page)).toEqual(['a.tif', 'c.tif', 'b.tif', 'd.tif']);

  // Into a group: dropped on its row's lower half, it goes on top of its layers; dragged out of it again.
  await page.evaluate(() => {
    const images = window.viewer.images;
    images.createGroup(images.layers().filter((l) => l.name === 'b.tif' || l.name === 'd.tif'), 'g');
  });
  const head = page.locator('#images li.layer-group .group-head');
  const headBox = await head.boundingBox();
  await row(page, 'a.tif').locator('.name').dragTo(head, { targetPosition: { x: 40, y: headBox!.height - 4 } });
  expect(await page.evaluate(() => window.viewer.images.groups().map((g) => window.viewer.images.members(g).map((l) => l.name)))).toEqual([['a.tif', 'b.tif', 'd.tif']]);
  await row(page, 'd.tif').locator('.name').dragTo(row(page, 'c.tif'), { targetPosition: { x: 20, y: 3 } });
  expect(await names(page)).toEqual(['d.tif', 'c.tif', 'a.tif', 'b.tif']);
  expect(await page.evaluate(() => window.viewer.images.layers().map((l) => window.viewer.images.groupOf(l)?.name ?? null))).toEqual([null, null, 'g', 'g']);

  // A whole group dragged above another row.
  await head.locator('.group-name').dragTo(row(page, 'd.tif'), { targetPosition: { x: 20, y: 3 } });
  expect(await names(page)).toEqual(['a.tif', 'b.tif', 'd.tif', 'c.tif']);
  expect(errors).toEqual([]);
});

const square = (x: number, y: number, d = 0.01) => [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]];
const collection = (x: number, uses: string[]) =>
  JSON.stringify({
    type: 'FeatureCollection',
    features: uses.map((use, i) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: square(x, 35.68 + i * 0.01) }, properties: { use } })),
  });

test('a group\'s vector layers take one style at once; its images are left as they are', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await choose(page, 'west.geojson', collection(139.7, ['公園', '住宅']));
  await choose(page, 'east.geojson', collection(139.75, ['商業', '住宅']));
  await choose(page, 'photo.tif', plainGeoTiff(64, 64));
  const head = page.locator('#images li.layer-group .group-head');
  // No vector layer in it: no ◐.
  await page.evaluate(() => window.viewer.images.createGroup(window.viewer.images.layers().filter((l) => l.name === 'photo.tif'), 'p'));
  await expect(head.getByRole('button', { name: 'まとめてスタイル' })).toBeHidden();
  await page.evaluate(() => window.viewer.images.createGroup(window.viewer.images.layers(), 'all'));
  await expect(head.getByRole('button', { name: 'まとめてスタイル' })).toBeVisible();

  await head.getByRole('button', { name: 'まとめてスタイル' }).click();
  const dialog = page.getByRole('dialog', { name: 'スタイル: グループ「all」（ベクター 2 件）' });
  await expect(dialog).toBeVisible();
  // The categories of both layers.
  await dialog.getByLabel('表示方法').selectOption('categorized');
  await dialog.getByLabel('色分けする属性').selectOption('use');
  for (const use of ['公園', '住宅', '商業']) await expect(dialog.getByLabel(`${use} の色`)).toBeVisible();
  await dialog.getByLabel('商業 の色').fill('#ff8800');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('#status')).toContainText('グループ「all」のベクターレイヤー 2 件のスタイルを変更しました');
  const specs = await page.evaluate(() =>
    window.viewer.images
      .layers()
      .filter((l) => l.type === 'service')
      .map((l) => {
        const spec = (l as { service: import('../src/services/index.js').ServiceLayer }).service.style!.get();
        return { mode: spec.mode, field: spec.field, 商業: spec.categories.find((c) => c.value === '商業')?.color };
      }),
  );
  expect(specs).toEqual([
    { mode: 'categorized', field: 'use', 商業: '#ff8800' },
    { mode: 'categorized', field: 'use', 商業: '#ff8800' },
  ]);
  expect(errors).toEqual([]);
});
