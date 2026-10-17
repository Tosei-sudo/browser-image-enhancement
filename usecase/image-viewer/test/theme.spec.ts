import { expect, test } from '@playwright/test';

/*
 * Light and dark: 「表示」 in the 「ツール」 menu chooses 自動 (the system's
 * setting), ライト or ダーク; the choice is remembered over a reload.
 */

const background = () => getComputedStyle(document.body).backgroundColor;

test('自動 follows the system, and a chosen theme stays after a reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/index.html');
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(background)).toBe('rgb(255, 255, 255)');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(background)).toBe('rgb(27, 29, 33)');

  await page.getByRole('button', { name: 'ツール' }).click();
  await page.getByRole('radio', { name: 'ライト' }).click();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('radio', { name: 'ライト' })).toHaveAttribute('aria-checked', 'true');
  // The menu stays open, so the themes can be compared.
  await expect(page.locator('#tools-panel')).toBeVisible();

  await page.getByRole('radio', { name: 'ダーク' }).click();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();
  await expect(root).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(background)).toBe('rgb(27, 29, 33)');

  await page.getByRole('button', { name: 'ツール' }).click();
  await page.getByRole('radio', { name: '自動' }).click();
  await expect(root).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => localStorage.getItem('image-viewer.theme'))).toBeNull();
});
