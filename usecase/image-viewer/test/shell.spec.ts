import { expect, test, type Page } from '@playwright/test';

/*
 * The shell: the 「ツール」 menu, folding side panel sections, the guide of a
 * first visit and the 「?」 dialog of shortcuts.
 */

async function open(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

test.describe('a first visit', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('shows the guide once, and 「?」 brings it back', async ({ page }) => {
    await open(page);
    const guide = page.getByRole('region', { name: 'はじめに' });
    await expect(guide).toBeVisible();
    await guide.getByRole('button', { name: 'はじめる' }).click();
    await expect(guide).toBeHidden();
    await page.reload();
    await page.waitForFunction(() => window.viewer !== undefined);
    await expect(guide).toBeHidden();

    await page.getByRole('button', { name: '?' }).click();
    const help = page.getByRole('dialog', { name: '使い方とショートカット' });
    await expect(help).toBeVisible();
    await help.getByRole('button', { name: 'はじめにのガイドを表示' }).click();
    await expect(help).toBeHidden();
    await expect(guide).toBeVisible();
  });
});

test('the click tools are in one menu, marked while one is on, with single-key shortcuts', async ({ page }) => {
  await open(page);
  const menu = page.getByRole('button', { name: 'ツール' });
  const distance = page.locator('#measure-distance');
  await expect(distance).toBeHidden();
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: '距離を測る' }).click();
  // Choosing closes the menu; its button shows a tool is on.
  await expect(distance).toBeHidden();
  await expect(distance).toHaveAttribute('aria-pressed', 'true');
  await expect(menu).toHaveClass(/active/);

  // The same key turns it off, A turns area on, P points (which turns measuring off).
  await page.keyboard.press('a');
  await expect(page.locator('#measure-area')).toHaveAttribute('aria-pressed', 'true');
  await expect(distance).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('a');
  await expect(page.locator('#measure-area')).toHaveAttribute('aria-pressed', 'false');
  await expect(menu).not.toHaveClass(/active/);
  await page.keyboard.press('p');
  await expect(page.locator('#add-point')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('p');

  // Keys typed in a field are text, not shortcuts; / goes to the coordinate field.
  await page.keyboard.press('/');
  const field = page.getByRole('textbox', { name: '座標へ移動' });
  await expect(field).toBeFocused();
  await page.keyboard.type('da');
  await expect(field).toHaveValue('da');
  await expect(distance).toHaveAttribute('aria-pressed', 'false');

  // Esc and a click elsewhere close the menu.
  await menu.click();
  await expect(distance).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(distance).toBeHidden();
  await expect(menu).toBeFocused();
  await menu.click();
  await page.locator('#status').click({ force: true });
  await expect(distance).toBeHidden();
});

test('? lists the shortcuts', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Shift+?');
  const help = page.getByRole('dialog', { name: '使い方とショートカット' });
  await expect(help).toBeVisible();
  await expect(help).toContainText('距離を測る');
  await expect(help).toContainText('属性テーブル');
  // Keys do nothing while the dialog is open.
  await page.keyboard.press('d');
  await expect(page.locator('#measure-distance')).toHaveAttribute('aria-pressed', 'false');
  await help.getByRole('button', { name: '閉じる' }).click();
  await expect(help).toBeHidden();
});

test('side panel sections fold, remember it, and points show once there are some', async ({ page }) => {
  await open(page);
  const info = page.locator('details[data-fold="info"]');
  await expect(info).toHaveAttribute('open', '');
  await info.locator('summary').click();
  await expect(info).not.toHaveAttribute('open');
  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);
  await expect(info).not.toHaveAttribute('open');

  // Geometric correction is folded until it has something to do.
  await expect(page.locator('details[data-fold="geometry"]')).not.toHaveAttribute('open');

  const points = page.locator('details[data-fold="points"]');
  await expect(points).toBeHidden();
  await page.evaluate(() => document.getElementById('points')!.append(document.createElement('li')));
  await expect(points).toBeVisible();
  await expect(points).toHaveAttribute('open', '');
});
