import { expect, test, type Page } from '@playwright/test';

/*
 * New layers: the person designs an empty temporary layer (geometry type and
 * attributes), draws on it at once, and finds it again after a reload.
 */

async function open(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

async function mapCenter(page: Page) {
  await page.waitForFunction(() => !window.viewer.map.getView().getAnimating());
  const box = (await page.locator('#map').boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const dialog = (page: Page) => page.getByRole('dialog', { name: '新規レイヤー' });
const rows = (page: Page) => page.locator('.attributes tbody tr[data-index]');

test('a designed layer opens empty, is drawn on at once with its defaults, and is kept over a reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await open(page);
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.getByRole('button', { name: '新規レイヤー…' }).click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  await d.getByLabel('レイヤーの名前').fill('調査地点');
  await d.getByLabel('ジオメトリ').selectOption({ label: 'ポイント' });
  // One text attribute to start from; a second one with allowed values and a default.
  await expect(d.getByLabel('属性名')).toHaveValue('name');
  await d.getByRole('button', { name: '＋ 属性を追加' }).click();
  const second = d.locator('.new-layer-field').nth(1);
  await second.getByLabel('属性名').fill('name');
  await second.getByLabel('型').selectOption({ label: '整数' });
  await d.getByRole('button', { name: '作成' }).click();
  // A duplicate name keeps the dialog open and says why.
  await expect(d.locator('.new-layer-note')).toContainText('属性「name」が重複');
  await second.getByLabel('属性名').fill('kind');
  await second.getByRole('button', { name: '詳細' }).click();
  await second.getByLabel('候補値').fill('1=住宅, 2=店舗');
  await second.getByLabel('既定値').fill('2');
  await d.getByRole('button', { name: '作成' }).click();
  await expect(d).toBeHidden();

  // Editing has started with the draw tool: one click adds a point that starts with the default.
  await expect(page.locator('#images li')).toContainText('調査地点');
  await expect(page.getByRole('toolbar', { name: '編集' })).toBeVisible();
  await expect(page.getByRole('button', { name: '追加', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.edit-kind')).toBeHidden();
  const at = await mapCenter(page);
  await page.mouse.click(at.x, at.y);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first().getByRole('combobox', { name: 'kind' })).toHaveValue('2');
  await rows(page).first().getByRole('textbox', { name: 'name' }).fill('A 地点');
  await rows(page).first().getByRole('textbox', { name: 'name' }).press('Enter');
  await page.locator('button[data-tool=save]').click();
  await expect(page.locator('#status')).toContainText('ブラウザに保存');

  await open(page);
  await expect(page.locator('#status')).toContainText('復元');
  await page.locator('#images li').first().click();
  await expect(page.locator('#info')).toContainText('ポイント');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('A 地点');
  await expect(rows(page).first()).toContainText('店舗');
  expect(errors).toEqual([]);
});

test('attributes and geometry type are copied from an open layer; "any" lets the toolbar choose', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await page.evaluate(() => {
    const text = JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[139.7, 35.6], [139.8, 35.7]] }, properties: { road: '国道', lanes: 2 } }],
    });
    const list = new DataTransfer();
    list.items.add(new File([text], 'roads.geojson'));
    const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
    input.files = list.files;
    input.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('#status')).toContainText('roads');
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.getByRole('button', { name: '新規レイヤー…' }).click();
  const d = dialog(page);
  await d.getByLabel('ほかのレイヤーの属性をコピー').selectOption({ label: 'roads' });
  await expect(d.getByLabel('属性名')).toHaveCount(2);
  await expect(d.getByLabel('属性名').nth(0)).toHaveValue('road');
  await expect(d.getByLabel('型').nth(1)).toHaveValue('double');
  await expect(d.getByLabel('ジオメトリ')).toHaveValue('LineString');
  await d.getByLabel('ジオメトリ').selectOption({ label: '指定なし（作図ごとに選択）' });
  await d.getByText('作成後すぐ地図に作図開始').click();
  await d.getByRole('button', { name: '作成' }).click();
  await expect(d).toBeHidden();
  await expect(page.getByRole('toolbar', { name: '編集' })).toBeVisible();
  await expect(page.getByRole('button', { name: '追加', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: '追加', exact: true }).click();
  await expect(page.locator('.edit-kind')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a template fills the design, which is changed before the layer is made; own designs are saved as templates', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.getByRole('button', { name: '新規レイヤー…' }).click();
  const d = dialog(page);
  await expect(d.getByLabel('テンプレート')).toHaveValue('0');
  await d.getByLabel('テンプレート').selectOption({ label: '航跡（生存圏計算用）' });
  await expect(d.locator('.new-layer-template-note')).toContainText('移動目標撮像計画');
  await expect(d.getByLabel('レイヤーの名前')).toHaveValue('航跡');
  await expect(d.getByLabel('ジオメトリ')).toHaveValue('Point');
  await expect(d.getByLabel('属性名')).toHaveCount(7);
  await expect(d.getByLabel('属性名').nth(0)).toHaveValue('track_id');
  await expect(d.getByLabel('型').nth(1)).toHaveValue('date');
  // Changed before making: one attribute less, another name.
  await d.locator('.new-layer-field').nth(6).getByRole('button', { name: 'この属性を削除' }).click();
  await d.getByLabel('レイヤーの名前').fill('不審船航跡');
  await d.locator('summary', { hasText: '詳細設定' }).click();
  await expect(d.getByRole('button', { name: 'テンプレートを削除' })).toBeHidden();
  await d.getByRole('button', { name: 'テンプレートとして保存' }).click();
  await expect(d.locator('.new-layer-note')).toContainText('テンプレート「不審船航跡」を保存');
  await d.getByText('作成後すぐ地図に作図開始').click();
  await d.getByRole('button', { name: '作成' }).click();
  await expect(d).toBeHidden();
  await expect(page.locator('#images li')).toContainText('不審船航跡');

  // The saved design comes back as a template next time, and can be removed.
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.getByRole('button', { name: '新規レイヤー…' }).click();
  await expect(d.getByLabel('属性名')).toHaveCount(1);
  await d.getByLabel('テンプレート').selectOption({ label: '不審船航跡' });
  await expect(d.getByLabel('属性名')).toHaveCount(6);
  await d.getByRole('button', { name: 'テンプレートを削除' }).click();
  await expect(d.getByLabel('テンプレート').locator('option', { hasText: '不審船航跡' })).toHaveCount(0);
  expect(errors).toEqual([]);
});
