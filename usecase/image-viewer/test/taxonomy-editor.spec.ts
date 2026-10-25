import { expect, test, type Page } from '@playwright/test';
import { plainGeoTiff } from './fixtures.js';

/*
 * 「分類体系の編集」: the classification of the observations' kinds edited as
 * a tree (add, rename in place, drag to move and reorder, delete), with each
 * class's specifications and photos, which the recording form then shows.
 */

/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function openEditor(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#taxonomy-open').click();
  const editor = page.locator('.taxed-dialog');
  await expect(editor).toBeVisible();
  return editor;
}

const kinds = (page: Page) => page.evaluate(() => window.viewer.observations.taxonomy().map((t) => t.path.join(' > ')));
const row = (editor: ReturnType<Page['locator']>, name: string) => editor.locator('.taxed-row', { has: editor.page().locator('.taxed-name', { hasText: new RegExp(`^${name}$`) }) });

test('classes are added, renamed in place, moved by dragging and deleted', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const editor = await openEditor(page);
  // The default classes, each a top class.
  await expect(row(editor, '船舶')).toBeVisible();
  await expect(row(editor, '船舶')).toContainText('大分類');

  // ＋ on a class: a name typed where it will be; 「A > B」 adds levels at once.
  await row(editor, '船舶').click();
  await row(editor, '船舶').getByRole('button', { name: '種別の追加' }).click();
  await editor.locator('.taxed-add input').fill('支援船 > 〇〇級');
  await editor.locator('.taxed-add input').press('Enter');
  await expect(row(editor, '〇〇級')).toBeVisible();
  await expect(row(editor, '〇〇級')).toHaveAttribute('aria-level', '3');
  await row(editor, '船舶').getByRole('button', { name: '種別の追加' }).click();
  await editor.locator('.taxed-add input').fill('護衛艦');
  await editor.locator('.taxed-add input').press('Enter');
  await expect(row(editor, '護衛艦')).toBeVisible();

  // F2 renames where it stands.
  await row(editor, '支援船').click();
  await page.keyboard.press('F2');
  await editor.locator('.taxed-row input').fill('補助艦');
  await page.keyboard.press('Enter');
  await expect(row(editor, '補助艦')).toBeVisible();
  expect(await kinds(page)).toContain('船舶 > 補助艦 > 〇〇級');

  // Dragged onto the middle of a class: below it; onto its top edge: before it.
  await row(editor, '〇〇級').dragTo(row(editor, '護衛艦'));
  await expect(row(editor, '〇〇級')).toHaveAttribute('aria-level', '3');
  expect(await kinds(page)).toContain('船舶 > 護衛艦 > 〇〇級');
  await row(editor, '護衛艦').dragTo(row(editor, '補助艦'), { targetPosition: { x: 20, y: 2 } });
  const order = await kinds(page);
  expect(order.indexOf('船舶 > 護衛艦')).toBeLessThan(order.indexOf('船舶 > 補助艦'));
  // Alt+↓ moves it back down among its siblings.
  await row(editor, '護衛艦').click();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(async () => (await kinds(page)).indexOf('船舶 > 護衛艦')).toBeGreaterThan((await kinds(page)).indexOf('船舶 > 補助艦'));

  // Two clicks delete a class with its branch.
  await row(editor, '補助艦').click();
  const remove = row(editor, '補助艦').getByRole('button', { name: /^削除/ });
  await remove.click();
  await expect(editor.locator('.service-status')).toContainText('もう一度で「船舶 > 補助艦」を削除');
  await remove.click();
  await expect(row(editor, '補助艦')).toHaveCount(0);
  // Kept in the browser.
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('image-viewer.obs-taxonomy:このブラウザ') ?? '[]') as Array<{ path: string[] }>);
  expect(kept.map((t) => t.path.join(' > '))).toContain('船舶 > 護衛艦 > 〇〇級');
  expect(errors).toEqual([]);
});

test('specifications and photos of a class stand for its branch and show when recording', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const editor = await openEditor(page);
  await page.evaluate(() => window.viewer.observations.addClass(['船舶', '支援船', '〇〇級']));
  await row(editor, '支援船').click();
  const detail = editor.locator('.taxed-detail');
  await detail.locator('input[name="spec-別名"]').fill('補給艦、AOE');
  await detail.locator('input[name="spec-全長"]').fill('221');
  await detail.locator('input[name="spec-開発国"]').fill('日本');
  await detail.getByRole('button', { name: '変更', exact: true }).click();
  await expect(editor.locator('.service-status')).toContainText('分類「船舶 > 支援船」を変更');
  await detail.locator('input[name=photo-file]').setInputFiles({ name: 'ship.png', mimeType: 'image/png', buffer: PNG });
  await expect(editor.locator('.service-status')).toContainText('参考写真 1 枚を追加');
  await expect(detail.locator('.taxed-photo img')).toHaveCount(1);

  // Below, the values show as what the class above says, until this class says otherwise.
  await row(editor, '〇〇級').click();
  await expect(detail.locator('input[name="spec-全長"]')).toHaveAttribute('placeholder', '221 m（支援船）');
  await detail.locator('input[name="spec-全長"]').fill('167');
  await detail.locator('input[name="spec-全長"]').press('Enter');
  await expect(editor.locator('.service-status')).toContainText('分類「船舶 > 支援船 > 〇〇級」を変更');
  await expect(detail.locator('.taxed-photo.inherited img')).toHaveCount(1);

  // A field of the user's own.
  await editor.locator('.taxed-fields > summary').click();
  await editor.getByRole('button', { name: '項目の追加' }).click();
  await editor.locator('.taxed-field-table tbody tr:last-child input').first().fill('艦番号');
  await editor.getByRole('button', { name: '項目の保存' }).click();
  await expect(editor.locator('.service-status')).toContainText('諸元の項目');
  await expect(detail.locator('input[name="spec-艦番号"]')).toBeVisible();

  // Searching finds a class by another name.
  await editor.locator('input[name=q]').fill('AOE');
  await expect(editor.locator('.taxed-row.hit')).toHaveText(/支援船/);
  await editor.locator('input[name=q]').fill('');
  await editor.locator('.catalog-close').click();

  // Recording: another name typed as the kind brings the class; its specifications and photo show under it.
  const bytes = Array.from(plainGeoTiff(400, 300));
  await page.evaluate(async (data) => {
    await window.viewer.project.openFiles([new File([new Uint8Array(data)], 'site_20261003.tif', { type: 'image/tiff' })]);
  }, bytes);
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#observe-open').click();
  const panel = page.locator('.obs-dialog');
  await page.evaluate(() => {
    const map = window.viewer.map;
    const view = map.getView();
    const size = map.getSize()!;
    view.centerOn(view.getCenter()!, size, [size[0] / 4, size[1] / 2]);
  });
  const map = page.locator('#map');
  const box = (await map.boundingBox())!;
  await map.click({ position: { x: box.width / 4, y: box.height / 2 } });
  const kind = panel.locator('.obs-form input[name=kind]');
  await kind.fill('補給艦');
  await kind.dispatchEvent('change');
  await expect(kind).toHaveValue('船舶 > 支援船');
  await panel.locator('.obs-kind-path').getByRole('button', { name: '〇〇級' }).click();
  const specs = panel.locator('.obs-kind-specs');
  await expect(specs).toContainText('別名 補給艦、AOE');
  await expect(specs).toContainText('全長 167 m');
  await expect(specs).toContainText('開発国 日本');
  await expect(specs.locator('.taxon-photo img')).toHaveCount(1);
  await specs.locator('.taxon-photo').click();
  await expect(page.locator('.taxon-photo-view img')).toBeVisible();
  expect(errors).toEqual([]);
});
