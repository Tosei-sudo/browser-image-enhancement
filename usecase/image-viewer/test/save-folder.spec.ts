import { expect, test, type Page } from '@playwright/test';

/*
 * 「保存先…」: files the viewer makes go to a folder chosen once, written
 * straight into it, instead of downloads. The folder picker gives a folder of
 * the origin's private file system, which IndexedDB can keep like a real one.
 */

async function saveView(page: Page) {
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#save-view').click();
  const dialog = page.locator('.view-export');
  await dialog.locator('select[name=format]').selectOption('png');
  await dialog.getByRole('button', { name: '保存' }).click();
}

async function filesIn(page: Page, folder: string): Promise<Record<string, number>> {
  return page.evaluate(async (name) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
    const sizes: Record<string, number> = {};
    for await (const entry of (dir as unknown as { values(): AsyncIterable<FileSystemFileHandle> }).values()) {
      sizes[entry.name] = (await entry.getFile()).size;
    }
    return sizes;
  }, folder);
}

test('files are written into the chosen folder, numbered when the name is taken, and downloaded again when switched back', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle('out', { create: true });
  });
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.goto('/index.html?url=/fixture.tif');
  await expect(page.locator('#status')).toContainText('fixture.tif を開きました');

  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#save-folder').click();
  const dialog = page.locator('dialog.save-folder');
  await expect(dialog).toContainText('いまの保存先: ダウンロード');
  await dialog.getByRole('button', { name: 'フォルダを選ぶ…' }).click();
  await expect(dialog).toContainText('いまの保存先: フォルダ「out」');
  await dialog.getByRole('button', { name: '閉じる' }).click();
  await expect(page.locator('#save-folder')).toHaveText('保存先: out…');

  await saveView(page);
  await expect(page.locator('#status')).toContainText('フォルダ「out」に fixture_view.png を保存しました');
  await saveView(page);
  await expect(page.locator('#status')).toContainText('フォルダ「out」に fixture_view (1).png を保存しました');
  const files = await filesIn(page, 'out');
  expect(Object.keys(files).sort()).toEqual(['fixture_view (1).png', 'fixture_view.png']);
  expect(files['fixture_view.png']).toBeGreaterThan(1000);
  expect(downloads).toBe(0);

  // Kept after a reload.
  await page.reload();
  await expect(page.locator('#save-folder')).toHaveText('保存先: out…');

  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#save-folder').click();
  await dialog.getByRole('button', { name: 'ダウンロードに戻す' }).click();
  await expect(dialog).toContainText('いまの保存先: ダウンロード');
  await dialog.getByRole('button', { name: '閉じる' }).click();
  await expect(page.locator('#save-folder')).toHaveText('保存先…');
  const download = page.waitForEvent('download');
  await saveView(page);
  expect((await download).suggestedFilename()).toBe('fixture_view.png');
  expect(errors).toEqual([]);
});
