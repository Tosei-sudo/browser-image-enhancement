import { expect, test, type Page } from '@playwright/test';

/*
 * Field aliases: an Esri layer's aliases head the attribute table and name
 * the attributes in the query dialog (the SQL keeps the names); the person
 * changes an alias in the table (kept in the project) or shows the names;
 * a new layer's attributes get aliases in its dialog.
 */

const base = 'http://localhost:4175';

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.request.get(`${base}/svc/reset`);
  await page.route(/cyberjapandata\.gsi\.go\.jp|tile\.openstreetmap\.org/, (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  return errors;
}

const headings = (page: Page) => page.locator('#table .attributes thead th:not(.check)').allTextContents();

test('aliases head the table and the query choices, can be changed and are kept in the project', async ({ page }) => {
  const errors = await open(page);
  await page.getByRole('button', { name: 'サービスを追加' }).click();
  const add = page.getByRole('dialog', { name: 'サービスを追加' });
  await add.getByRole('textbox', { name: 'サービスの URL' }).fill(`${base}/svc/arcgis/rest/services/Test/FeatureServer`);
  await add.getByRole('button', { name: '読み込み' }).click();
  await add.locator('.service-layer input[type=checkbox]').first().check();
  await add.getByRole('button', { name: '追加', exact: true }).click();
  await expect(add).toBeHidden();
  await expect(page.locator('#table .attributes thead')).toContainText('名称');
  expect(await headings(page)).toEqual(['OBJECTID', '名称', '種別', '面積', '編集者']);

  // The query dialog names the attributes by alias; the SQL keeps the names.
  await page.locator('#table').getByRole('button', { name: '条件' }).click();
  const dialog = page.locator('dialog.query-dialog');
  const field = dialog.locator('.query-condition').first().getByLabel('フィールド');
  await expect(field.locator('option', { hasText: '名称（NAME）' })).toHaveCount(1);
  await dialog.getByRole('tab', { name: 'SQL' }).click();
  await dialog.locator('.query-fields button', { hasText: '面積' }).click();
  await expect(dialog.getByLabel('SQL（WHERE 句）')).toHaveValue(/AREA/);
  await dialog.getByRole('button', { name: '閉じる' }).click();

  // An alias changed from the 「列」 list, and back to the service's on blank.
  await page.locator('#table .table-columns summary').click();
  await page.getByRole('button', { name: 'KIND のエイリアスを変更' }).click();
  const input = page.getByLabel('KIND のエイリアス');
  await input.fill('用途');
  await input.press('Enter');
  expect(await headings(page)).toEqual(['OBJECTID', '名称', '用途', '面積', '編集者']);
  await page.locator('#table .table-columns summary').click();
  // From a heading's menu, and the names instead of the aliases.
  await page.locator('#table .attributes thead th', { hasText: '面積' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '属性名で表示' }).click();
  expect(await headings(page)).toEqual(['OBJECTID', 'NAME', 'KIND', 'AREA', 'EDITOR']);
  await page.locator('#table .table-columns summary').click();
  await page.getByRole('checkbox', { name: '属性名で表示' }).uncheck();
  expect(await headings(page)).toEqual(['OBJECTID', '名称', '用途', '面積', '編集者']);
  await page.locator('#table .table-columns summary').click();

  // Kept in the project and given back when it is opened again (the layer read anew from the service).
  const saved = await page.evaluate(() => window.viewer.project.collect().project.layers[0].aliases);
  expect(saved).toEqual({ KIND: '用途' });
  await page.evaluate(async () => {
    const project = window.viewer.project;
    await project.open(project.collect().project, 'test.ivproj');
  });
  await expect(page.locator('#table .attributes thead')).toContainText('用途');

  // Blank: the service's alias again, and nothing left to keep.
  await page.locator('#table .attributes thead th', { hasText: '用途' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'エイリアスの変更…' }).click();
  await page.getByLabel('KIND のエイリアス').fill('');
  await page.getByLabel('KIND のエイリアス').press('Enter');
  await expect(page.locator('#table .attributes thead')).toContainText('種別');
  expect(await page.evaluate(() => window.viewer.project.collect().project.layers[0].aliases)).toBeUndefined();
  expect(errors).toEqual([]);
});

test('a new layer gets aliases for its attributes in its dialog', async ({ page }) => {
  const errors = await open(page);
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.getByRole('button', { name: '新規レイヤー…' }).click();
  const d = page.getByRole('dialog', { name: '新規レイヤー' });
  await d.getByLabel('レイヤーの名前').fill('調査');
  await expect(d.getByLabel('属性名')).toHaveValue('name');
  await d.getByLabel('エイリアス').fill('名称');
  await d.getByLabel('作成後すぐ地図に作図開始').uncheck();
  await d.getByRole('button', { name: '作成' }).click();
  await expect(d).toBeHidden();
  await expect(page.locator('#table .attributes thead')).toContainText('名称');
  await expect(page.locator('#table .attributes thead button', { hasText: '名称' })).toHaveAttribute('title', '名称（name）');
  expect(errors).toEqual([]);
});
