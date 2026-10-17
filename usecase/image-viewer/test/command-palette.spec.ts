import { expect, test } from '@playwright/test';

/* The command palette: Ctrl+K, type a tool's name, Enter runs it. */

test('Ctrl+K finds a tool by name and runs it, and remembers it as recent', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);

  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'コマンド' });
  await expect(palette).toBeVisible();
  const search = palette.getByRole('combobox', { name: '機能を検索' });
  await expect(search).toBeFocused();

  // A button inside the closed ツール menu is found and run; kana not yet turned into kanji already finds it.
  await search.fill('zzz');
  await expect(palette.getByRole('option')).toHaveCount(0);
  await expect(palette.getByText('一致する機能がありません')).toBeVisible();
  await search.fill('きょり');
  await expect(palette.getByRole('option').first()).toContainText('距離を測る');
  await search.fill('距離');
  await expect(palette.getByRole('option').first()).toContainText('距離を測る');
  await expect(palette.getByRole('option').first()).toContainText('計測');
  await search.press('Enter');
  await expect(palette).toBeHidden();
  await expect(page.locator('#measure-distance')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('d');

  // The processing tools are there too, opening their dialog; the last one used comes first next time.
  await page.getByRole('button', { name: '機能を検索' }).click();
  await search.fill('ndvi');
  await search.press('Enter');
  await expect(page.getByRole('dialog', { name: /バンド演算/ })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+k');
  await expect(palette.getByRole('option').first()).toContainText('バンド演算');
  await expect(palette.getByRole('option').first()).toContainText('最近');
  await expect(palette.getByRole('option').nth(1)).toContainText('距離を測る');
  // Arrows move the choice, Ctrl+K again closes.
  await search.press('ArrowDown');
  await expect(palette.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+k');
  await expect(palette).toBeHidden();
});
