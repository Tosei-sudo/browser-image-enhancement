import { expect, test, type Page } from '@playwright/test';
import { plainGeoTiff } from './fixtures.js';

/*
 * Groups of layers: files dropped together come in a group of their own,
 * which folds, shows and hides, moves and closes its layers as one; layers go
 * in and out of groups from their right-click menu; many images dropped at
 * once are shown as each is ready, and get their RSETs a few at a time; a
 * project keeps the groups.
 */

async function open(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

/** Drops files on the map, as a person would. */
async function drop(page: Page, files: Array<{ name: string; bytes: Uint8Array }>) {
  await page.evaluate(
    (files) => {
      const data = new DataTransfer();
      for (const f of files) data.items.add(new File([Uint8Array.from(atob(f.bytes), (c) => c.charCodeAt(0))], f.name, { type: 'image/tiff' }));
      window.viewer.map.getViewport().dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    },
    files.map((f) => ({ name: f.name, bytes: Buffer.from(f.bytes).toString('base64') })),
  );
}

const tiff = (name: string, width = 300, height = 200) => ({ name, bytes: plainGeoTiff(width, height) });

/** The groups, top first, with their layers' names. */
const groups = (page: Page) =>
  page.evaluate(() => window.viewer.images.groups().map((g) => ({ name: g.name, layers: window.viewer.images.members(g).map((l) => l.name) })));

test('files dropped together come in a group that folds, hides, moves and closes them together', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await drop(page, [tiff('scene_b4.tif'), tiff('scene_b3.tif'), tiff('scene_b2.tif')]);
  await expect(page.locator('#status')).toContainText('3 件のレイヤーをグループ「scene」にまとめて開きました');
  // The last file on top, as files opened one after another are.
  expect(await groups(page)).toEqual([{ name: 'scene', layers: ['scene_b2.tif', 'scene_b3.tif', 'scene_b4.tif'] }]);
  const group = page.locator('#images > li.layer-group');
  await expect(group.locator('.group-count')).toHaveText('3');
  await expect(group.locator('.group-layers li.image')).toHaveCount(3);
  // The last one opened is selected.
  await expect(page.locator('#images li.image.selected .name')).toHaveText('scene_b2.tif');

  // Folding hides the rows, not the layers.
  await group.locator('.group-name').click();
  await expect(group.locator('.group-layers')).toBeHidden();
  await group.locator('.group-name').click();
  await expect(group.locator('.group-layers')).toBeVisible();

  // The group's check box hides all of them; a layer hidden on its own stays hidden when the group shows again.
  await group.locator('.group-layers li.image').nth(1).locator('input[type=checkbox]').uncheck();
  await group.getByRole('checkbox', { name: 'グループ scene を表示' }).uncheck();
  expect(await page.evaluate(() => window.viewer.images.layers().map((l) => l.layer.getVisible()))).toEqual([false, false, false]);
  await group.getByRole('checkbox', { name: 'グループ scene を表示' }).check();
  expect(await page.evaluate(() => window.viewer.images.layers().map((l) => l.layer.getVisible()))).toEqual([true, false, true]);

  // The group's opacity is every layer's.
  await group.locator('.group-head .opacity input').fill('0.5');
  expect(await page.evaluate(() => window.viewer.images.layers().map((l) => l.layer.getOpacity()))).toEqual([0.5, 0.5, 0.5]);

  // Another file: on top, outside the group; moving it down goes past the whole group.
  await drop(page, [tiff('other.tif')]);
  await expect(page.locator('#status')).toContainText('other.tif を開きました');
  expect(await page.evaluate(() => window.viewer.images.layers().map((l) => l.name))).toEqual(['other.tif', 'scene_b2.tif', 'scene_b3.tif', 'scene_b4.tif']);
  await page.locator('#images > li.image').getByRole('button', { name: '下へ' }).click();
  expect(await page.evaluate(() => window.viewer.images.layers().map((l) => l.name))).toEqual(['scene_b2.tif', 'scene_b3.tif', 'scene_b4.tif', 'other.tif']);
  // Map order follows: the group's layers above it.
  const z = await page.evaluate(() => window.viewer.images.layers().map((l) => l.layer.getZIndex()));
  expect(z).toEqual([4, 3, 2, 1]);
  // Within the group, ↑ and ↓ stay in it.
  await group.locator('.group-layers li.image').first().getByRole('button', { name: '下へ' }).click();
  expect((await groups(page))[0].layers).toEqual(['scene_b3.tif', 'scene_b2.tif', 'scene_b4.tif']);
  await expect(group.locator('.group-layers li.image').last().getByRole('button', { name: '下へ' })).toBeDisabled();

  // From the right-click menu, a layer goes into the group, and out of it.
  await page.locator('#images > li.image .name').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'グループ「scene」に入れる' }).click();
  expect((await groups(page))[0].layers).toEqual(['other.tif', 'scene_b3.tif', 'scene_b2.tif', 'scene_b4.tif']);
  await group.locator('.group-layers li.image').first().locator('.name').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'グループ「scene」から出す' }).click();
  expect(await page.evaluate(() => window.viewer.images.layers().map((l) => l.name))).toEqual(['other.tif', 'scene_b3.tif', 'scene_b2.tif', 'scene_b4.tif']);
  expect((await groups(page))[0].layers).toEqual(['scene_b3.tif', 'scene_b2.tif', 'scene_b4.tif']);

  // Renamed from its menu, then closed with its layers.
  page.once('dialog', (d) => void d.accept('バンド'));
  await group.getByRole('button', { name: 'グループのメニュー（名前の変更・解除など）' }).click();
  await page.getByRole('menuitem', { name: '名前を変更…' }).click();
  await expect(group.locator('.group-label')).toHaveText('バンド');
  page.once('dialog', (d) => void d.accept());
  await group.getByRole('button', { name: 'グループを閉じる（中のレイヤーもすべて閉じます）' }).click();
  expect(await page.evaluate(() => window.viewer.images.layers().map((l) => l.name))).toEqual(['other.tif']);
  await expect(page.locator('#images li.layer-group')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('one file, or one image with the files that go with it, makes no group', async ({ page }) => {
  await open(page);
  await drop(page, [tiff('single.tif')]);
  await expect(page.locator('#status')).toContainText('single.tif を開きました');
  await expect(page.locator('#images li.layer-group')).toHaveCount(0);
  expect(await groups(page)).toEqual([]);
});

test('many images dropped at once show as each is ready, in a folded group, and get their RSETs a few at a time', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  // The RSETs wait until the test lets them go.
  await page.evaluate(() => {
    window.viewer.rset.hold = new Promise((resolve) => ((window as unknown as { release: () => void }).release = () => resolve(null)));
  });
  const files = Array.from({ length: 14 }, (_, i) => tiff(`tile_${String(i + 1).padStart(2, '0')}.tif`, 800, 600));
  await drop(page, files);
  const group = page.locator('#images > li.layer-group');
  await expect(group.locator('.group-count')).toHaveText('14', { timeout: 20_000 });
  // Folded, as they are many; every one is on the map before its RSET, the first ones being made, the others waiting.
  await expect(group.locator('.group-layers')).toBeHidden();
  await expect(group.locator('.group-label')).toHaveText('tile');
  expect((await groups(page))[0].layers).toEqual(files.map((f) => f.name).reverse());
  await expect(page.locator('#images .tag', { hasText: 'RSET生成中' })).toHaveCount(14);
  await expect(page.locator('.rset-progress .rset-job')).toHaveCount(2);
  await expect(page.locator('.rset-waiting')).toContainText('ほか 12 件の RSET が順番待ち');
  // The view takes in all of them, not just the last one.
  const fitted = await page.evaluate(() => {
    const view = window.viewer.map.getView();
    return view.getResolution()! > 0;
  });
  expect(fitted).toBe(true);
  await page.evaluate(() => (window as unknown as { release: () => void }).release());
  await expect(page.locator('#images .tag', { hasText: 'RSET生成' }).filter({ hasNotText: '中' })).toHaveCount(14, { timeout: 30_000 });
  await expect(page.locator('.rset-progress')).toBeHidden();
  expect(errors).toEqual([]);
});

test('a project keeps the groups, their names, folding and visibility', async ({ page }) => {
  await open(page);
  const url = new URL('/fixture.tif', page.url()).href;
  await page.evaluate(async (url) => {
    const { images, loader } = window.viewer;
    await loader.loadUrl(url);
    await loader.loadUrl(url);
    await loader.loadUrl(url);
    const [a, b] = images.layers();
    const group = images.createGroup([a, b], '比較');
    images.setGroupCollapsed(group, true);
    images.setGroupVisible(group, false);
  }, url);
  const saved = await page.evaluate(() => window.viewer.project.collect().project);
  expect(saved.groups).toEqual([{ name: '比較', visible: false, collapsed: true }]);
  expect(saved.layers.map((l) => l.group)).toEqual([0, 0, undefined]);
  page.once('dialog', (d) => void d.accept());
  await page.evaluate((project) => window.viewer.project.open(project, 'groups'), saved);
  await expect(page.locator('#status')).toContainText('プロジェクト「groups」を開きました');
  const opened = await page.evaluate(() => {
    const { images } = window.viewer;
    return images.groups().map((g) => ({ name: g.name, collapsed: g.collapsed, visible: g.visible, count: images.members(g).length, drawn: images.members(g).map((l) => l.layer.getVisible()) }));
  });
  expect(opened).toEqual([{ name: '比較', collapsed: true, visible: false, count: 2, drawn: [false, false] }]);
  expect(await page.evaluate(() => window.viewer.images.layers().map((l) => window.viewer.images.groupOf(l)?.name ?? null))).toEqual(['比較', '比較', null]);
});
