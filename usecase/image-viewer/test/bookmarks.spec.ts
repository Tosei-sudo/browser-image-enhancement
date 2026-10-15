import { expect, test, type Page } from '@playwright/test';

/*
 * Bookmarks: named views kept in the browser, and the view in the address
 * (`#view=`) so a link opens on the same place.
 */

async function open(page: Page, hash = '') {
  await page.goto(`/index.html${hash}`);
  await page.waitForFunction(() => window.viewer !== undefined);
}

const center = (page: Page) =>
  page.evaluate(() => {
    const view = window.viewer.map.getView();
    return { center: view.getCenter()!, zoom: view.getZoom()!, rotation: view.getRotation() };
  });

test('a bookmark keeps the view under a name and goes back to it, and survives a reload', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const view = window.viewer.map.getView();
    view.setCenter([15559000, 4257000]);
    view.setZoom(12);
    view.setRotation(0.5);
  });
  // M adds one and offers its name to edit.
  await page.locator('#map').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('m');
  const name = page.getByRole('textbox', { name: 'ブックマークの名前' });
  await expect(name).toBeFocused();
  await name.fill('東京駅');
  await name.press('Enter');
  await expect(page.getByRole('button', { name: '東京駅', exact: true })).toBeVisible();

  await page.evaluate(() => {
    const view = window.viewer.map.getView();
    view.setCenter([0, 0]);
    view.setZoom(3);
    view.setRotation(0);
  });
  await page.getByRole('button', { name: '東京駅', exact: true }).click();
  await expect.poll(async () => (await center(page)).zoom).toBeCloseTo(12, 3);
  const at = await center(page);
  expect(at.center[0]).toBeCloseTo(15559000, -1);
  expect(at.rotation).toBeCloseTo(0.5, 5);

  // The address follows the view.
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#view=35\.\d+,139\.\d+,12,28\.6$/);

  // Still there after a reload; rename and delete in the menu.
  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.locator('#bookmark-menu .menu-button').click();
  await page.getByRole('button', { name: '東京駅 の名前を変更' }).click();
  await page.getByRole('textbox', { name: 'ブックマークの名前' }).fill('丸の内');
  await page.getByRole('textbox', { name: 'ブックマークの名前' }).press('Enter');
  await expect(page.getByRole('button', { name: '丸の内', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '丸の内 を削除' }).click();
  await expect(page.getByRole('button', { name: '丸の内', exact: true })).toHaveCount(0);
  await expect(page.locator('.bookmark-empty')).toBeVisible();
});

test('a link with #view= opens on that place', async ({ page }) => {
  await open(page, '#view=35.6812,139.7671,14.5,90');
  const at = await center(page);
  expect(at.zoom).toBeCloseTo(14.5, 3);
  expect(at.rotation).toBeCloseTo(Math.PI / 2, 5);
  // Web Mercator x of 139.7671°E.
  expect(at.center[0]).toBeCloseTo((139.7671 * 20037508.342789244) / 180, -1);
});
