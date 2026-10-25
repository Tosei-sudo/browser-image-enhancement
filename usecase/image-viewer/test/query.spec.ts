import { expect, test, type Page } from '@playwright/test';

/*
 * Attribute queries: selecting by a condition built of field, operator and
 * value or written as SQL (new, add, remove, within the selection), and a
 * layer's definition query, which filters the map and the attribute table,
 * is kept in the project, and for an Esri layer is sent to the server.
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

const cities = {
  type: 'FeatureCollection',
  features: [
    ['東京', 1400, 'capital', '2020-01-05'],
    ['大阪', 880, 'city', '2021-06-01'],
    ['那覇', null, 'city', null],
    ['名古屋', 230, 'city', '2019-12-31'],
    ['札幌', 196, 'city', '2018-04-01'],
  ].map(([name, pop, kind, founded], i) => ({
    type: 'Feature',
    properties: { name, pop, kind, founded },
    geometry: { type: 'Point', coordinates: [135 + i, 35] },
  })),
};

const shown = (page: Page) => page.evaluate(() => window.viewer.table.rows().map((f) => f.get('name') as string));
const selected = (page: Page) => page.evaluate(() => window.viewer.selection.list().map((f) => f.get('name') as string).sort());

test('features are selected by conditions and SQL, and a definition query filters map and table and is kept in the project', async ({ page }) => {
  const errors = await open(page);
  await page.evaluate(async (data) => {
    await window.viewer.project.openFiles([new File([JSON.stringify(data)], 'cities.geojson')]);
  }, cities);
  await expect(page.locator('#table .table-count')).toContainText('全 5 件');

  // From the table's 「条件」: one condition built of field, operator and value.
  await page.locator('#table').getByRole('button', { name: '条件' }).click();
  const dialog = page.locator('dialog.query-dialog');
  await expect(dialog.locator('h2')).toHaveText('属性条件で選択');
  const row = dialog.locator('.query-condition').first();
  await row.getByLabel('フィールド').selectOption('pop');
  await row.getByLabel('演算子').selectOption('>=');
  await row.locator('input[aria-label="値"]').fill('500');
  await expect(dialog.locator('.query-status')).toHaveText('該当 2 件／5 件');
  await dialog.getByRole('button', { name: '選択', exact: true }).click();
  await expect(dialog.locator('.query-status')).toHaveText('該当 2 件・選択 2 件');
  expect(await selected(page)).toEqual(['大阪', '東京']);

  // A second condition with または, then within the selection.
  await dialog.getByRole('button', { name: '＋ 条件を追加' }).click();
  const second = dialog.locator('.query-condition').nth(1);
  await second.getByLabel('前の条件とのつなぎ').selectOption('OR');
  await second.getByLabel('フィールド').selectOption('pop');
  await second.getByLabel('演算子').selectOption('null');
  await expect(second.locator('input[aria-label="値"]')).toBeHidden();
  await expect(dialog.locator('.query-status')).toHaveText('該当 3 件／5 件');
  await dialog.getByLabel('選択方法').selectOption('within');
  await dialog.getByRole('button', { name: '選択', exact: true }).click();
  expect(await selected(page)).toEqual(['大阪', '東京']);

  // The SQL tab starts from the builder's conditions; typed SQL is checked and selects.
  await dialog.getByRole('tab', { name: 'SQL' }).click();
  const sql = dialog.getByLabel('SQL（WHERE 句）');
  await expect(sql).toHaveValue('pop >= 500 OR pop IS NULL');
  await sql.fill("kind = 'city' AND pop BETWEEN 100 AND 300");
  await dialog.getByLabel('選択方法').selectOption('add');
  await dialog.getByRole('button', { name: '選択', exact: true }).click();
  expect(await selected(page)).toEqual(['名古屋', '大阪', '札幌', '東京']);
  await sql.fill("founded >= DATE '2020-01-01'");
  await dialog.getByLabel('選択方法').selectOption('remove');
  await dialog.getByRole('button', { name: '選択', exact: true }).click();
  expect(await selected(page)).toEqual(['名古屋', '札幌']);
  await sql.fill('size > 3');
  await dialog.getByRole('button', { name: '構文チェック' }).click();
  await expect(dialog.locator('.query-status')).toHaveText('不明なフィールド: size');
  await expect(dialog.locator('.query-status')).toHaveClass(/error/);
  // A field is inserted at the cursor.
  await sql.fill('');
  await dialog.locator('.query-fields').getByRole('button', { name: 'kind' }).click();
  await expect(sql).toHaveValue('kind ');
  await dialog.getByRole('button', { name: '閉じる' }).click();

  // The definition query, from the layer's menu: the table and the map keep only what meets it.
  await page.locator('#images .name', { hasText: 'cities' }).click({ button: 'right' });
  await page.locator('.context-menu:visible').getByRole('menuitem', { name: '既定クエリ…' }).click();
  await expect(dialog.locator('h2')).toHaveText('既定クエリ');
  await dialog.locator('.query-condition').first().getByLabel('フィールド').selectOption('kind');
  await dialog.locator('.query-condition').first().locator('input[aria-label="値"]').fill('city');
  await dialog.getByRole('button', { name: '適用' }).click();
  await expect(dialog.locator('.query-status')).toHaveText('既定クエリを適用（4 件を表示）');
  await expect(page.locator('#table .table-count')).toContainText('全 4 件');
  await expect(page.locator('#table .table-count')).toContainText('既定クエリで絞り込み中');
  await expect(page.locator('#images .filter-mark')).toHaveAttribute('title', "既定クエリ: kind = 'city'");
  await expect(page.locator('#table').getByRole('button', { name: '条件' })).toHaveClass(/filtered/);
  expect(await shown(page)).not.toContain('東京');
  const drawn = await page.evaluate(() => {
    const layer = window.viewer.images.selectedLayer();
    if (layer?.type !== 'service') return [];
    const style = layer.service.style!;
    return layer.service.vector!.source.getFeatures().filter((f) => style.shows(f)).map((f) => f.get('name') as string);
  });
  expect(drawn.sort()).toEqual(['名古屋', '大阪', '札幌', '那覇']);
  // Selecting works among the features shown only.
  await dialog.getByRole('button', { name: '閉じる' }).click();
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.getByRole('button', { name: '属性条件で選択…' }).click();
  await dialog.getByRole('tab', { name: 'SQL' }).click();
  await dialog.getByLabel('選択方法').selectOption('new');
  await dialog.getByLabel('SQL（WHERE 句）').fill('pop > 0');
  await dialog.getByRole('button', { name: '選択', exact: true }).click();
  expect(await selected(page)).toEqual(['名古屋', '大阪', '札幌']);
  await dialog.getByRole('button', { name: '閉じる' }).click();

  // Kept in the project, and set again when it opens.
  const saved = await page.evaluate(() => window.viewer.project.collect().project.layers[0].query);
  expect(saved).toBe("kind = 'city'");
  await page.evaluate(async () => {
    const { project } = window.viewer;
    await project.open(project.collect().project, 'test.ivproj');
  });
  await expect(page.locator('#table .table-count')).toContainText('全 4 件');
  await expect(page.locator('#images .filter-mark')).toHaveCount(1);

  // 「既定クエリの解除」 of the layer's menu shows everything again.
  await page.locator('#images .name', { hasText: 'cities' }).click({ button: 'right' });
  await page.locator('.context-menu:visible').getByRole('menuitem', { name: '既定クエリの解除' }).click();
  await expect(page.locator('#table .table-count')).toContainText('全 5 件');
  await expect(page.locator('#images .filter-mark')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('an Esri layer sends its definition query and its selection to the server', async ({ page }) => {
  const errors = await open(page);
  const wheres: string[] = [];
  page.on('request', (r) => {
    if (!r.url().includes('/FeatureServer/0/query')) return;
    const where = new URLSearchParams(r.postData() ?? '').get('where');
    if (where) wheres.push(where);
  });
  await page.getByRole('button', { name: 'サービスを追加' }).click();
  const add = page.getByRole('dialog', { name: 'サービスを追加' });
  await add.getByRole('textbox', { name: 'サービスの URL' }).fill(`${base}/svc/arcgis/rest/services/Test/FeatureServer`);
  await add.getByRole('button', { name: '読み込み' }).click();
  await add.locator('.service-layer input[type=checkbox]').first().check();
  await add.getByRole('button', { name: '追加', exact: true }).click();
  await expect(page.locator('#table .table-count')).toContainText('全 5 件');

  // Selecting: the server finds the ids (its coded values offered by name).
  await page.locator('#table').getByRole('button', { name: '条件' }).click();
  const dialog = page.locator('dialog.query-dialog');
  await expect(dialog.locator('.query-note')).toContainText('サーバーで検索');
  const row = dialog.locator('.query-condition').first();
  await row.getByLabel('フィールド').selectOption('KIND');
  await row.locator('select[aria-label="値"]').selectOption({ label: '広場（2）' });
  await dialog.getByRole('button', { name: '選択', exact: true }).click();
  await expect(dialog.locator('.query-status')).toHaveText('該当 1 件・選択 1 件');
  expect(wheres).toContain('KIND = 2');
  expect(await selected(page)).toEqual([]); // the stand-in's features carry NAME, not name
  expect(await page.evaluate(() => window.viewer.selection.list().map((f) => f.get('NAME')))).toEqual(['駅前広場']);

  // The definition query reads the features again with the server's where.
  await dialog.getByRole('button', { name: '閉じる' }).click();
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.getByRole('button', { name: '既定クエリ…' }).click();
  await expect(dialog.locator('.query-note')).toContainText('サーバーで絞り込み');
  await dialog.getByRole('tab', { name: 'SQL' }).click();
  await dialog.getByLabel('SQL（WHERE 句）').fill('KIND = 1');
  await dialog.getByRole('button', { name: '適用' }).click();
  await expect(dialog.locator('.query-status')).toHaveText('既定クエリを適用（4 件を表示）');
  await expect(page.locator('#table .table-count')).toContainText('全 4 件');
  expect(wheres).toContain('KIND = 1');
  // The selected square is not among the features any more.
  expect(await page.evaluate(() => window.viewer.selection.list().length)).toBe(0);
  await dialog.getByRole('button', { name: '既定クエリの解除' }).click();
  await expect(page.locator('#table .table-count')).toContainText('全 5 件');
  expect(errors).toEqual([]);
});
