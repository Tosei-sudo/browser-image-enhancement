import { expect, test, type Locator, type Page } from '@playwright/test';

/*
 * The docking layout (src/dock.ts): the panels move between the left, right
 * and bottom docks by their ◧ menu or by dragging their title or tab, share a
 * group as tabs, float over the map, and the layout is kept for the next
 * visit and in projects; 「レイアウトを元に戻す」 puts it back. Dialogs dock
 * by their ◧ too (src/dock-dialogs.ts), and attribute tables can be kept on
 * a layer each, several at once.
 */

const layer = (name: string, n: number) => ({
  type: 'FeatureCollection',
  features: Array.from({ length: n }, (_, i) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [139.7 + i * 0.01, 35.68] },
    properties: { name: `${name}${i + 1}` },
  })),
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const root = () => navigator.storage.getDirectory();
    const w = window as unknown as Record<string, unknown>;
    w.showOpenFilePicker = async (options?: { id?: string }) =>
      options?.id === 'image-viewer-project' ? [await (await root()).getFileHandle('dock.ivproj')] : [await (await root()).getFileHandle('parks.geojson'), await (await root()).getFileHandle('schools.geojson')];
    w.showSaveFilePicker = async () => (await root()).getFileHandle('dock.ivproj', { create: true });
  });
});

async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

async function openLayers(page: Page) {
  await page.evaluate(
    async (files) => {
      const root = await navigator.storage.getDirectory();
      for (const [name, text] of Object.entries(files)) {
        const writable = await (await root.getFileHandle(name, { create: true })).createWritable();
        await writable.write(text);
        await writable.close();
      }
    },
    { 'parks.geojson': JSON.stringify(layer('公園', 3)), 'schools.geojson': JSON.stringify(layer('学校', 5)) },
  );
  await page.locator('#open .ol-load-image button').first().click();
  await expect(page.locator('#images li.image')).toHaveCount(2);
}

async function drag(page: Page, handle: Locator, to: { x: number; y: number }) {
  const box = (await handle.boundingBox())!;
  const x = box.x + Math.min(30, box.width / 2);
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 10, y + 10);
  await page.mouse.move((x + to.x) / 2, (y + to.y) / 2);
  await page.mouse.move(to.x, to.y);
  await page.mouse.up();
}

const dock = (page: Page, side: string) => page.locator(`.dock-${side}`);
const menuItem = (page: Page, name: string) => page.getByRole('menuitem', { name });

test('panels move between the docks by the menu and by dragging, and the layout is kept', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  // As it first was: the layers on the left, the table below, no tabs.
  await expect(dock(page, 'left').locator('.side')).toBeVisible();
  await expect(dock(page, 'bottom').locator('#table')).toBeVisible();
  await expect(page.locator('.dock-tab')).toHaveCount(0);
  await expect(dock(page, 'right')).toBeHidden();
  const mapWidth = await page.locator('#map').evaluate((e) => e.getBoundingClientRect().width);

  // The table to the right by its ◧ menu.
  await page.locator('#table .dock-button').click();
  await menuItem(page, '右に置く').click();
  await expect(dock(page, 'right').locator('#table')).toBeVisible();
  await expect(dock(page, 'bottom')).toBeHidden();
  await expect.poll(() => page.locator('#map').evaluate((e) => e.getBoundingClientRect().width)).toBeLessThan(mapWidth - 100);
  // The map follows its new size.
  await expect.poll(() => page.evaluate(() => Math.round(window.viewer.map.getSize()![0]))).toBe(Math.round(await page.locator('#map').evaluate((e) => e.getBoundingClientRect().width)));

  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);
  await expect(dock(page, 'right').locator('#table')).toBeVisible();

  // Dragged by its title onto the layers: a tab beside them.
  const side = (await dock(page, 'left').boundingBox())!;
  await drag(page, page.locator('#table .table-bar h2'), { x: side.x + side.width / 2, y: side.y + side.height / 2 });
  await expect(dock(page, 'left').locator('.dock-tab span')).toHaveText(['レイヤー', '属性テーブル']);
  await expect(page.locator('#table')).toBeVisible();
  await expect(page.locator('.side')).toBeHidden();
  await dock(page, 'left').getByRole('tab', { name: 'レイヤー' }).click();
  await expect(page.locator('.side')).toBeVisible();
  await expect(page.locator('#table')).toBeHidden();

  // Its tab dragged to the bottom edge of the map: below again, alone, no tabs.
  const map = (await page.locator('#map').boundingBox())!;
  await drag(page, dock(page, 'left').getByRole('tab', { name: '属性テーブル' }), { x: map.x + map.width / 2, y: map.y + map.height - 20 });
  await expect(dock(page, 'bottom').locator('#table')).toBeVisible();
  await expect(page.locator('.dock-tab')).toHaveCount(0);

  // Onto the middle of the map: floating in a window of its own, which keeps its place.
  await drag(page, page.locator('#table .table-bar h2'), { x: map.x + 200, y: map.y + 150 });
  const float = page.locator('dialog.dock-float');
  await expect(float.locator('#table')).toBeVisible();
  await expect(dock(page, 'bottom')).toBeHidden();
  const box = (await float.boundingBox())!;
  expect(Math.abs(box.x - (map.x + 200 - 40))).toBeLessThan(4);
  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);
  await expect(float.locator('#table')).toBeVisible();
  // × of the window: back where it belongs.
  await float.getByRole('button', { name: '元の場所に戻す' }).click();
  await expect(dock(page, 'bottom').locator('#table')).toBeVisible();
  await expect(float).toHaveCount(0);

  // The layers to the right, then everything back as it first was.
  await page.locator('.dock-left .dock-button').click();
  await menuItem(page, '右に置く').click();
  await expect(dock(page, 'right').locator('.side')).toBeVisible();
  await expect(dock(page, 'left')).toBeHidden();
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#layout-reset').click();
  await expect(dock(page, 'left').locator('.side')).toBeVisible();
  await expect(dock(page, 'right')).toBeHidden();
  expect(errors).toEqual([]);
});

test('a dialog docks, opens there again, and becomes a dialog again', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#processing').click();
  const dialog = page.locator('dialog.processing-dialog:not(.zonal-dialog)').first();
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((d) => d.matches(':modal'))).toBe(true);

  await dialog.locator('.dock-button').click();
  await menuItem(page, '下に置く').click();
  // Below, beside the attribute table; open but not holding the page.
  await expect(dock(page, 'bottom').locator('dialog.processing-dialog')).toBeVisible();
  expect(await dialog.evaluate((d: HTMLDialogElement) => [d.open, d.matches(':modal'), d.classList.contains('docked')])).toEqual([true, false, true]);
  await expect(dock(page, 'bottom').locator('.dock-group')).toHaveCount(2);
  // The map can be used beside it.
  await page.getByRole('button', { name: 'ツール' }).click();
  await expect(page.locator('#tools-panel')).toBeVisible();
  await page.keyboard.press('Escape');

  // Closed: out of the dock. Opened again: back in it.
  await dialog.evaluate((d: HTMLDialogElement) => d.close());
  await expect(dock(page, 'bottom').locator('dialog')).toHaveCount(0);
  await expect(dock(page, 'bottom').locator('.dock-group:visible')).toHaveCount(1);
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#processing').click();
  await expect(dock(page, 'bottom').locator('dialog.processing-dialog')).toBeVisible();

  // Also after a reload.
  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#processing').click();
  await expect(dock(page, 'bottom').locator('dialog.processing-dialog')).toBeVisible();

  // 「ウィンドウに戻す」: a modal dialog again.
  await dialog.locator('.dock-button').click();
  await menuItem(page, 'ウィンドウに戻す').click();
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((d: HTMLDialogElement) => [d.open, d.matches(':modal'), d.classList.contains('docked')])).toEqual([true, true, false]);
  await expect(dock(page, 'bottom').locator('dialog')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // Opened again: a dialog, as its place in the layout was forgotten.
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#processing').click();
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((d: HTMLDialogElement) => d.matches(':modal'))).toBe(true);
  expect(errors).toEqual([]);
});

test('several attribute tables at once, kept in a project', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await openLayers(page);
  const name = (n: string) => page.locator('#images li.image .name', { hasText: n });
  await name('parks').click();
  await expect(page.locator('#table .attributes tbody tr[data-index]')).toHaveCount(3);

  // 「固定」: a table kept on 公園, as a tab beside the main one.
  await page.locator('#table .table-pin').click();
  const tabs = dock(page, 'bottom').locator('.dock-tab span');
  await expect(tabs).toHaveText(['属性テーブル', 'parks']);
  const parks = page.getByLabel('属性テーブル: parks');
  await expect(parks.locator('.attributes tbody tr[data-index]')).toHaveCount(3);

  // Another layer selected: the main table follows it, the kept one stays.
  await name('schools').click();
  await expect(page.locator('#table .attributes tbody tr[data-index]')).toHaveCount(5);
  await dock(page, 'bottom').getByRole('tab', { name: 'parks' }).click();
  await expect(parks.locator('.attributes tbody tr[data-index]')).toHaveCount(3);

  // A layer's menu opens its own too; side by side by dragging it to the right half.
  await name('schools').click({ button: 'right' });
  await menuItem(page, '属性テーブルを開く').click();
  await expect(tabs).toHaveText(['属性テーブル', 'parks', 'schools']);
  const group = (await dock(page, 'bottom').locator('.dock-group').boundingBox())!;
  await drag(page, dock(page, 'bottom').getByRole('tab', { name: 'schools' }), { x: group.x + group.width - 30, y: group.y + group.height / 2 });
  await expect(dock(page, 'bottom').locator('.dock-group')).toHaveCount(2);
  const schools = dock(page, 'bottom').locator('.dock-group').nth(1).locator('section.table');
  await expect(schools.locator('.attributes tbody tr[data-index]')).toHaveCount(5);
  // Both at once: 公園 in the first group (its tab in front), 学校 beside it.
  await dock(page, 'bottom').getByRole('tab', { name: 'parks' }).click();
  await expect(parks).toBeVisible();
  await expect(schools).toBeVisible();

  // A row of a kept table selects its feature, like the main table.
  await parks.locator('.attributes tbody tr[data-index]').first().click();
  expect(await page.evaluate(() => window.viewer.selection.list().map((f) => f.get('name')))).toEqual(['公園1']);

  // Kept in a project, with where they are.
  await page.keyboard.press('Control+s');
  await expect(page.locator('#status')).toHaveText('dock.ivproj に保存しました');
  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.getByRole('button', { name: 'プロジェクト' }).click();
  await page.getByRole('button', { name: '開く…', exact: true }).click();
  await expect(page.locator('#status')).toHaveText('プロジェクト「dock」を開きました');
  await expect(dock(page, 'bottom').locator('.dock-group')).toHaveCount(2);
  await expect(dock(page, 'bottom').locator('.dock-tab span')).toHaveText(['属性テーブル', 'parks']);
  await expect(dock(page, 'bottom').locator('.dock-group').nth(1).locator('.table-bar h2')).toHaveText('属性: schools');
  await expect(dock(page, 'bottom').locator('.dock-group').nth(1).locator('.attributes tbody tr[data-index]')).toHaveCount(5);

  // Closing a layer closes its tables; the × of a tab closes one.
  await page.evaluate(() => {
    const { images } = window.viewer;
    images.remove(images.layers().find((l) => l.name === 'schools')!);
  });
  await expect(dock(page, 'bottom').locator('.dock-group')).toHaveCount(1);
  await expect(page.getByLabel('属性テーブル: schools')).toHaveCount(0);
  await dock(page, 'bottom').getByRole('button', { name: 'parksを閉じる' }).click();
  await expect(page.locator('.dock-tab')).toHaveCount(0);
  await expect(dock(page, 'bottom').locator('section.table')).toHaveCount(1);
  expect(errors).toEqual([]);
});
