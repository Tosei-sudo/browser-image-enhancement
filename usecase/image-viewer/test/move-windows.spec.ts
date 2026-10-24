import { expect, test, type Locator, type Page } from '@playwright/test';

/*
 * Windows dragged anywhere: the 撮像計画 panel and the 物体検出 dialog by
 * their title, the クリック抽出 panel over the map by its background. They
 * stay inside the screen (the map for the panel), keep their place when
 * opened again, and go back on a double click of the title.
 */

async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

const boxOf = async (locator: Locator) => (await locator.boundingBox())!;

async function drag(page: Page, handle: Locator, dx: number, dy: number) {
  const box = await boxOf(handle);
  const x = box.x + Math.min(20, box.width / 2);
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2);
  await page.mouse.move(x + dx, y + dy);
  await page.mouse.up();
}

async function tool(page: Page, id: string) {
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator(`#${id}`).click();
}

test('the imaging plan panel moves by its title, stays on screen and keeps its place', async ({ page }) => {
  await open(page);
  await tool(page, 'plan-open');
  const dialog = page.locator('.plan-dialog');
  await expect(dialog).toBeVisible();
  const title = dialog.locator('#plan-title');
  const before = await boxOf(dialog);

  await drag(page, title, -300, 120);
  await expect.poll(async () => (await boxOf(dialog)).x).toBeCloseTo(before.x - 300, 0);
  expect((await boxOf(dialog)).y).toBeCloseTo(before.y + 120, 0);
  // A drag on a control does not move it.
  const moved = await boxOf(dialog);
  await drag(page, dialog.locator('select[name=target]'), 100, 100);
  expect(await boxOf(dialog)).toEqual(moved);

  // Far off the screen: held at the edge, the title still reachable.
  await drag(page, title, -5000, -5000);
  await expect.poll(async () => (await boxOf(dialog)).x).toBe(0);
  expect((await boxOf(dialog)).y).toBe(0);

  // Closed and opened again: where it was left.
  await dialog.locator('.catalog-close').click();
  await expect(dialog).toBeHidden();
  await tool(page, 'plan-open');
  await expect(dialog).toBeVisible();
  expect((await boxOf(dialog)).x).toBe(0);

  // A smaller window pulls it back inside.
  await drag(page, title, 1000, 1000);
  const far = await boxOf(dialog);
  expect(far.x + far.width).toBeCloseTo(1280, 0);
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect.poll(async () => { const b = await boxOf(dialog); return b.x + b.width; }).toBeLessThanOrEqual(1000.5);

  // A double click of the title puts it back at the right.
  await title.dblclick();
  await expect.poll(async () => { const b = await boxOf(dialog); return Math.round(1000 - (b.x + b.width)); }).toBe(16);
});

test('the modal object detection dialog moves by its title', async ({ page }) => {
  await open(page);
  await tool(page, 'ai-detect');
  const dialog = page.locator('.ai-dialog');
  await expect(dialog).toBeVisible();
  // Centred until moved, so it shifts while the model's description fills in: wait for the last one.
  await expect(dialog.locator('.ai-model-info')).toContainText(/で実行|読み込み不可/, { timeout: 30_000 });
  const title = await boxOf(dialog.locator('h2'));
  const x = title.x + 20;
  const y = title.y + title.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const before = await boxOf(dialog);
  await page.mouse.move(x + 100, y - 20);
  await page.mouse.move(x + 200, y - 40);
  await page.mouse.up();
  const after = await boxOf(dialog);
  expect(after.x).toBeCloseTo(before.x + 200, 0);
  expect(after.y).toBeCloseTo(before.y - 40, 0);
  // Its buttons still work.
  await dialog.getByRole('button', { name: '閉じる' }).click();
  await expect(dialog).toBeHidden();
});

test('the click segmentation panel moves over the map and stays inside it', async ({ page }) => {
  await open(page);
  await tool(page, 'ai-segment');
  const panel = page.locator('.ai-segment-panel');
  await expect(panel).toBeVisible();
  const map = await boxOf(page.locator('#map'));
  const before = await boxOf(panel);
  await drag(page, panel.locator('.ai-segment-hint'), -150, 200);
  await expect.poll(async () => (await boxOf(panel)).x).toBeCloseTo(before.x - 150, 0);
  expect((await boxOf(panel)).y).toBeCloseTo(before.y + 200, 0);

  await drag(page, panel.locator('.ai-segment-hint'), 0, 5000);
  await expect.poll(async () => { const b = await boxOf(panel); return Math.round(b.y + b.height); }).toBeLessThanOrEqual(Math.round(map.y + map.height));
  // Its buttons still work.
  await panel.getByRole('button', { name: '終了' }).click();
  await expect(panel).toBeHidden();
});
