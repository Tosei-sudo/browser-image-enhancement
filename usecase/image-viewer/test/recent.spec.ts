import { expect, test } from '@playwright/test';
import { plainGeoTiff } from './fixtures.js';

/*
 * Opening with the File System Access API: files chosen with the picker are
 * remembered by their handles and open again from 「最近」 after a reload.
 * The picker is stood in for by one that returns a file of the origin's
 * private file system, which gives real handles that IndexedDB can keep.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { showOpenFilePicker: () => Promise<FileSystemFileHandle[]> }).showOpenFilePicker = async () => {
      const root = await navigator.storage.getDirectory();
      return [await root.getFileHandle('stripes.tif')];
    };
  });
});

test('files chosen with the File System Access picker open again from 「最近」 after a reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.evaluate(async (bytes) => {
    const root = await navigator.storage.getDirectory();
    const writable = await (await root.getFileHandle('stripes.tif', { create: true })).createWritable();
    await writable.write(new Uint8Array(bytes));
    await writable.close();
  }, Array.from(plainGeoTiff(600, 520)));

  const recent = page.locator('#open .recent-button');
  await recent.click();
  await expect(page.getByRole('menu', { name: '最近開いたファイル' })).toContainText('最近開いたファイルはありません');
  await page.keyboard.press('Escape');

  await page.locator('#open .ol-load-image button').first().click();
  await expect(page.locator('#status')).toContainText('stripes.tif を開きました');
  await expect(page.locator('#images .name')).toHaveText(['stripes.tif']);

  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);
  await expect(page.locator('#images .name')).toHaveCount(0);
  await recent.click();
  await page.getByRole('menuitem', { name: 'stripes.tif' }).click();
  await expect(page.locator('#status')).toContainText('stripes.tif を開きました');
  await expect(page.locator('#info')).toContainText('600 × 520 px');
  // Opened again it stays one entry.
  await recent.click();
  await expect(page.getByRole('menuitem', { name: 'stripes.tif' })).toHaveCount(1);
  await page.getByRole('menuitem', { name: '履歴を消去' }).click();
  await recent.click();
  await expect(page.getByRole('menu', { name: '最近開いたファイル' })).toContainText('最近開いたファイルはありません');
  expect(errors).toEqual([]);
});
