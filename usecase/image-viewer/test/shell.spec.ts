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
    await guide.getByRole('button', { name: '開始' }).click();
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

  test('the guide can turn the explanations of the controls on', async ({ page }) => {
    await open(page);
    await page.getByRole('region', { name: 'はじめに' }).getByRole('button', { name: 'ボタンの説明を表示' }).click();
    await expect(page.getByRole('region', { name: 'はじめに' })).toBeHidden();
    await page.locator('#add-service').hover();
    await expect(page.getByRole('tooltip')).toContainText('インターネット上の地図サービス');
  });
});

test('the click tools are in one menu, marked while one is on, with single-key shortcuts', async ({ page }) => {
  await open(page);
  const menu = page.getByRole('button', { name: 'ツール' });
  const distance = page.locator('#measure-distance');
  await expect(distance).toBeHidden();
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: '距離計測' }).click();
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
  const field = page.getByRole('combobox', { name: '座標・地名へ移動' });
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

test('the menu lays its groups out in columns that fit the window, and ← → move between them', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await open(page);
  const menu = page.getByRole('button', { name: 'ツール' });
  await menu.click();
  const panel = page.locator('#tools-panel');
  const box = (await panel.boundingBox())!;
  // Wider than tall, and inside the window.
  expect(box.width).toBeGreaterThan(box.height);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1280);
  expect(box.y + box.height).toBeLessThanOrEqual(720);
  const columns = panel.locator('.menu-column');
  const left = await Promise.all((await columns.all()).map(async (c) => (await c.boundingBox())!.x));
  expect(new Set(left).size).toBe(left.length);

  await menu.press('ArrowDown');
  await expect(page.locator('#measure-distance')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#measure-area')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#gp-open')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#measure-area')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#print')).toBeFocused();

  // A narrow window: the columns wrap and the menu scrolls instead of leaving the window.
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 420, height: 500 });
  await menu.click();
  const narrow = (await panel.boundingBox())!;
  expect(narrow.x).toBeGreaterThanOrEqual(0);
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(420);
  expect(narrow.y + narrow.height).toBeLessThanOrEqual(500);
  await page.locator('#theme-choices button').first().scrollIntoViewIfNeeded();
  await expect(page.locator('#theme-choices button').first()).toBeInViewport();
});

test('? lists the shortcuts', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Shift+?');
  const help = page.getByRole('dialog', { name: '使い方とショートカット' });
  await expect(help).toBeVisible();
  await help.getByRole('tab', { name: 'ショートカット' }).click();
  await expect(help).toContainText('距離計測');
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
  // The toggle event (which saves it) comes a moment after the click.
  await page.waitForFunction(() => localStorage.getItem('image-viewer.fold.info') === 'closed');
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

test('「?」 finds a task by plain words, with its steps, and points at its button', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '?' }).click();
  const help = page.getByRole('dialog', { name: '使い方とショートカット' });
  await expect(help.getByRole('tab', { name: 'やりたいこと' })).toHaveAttribute('aria-selected', 'true');

  // Kana finds the kanji, and the words of a task's steps count too.
  await help.getByRole('searchbox', { name: 'ヘルプを検索' }).fill('きょり');
  const topic = help.locator('.help-results .help-topic', { hasText: '距離・面積の計測' });
  await expect(topic).toBeVisible();
  await help.getByRole('searchbox', { name: 'ヘルプを検索' }).fill('暗い');
  await expect(help.locator('.help-results')).toContainText('画像の明るさ・鮮明さの調整');
  await help.getByRole('searchbox', { name: 'ヘルプを検索' }).fill('ばんど');
  await expect(help.locator('.help-results .help-terms')).toContainText('バンド');
  await help.getByRole('searchbox', { name: 'ヘルプを検索' }).fill('ぜんぜんない言葉');
  await expect(help.locator('.help-results')).toContainText('該当なし');

  // 「場所を表示」 opens the menu the button is in and rings it.
  await help.getByRole('searchbox', { name: 'ヘルプを検索' }).fill('');
  const measure = help.locator('#help-panel-topics .help-topic', { hasText: '距離・面積の計測' });
  await measure.locator('summary').click();
  await expect(measure.locator('ol')).toContainText('ダブルクリックで終了');
  await measure.getByRole('button', { name: '場所を表示' }).click();
  await expect(help).toBeHidden();
  await expect(page.locator('#measure-distance')).toBeVisible();
  await expect(page.locator('.help-spot-caption')).toHaveText('ここ: 距離・面積の計測');
  const ring = (await page.locator('.help-spot').boundingBox())!;
  const button = (await page.locator('#measure-distance').boundingBox())!;
  expect(Math.abs(ring.x + ring.width / 2 - (button.x + button.width / 2))).toBeLessThan(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('.help-spot')).toHaveCount(0);

  // A button that is not there yet (no layer open): the dialog says why instead.
  await page.getByRole('button', { name: '?' }).click();
  const colorize = help.locator('#help-panel-topics .help-topic', { hasText: '白黒画像の着色' });
  await colorize.locator('summary').click();
  await colorize.getByRole('button', { name: '場所を表示' }).click();
  await expect(help).toBeVisible();
  await expect(help.getByRole('status')).toContainText('画像なし（先に画像を開く）');

  // The tab used last is the one it opens on.
  await help.getByRole('tab', { name: '用語' }).click();
  await expect(help.getByRole('tabpanel')).toContainText('オルソ補正');
  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.keyboard.press('Shift+?');
  await expect(help.getByRole('tab', { name: '用語' })).toHaveAttribute('aria-selected', 'true');
});

test('the explanations of the controls are off until turned on, and stay as chosen', async ({ page }) => {
  await open(page);
  const add = page.locator('#add-service');
  const tooltip = page.getByRole('tooltip');
  await add.hover();
  await page.waitForTimeout(400);
  await expect(tooltip).toBeHidden();

  await page.getByRole('button', { name: '?' }).click();
  const help = page.getByRole('dialog', { name: '使い方とショートカット' });
  await help.getByLabel('ボタンやスライダーに説明を出す（初心者向け）').check();
  await help.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.mouse.move(700, 400);
  await add.hover();
  await expect(tooltip).toContainText('サービスを追加');
  await expect(tooltip).toContainText('WMS・WMTS・WFS・ArcGIS');

  // Its own tooltip is kept aside while the bubble shows (so the two do not overlap), and put back after.
  const distance = page.locator('#measure-distance');
  await page.getByRole('button', { name: 'ツール' }).click();
  await distance.hover();
  await expect(tooltip).toContainText('測地線');
  await expect(tooltip.locator('kbd')).toHaveText('D');
  await expect(distance).toHaveAttribute('title', '');
  await page.mouse.move(700, 600);
  await expect(tooltip).toBeHidden();
  await expect(distance).toHaveAttribute('title', /測地線/);
  await page.keyboard.press('Escape');

  // The sliders of the correction panel, which have no tooltip of their own.
  await page.locator('.ol-enhance-row', { hasText: 'コントラスト' }).first().hover();
  await expect(tooltip).toContainText('くっきり');

  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);
  expect(await page.evaluate(() => window.viewer.hints.isEnabled())).toBe(true);
  // Ctrl+K turns it off again.
  await page.keyboard.press('Control+k');
  await page.keyboard.type('ボタンの説明');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.viewer.hints.isEnabled())).toBe(false);
  await add.hover();
  await page.waitForTimeout(400);
  await expect(tooltip).toBeHidden();
});
