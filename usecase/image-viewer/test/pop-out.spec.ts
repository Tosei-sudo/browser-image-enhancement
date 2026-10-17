import { expect, test, type Page } from '@playwright/test';

/*
 * 別ウィンドウで開く: the ⧉ at a dialog's title moves it into a window of its
 * own, still working from the page; closing that window brings it back, and
 * closing the dialog closes the window.
 */

async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

async function tool(page: Page, id: string) {
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator(`#${id}`).click();
}

test('the imaging plan panel goes out into its own window and comes back', async ({ page }) => {
  await open(page);
  await tool(page, 'plan-open');
  const dialog = page.locator('.plan-dialog');
  await expect(dialog).toBeVisible();
  const button = dialog.locator('.pop-out-button');
  await expect(button).toHaveAttribute('aria-label', '別ウィンドウで開く');

  const [popup] = await Promise.all([page.waitForEvent('popup'), button.click()]);
  await expect(dialog).toHaveCount(0);
  const out = popup.locator('dialog.plan-dialog');
  await expect(out).toBeVisible();
  await expect(popup).toHaveTitle(/撮像計画/);
  // The page's styles and theme came along.
  expect(await popup.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(await page.evaluate(() => getComputedStyle(document.body).backgroundColor));
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await expect(popup.locator('html')).toHaveAttribute('data-theme', 'dark');
  // It fills the window.
  const size = await popup.evaluate(() => [innerWidth, document.querySelector('dialog')!.getBoundingClientRect().width]);
  expect(size[1]).toBeCloseTo(size[0], 0);
  // Its controls still work from the page: 計算 fills the list there.
  await out.locator('.catalog-search').click();
  await expect(out.locator('.service-status')).not.toBeEmpty();

  // ↩ brings it back into the tab, still open.
  await out.locator('.pop-out-button').click();
  await expect(dialog).toBeVisible();
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(button).toHaveAttribute('aria-label', '別ウィンドウで開く');

  // The menu item that closes it closes its window too.
  const [third] = await Promise.all([page.waitForEvent('popup'), button.click()]);
  await tool(page, 'plan-open');
  await expect.poll(() => third.isClosed()).toBe(true);
  await expect(dialog).toBeHidden();
  await tool(page, 'plan-open');
  await expect(dialog).toBeVisible();

  // Out again, then its × closes both.
  const [again] = await Promise.all([page.waitForEvent('popup'), button.click()]);
  await again.locator('.catalog-close').click();
  await expect.poll(() => again.isClosed()).toBe(true);
  await expect(dialog).toHaveCount(1);
  await expect(dialog).toBeHidden();
});

test('a modal dialog out in its window leaves the tab usable and is modal again when the window closes', async ({ page }) => {
  await open(page);
  await tool(page, 'ai-detect');
  const dialog = page.locator('.ai-dialog');
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((d) => d.matches(':modal'))).toBe(true);
  const [popup] = await Promise.all([page.waitForEvent('popup'), dialog.locator('.pop-out-button').click()]);
  await expect(popup.locator('dialog.ai-dialog')).toBeVisible();
  // The tab is no longer held by it, and its menu item shows the window rather than failing on an open dialog.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await tool(page, 'ai-detect');
  await expect(page.locator('.ai-dialog')).toHaveCount(0);
  expect(errors).toEqual([]);

  await popup.close();
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((d) => d.matches(':modal'))).toBe(true);

  // Esc in its window closes it, as in the tab.
  const [again] = await Promise.all([page.waitForEvent('popup'), dialog.locator('.pop-out-button').click()]);
  await again.locator('dialog h2').click();
  await again.keyboard.press('Escape');
  await expect.poll(() => again.isClosed()).toBe(true);
  await expect(dialog).toBeHidden();
});
