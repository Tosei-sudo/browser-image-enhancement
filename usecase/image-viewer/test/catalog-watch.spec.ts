import { expect, test } from '@playwright/test';

/*
 * Watches of the image catalog: a watch made from the catalog panel's
 * conditions notes the images already there, and an image added later
 * shows in 「通知」 with its count and opens from there; points of the map
 * join one watch. The service worker's part is catalog-watch-sw.spec.ts.
 */

import { catalog, image, serveCatalog } from './catalog-watch-fixtures.js';

test('a watch made in the catalog panel notifies a new image, which opens from 「通知」', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const list = [image('OLD-1', 1), image('OLD-2', 2, 'S2')];
  await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ imageCatalogs: [catalog] }) }));
  const queries = await serveCatalog(page, list);
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  const bell = page.locator('#watch-open');
  await expect(bell).toBeVisible();
  await expect(bell.locator('.watch-count')).toBeHidden();

  // The catalog panel's sensor becomes the watch's condition.
  await page.locator('#catalog-open').click();
  const panel = page.locator('.catalog-dialog');
  await expect(panel.locator('tbody tr')).toHaveCount(2);
  await panel.locator('select[name=sensor]').selectOption('S1');
  await panel.locator('button[value=watch]').click();
  const create = page.locator('.watch-create');
  await expect(create).toBeVisible();
  await expect(create.locator('.watch-conditions')).toContainText('センサー S1');
  await create.locator('input[name=name]').fill('東京湾 S1');
  await create.getByLabel('指定しない').check();
  await create.locator('button[value=ok]').click();
  await expect(create).toBeHidden();
  // The first check only notes what is there.
  await expect.poll(() => page.evaluate(() => window.viewer.watch.watches()[0]?.lastChecked ?? null)).not.toBeNull();
  expect(queries.at(-1)).toMatch(/^SENSOR = 'S1' AND REG_TIME >= TIMESTAMP '/);
  await expect(bell.locator('.watch-count')).toBeHidden();

  // A new image of S1 (and one of S2, which the watch does not want) comes in.
  list.push(image('NEW-3', 3), image('NEW-4', 4, 'S2'));
  await bell.click();
  const center = page.locator('.watch-dialog');
  await center.locator('button[value=check]').click();
  await expect(center.locator('.watch-notice')).toHaveCount(1);
  await expect(center.locator('.watch-notice.unread')).toContainText('NEW-3');
  await expect(center.locator('.watch-notice')).toContainText('東京湾 S1');
  await expect(bell.locator('.watch-count')).toHaveText('1');

  // Checking again finds nothing more.
  await center.locator('button[value=check]').click();
  await expect(center.locator('.service-status')).toHaveText('新着はありません');
  await expect(center.locator('.watch-notice')).toHaveCount(1);

  // Opening it loads the COG and reads the notice.
  await center.locator('.watch-notice button', { hasText: '開く' }).click();
  await expect(page.locator('#images li')).toHaveCount(1);
  await expect(center.locator('.watch-notice.unread')).toHaveCount(0);
  await expect(bell.locator('.watch-count')).toBeHidden();

  // The watches list, and deleting one with its notices.
  await center.locator('.watch-more summary').click();
  await expect(center.locator('.watch-more summary')).toHaveText('監視条件（1）');
  await expect(center.locator('.watch-watch')).toContainText('東京湾 S1');
  await expect(center.locator('.watch-background')).toContainText('10 分ごと');
  await center.locator('.watch-watch button', { hasText: '削除' }).click();
  await expect(center.locator('.watch-watch')).toHaveCount(0);
  await expect(center.locator('.watch-notice')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the map menu watches a point, and further points join the same watch', async ({ page }) => {
  await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ imageCatalogs: [catalog] }) }));
  const queries = await serveCatalog(page, [image('OLD-1', 1)]);
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  const menu = page.locator('.coordinate-menu').getByRole('menuitem', { name: 'この地点の新着画像を監視…' });
  await page.locator('#map').click({ button: 'right', position: { x: 300, y: 300 } });
  await menu.click();
  const create = page.locator('.watch-create');
  await expect(create.locator('.watch-point')).toBeVisible();
  await expect(create.locator('.watch-point input')).toBeChecked();
  // No watch yet: nothing to add to.
  await expect(create.locator('.watch-target')).toBeHidden();
  await create.locator('input[name=name]').fill('POI');
  await create.locator('button[value=ok]').click();
  await expect.poll(() => page.evaluate(() => window.viewer.watch.watches()[0]?.lastChecked ?? null)).not.toBeNull();

  // A second point joins it.
  await page.locator('#map').click({ button: 'right', position: { x: 420, y: 260 } });
  await menu.click();
  await expect(create.locator('.watch-target')).toBeVisible();
  await create.locator('select[name=target]').selectOption({ label: '「POI」に地点を追加' });
  await expect(create.locator('input[name=name]')).toBeHidden();
  await expect(create.locator('button[value=ok]')).toHaveText('地点を追加');
  await create.locator('button[value=ok]').click();
  await expect.poll(() => page.evaluate(() => window.viewer.watch.watches().map((w) => w.areas.map((a) => (a.kind === 'points' ? a.points.length : -1))))).toEqual([[2]]);
  expect(await page.evaluate(() => window.viewer.watch.watches().length)).toBe(1);
  await page.locator('#watch-open').click();
  await page.locator('.watch-more summary').click();
  await expect(page.locator('.watch-watch')).toContainText('地点 2 か所');
  expect(queries.length).toBeGreaterThan(0);
});
