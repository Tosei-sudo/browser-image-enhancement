import { expect, test, type Page } from '@playwright/test';

/*
 * 別ウィンドウで開く: the ⧉ at a dialog's title moves it into a window of its
 * own, still working from the page; ↩ brings it back, closing that window
 * closes it (as its × does, which closes the window too), and its title
 * dragged onto the tab docks it there.
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

test('a modal dialog out in its window leaves the tab usable and closes with its window', async ({ page }) => {
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

  // Closing the window closes it: back in the tab, closed, and it opens again as before.
  await popup.close();
  await expect(dialog).toHaveCount(1);
  await expect(dialog).toBeHidden();
  await tool(page, 'ai-detect');
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((d) => d.matches(':modal'))).toBe(true);

  // Esc in its window closes it, as in the tab.
  const [again] = await Promise.all([page.waitForEvent('popup'), dialog.locator('.pop-out-button').click()]);
  await again.locator('dialog h2').click();
  await again.keyboard.press('Escape');
  await expect.poll(() => again.isClosed()).toBe(true);
  await expect(dialog).toBeHidden();
});

/** Drags the dialog's title out of `popup` and drops it on the page at (x, y), as the browser does across windows. */
async function dragOut(popup: Page, page: Page, x: number, y: number) {
  await popup.evaluate(() => {
    const title = document.querySelector<HTMLElement>('dialog h2, dialog .catalog-head')!;
    const dataTransfer = new DataTransfer();
    (window.opener as Window & { __drag?: DataTransfer }).__drag = dataTransfer;
    title.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
  });
  return page.evaluate(([x, y]) => {
    const dataTransfer = (window as Window & { __drag?: DataTransfer }).__drag!;
    const at = document.elementFromPoint(x, y)!;
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer });
    at.dispatchEvent(over);
    const preview = document.querySelector('.dock-drop-external') !== null;
    at.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer }));
    return { accepted: over.defaultPrevented, preview };
  }, [x, y] as const);
}

test('a window dragged onto the tab docks where it is dropped, or floats over the map', async ({ page }) => {
  await open(page);
  await tool(page, 'plan-open');
  const dialog = page.locator('.plan-dialog');
  const [popup] = await Promise.all([page.waitForEvent('popup'), dialog.locator('.pop-out-button').click()]);
  await expect(popup.locator('dialog.plan-dialog')).toBeVisible();
  await expect(popup.locator('dialog.plan-dialog .catalog-head')).toHaveAttribute('draggable', 'true');

  // Dropped at the map's right edge: docked on the right, and its window gone.
  const map = (await page.locator('.map').boundingBox())!;
  const result = await dragOut(popup, page, map.x + map.width - 10, map.y + map.height / 2);
  expect(result).toEqual({ accepted: true, preview: true });
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(page.locator('.dock-right dialog.plan-dialog.docked')).toBeVisible();
  await expect(page.locator('.dock-drop-external')).toHaveCount(0);

  // Back into a window of its own (its menu), out again, then dropped mid-map: a window over the map there.
  await page.locator('.plan-dialog .dock-button').click();
  await page.getByRole('menuitem', { name: 'ウィンドウに復帰' }).click();
  await expect(page.locator('.plan-dialog')).not.toHaveClass(/docked/);
  const [again] = await Promise.all([page.waitForEvent('popup'), dialog.locator('.pop-out-button').click()]);
  await expect(again.locator('dialog.plan-dialog')).toBeVisible();
  const x = map.x + map.width / 2;
  const y = map.y + map.height / 2;
  expect((await dragOut(again, page, x, y)).accepted).toBe(true);
  await expect.poll(() => again.isClosed()).toBe(true);
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toHaveClass(/docked/);
  const box = (await dialog.boundingBox())!;
  expect(Math.abs(box.x - (x - 40))).toBeLessThan(2);
  expect(Math.abs(box.y - (y - 12))).toBeLessThan(2);
});

test('the dock menu of a window of its own docks it in the tab', async ({ page }) => {
  await open(page);
  await tool(page, 'plan-open');
  const dialog = page.locator('.plan-dialog');
  const [popup] = await Promise.all([page.waitForEvent('popup'), dialog.locator('.pop-out-button').click()]);
  const out = popup.locator('dialog.plan-dialog');
  await expect(out.locator('.dock-button')).toBeVisible();
  await out.locator('.dock-button').click();
  await popup.getByRole('menuitem', { name: '下に配置' }).click();
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(page.locator('.dock-bottom dialog.plan-dialog.docked')).toBeVisible();
});
