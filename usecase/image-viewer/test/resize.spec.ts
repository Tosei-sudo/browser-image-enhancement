import { expect, test, type Page } from '@playwright/test';

/*
 * The layer panel width and the attribute table height: dragged, kept for
 * the next visit, back to the default on a double click.
 */

async function open(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

const width = (page: Page, selector: string) => page.locator(selector).evaluate((e) => e.getBoundingClientRect().width);
const height = (page: Page, selector: string) => page.locator(selector).evaluate((e) => e.getBoundingClientRect().height);

async function drag(page: Page, selector: string, dx: number, dy: number) {
  const box = (await page.locator(selector).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2);
  await page.mouse.move(x + dx, y + dy);
  await page.mouse.up();
}

test('the layer panel width follows the handle and is kept', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  const side = await width(page, '.side');
  const map = await width(page, '#map');
  await drag(page, '#side-resize', 120, 0);
  await expect.poll(() => width(page, '.side')).toBeCloseTo(side + 120, -1);
  await expect.poll(() => width(page, '#map')).toBeCloseTo(map - 120, -1);
  // The map canvas follows the new size.
  await expect.poll(() => page.evaluate(() => window.viewer.map.getSize()![0])).toBeCloseTo(map - 120, -1);

  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);
  expect(await width(page, '.side')).toBeCloseTo(side + 120, -1);

  await page.locator('#side-resize').dblclick();
  await expect.poll(() => width(page, '.side')).toBeCloseTo(side, 0);
  // Too narrow is held at the smallest width.
  await drag(page, '#side-resize', -400, 0);
  await expect.poll(() => width(page, '.side')).toBe(160);
});

test('the attribute table height follows the handle and is kept', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  const table = await height(page, '.table-scroll');
  const map = await height(page, '#map');
  await drag(page, '.table-resize', 0, -100);
  await expect.poll(() => height(page, '.table-scroll')).toBeCloseTo(table + 100, -1);
  await expect.poll(() => height(page, '#map')).toBeCloseTo(map - 100, -1);

  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);
  expect(await height(page, '.table-scroll')).toBeCloseTo(table + 100, -1);

  // The keyboard too.
  await page.locator('.table-resize').focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => height(page, '.table-scroll')).toBeCloseTo(table + 100 - 16, -1);
  await page.locator('.table-resize').dblclick();
  await expect.poll(() => height(page, '.table-scroll')).toBeCloseTo(table, 0);
});
