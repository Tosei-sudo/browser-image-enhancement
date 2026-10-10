import { expect, test, type Page } from '@playwright/test';

/*
 * The dashboard: counts, the values of an attribute, the distribution of a
 * number and the count over time of a vector layer, and a heatmap. Its charts
 * filter the map and the attribute table; the time chart opens the timeline.
 * A project keeps the layout: panel sizes, the timeline and the dashboard.
 */

const kinds = ['公園', '公園', '公園', '学校', '学校', '病院'];
const survey = {
  type: 'FeatureCollection',
  features: kinds.map((kind, i) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [139.7 + i * 0.01, 35.68] },
    properties: { name: `地点${i + 1}`, kind, value: (i + 1) * 10, observed: `2024-0${i + 1}-15` },
  })),
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const root = () => navigator.storage.getDirectory();
    const w = window as unknown as Record<string, unknown>;
    w.showOpenFilePicker = async (options?: { id?: string }) => [await (await root()).getFileHandle(options?.id === 'image-viewer-project' ? 'layout.ivproj' : 'survey.geojson')];
    w.showSaveFilePicker = async () => (await root()).getFileHandle('layout.ivproj', { create: true });
  });
});

async function open(page: Page, query = '') {
  await page.goto(`/index.html${query}`);
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.evaluate(async (text) => {
    const root = await navigator.storage.getDirectory();
    const writable = await (await root.getFileHandle('survey.geojson', { create: true })).createWritable();
    await writable.write(text);
    await writable.close();
  }, JSON.stringify(survey));
  await page.locator('#open .ol-load-image button').first().click();
  await expect(page.locator('#status')).toContainText('survey を開きました');
}

const rows = (page: Page) => page.locator('.attributes tbody tr[data-index]');
const dashboard = (page: Page) => page.locator('#dashboard');
const tile = (page: Page, label: string) => dashboard(page).locator(`.dashboard-tile[data-label="${label}"] strong`);
const bar = (page: Page, value: string) => dashboard(page).locator(`.dashboard-bar[data-value="${value}"]`);

for (const query of ['', '?vectorgl=always']) {
  test(`the charts filter the map and the table${query ? ' (vector layer on the GPU)' : ''}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await open(page, query);
    await page.locator('#map').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('b');
    await expect(dashboard(page)).toBeVisible();
    await expect(tile(page, '地物')).toHaveText('6');
    await expect(dashboard(page).getByLabel('集計する属性')).toHaveValue('kind');
    await expect(dashboard(page).getByLabel('数値の属性')).toHaveValue('value');
    await expect(bar(page, '公園').locator('.value')).toHaveText('3');

    // A value: only its features on the map and in the table.
    await bar(page, '学校').click();
    await expect(rows(page)).toHaveCount(2);
    await expect(tile(page, '絞り込み後')).toHaveText('2');
    await expect(page.locator('.table-bar')).toContainText('ダッシュボードで絞り込み中');
    const drawn = () =>
      page.evaluate(() => {
        const layer = window.viewer.images.layers()[0];
        return layer.type === 'service' ? layer.service.vector!.source.getFeatures().filter((f) => layer.service.style!.shows(f)).length : -1;
      });
    expect(await drawn()).toBe(2);
    // Ctrl: another value too.
    await bar(page, '病院').click({ modifiers: ['Control'] });
    await expect(rows(page)).toHaveCount(3);

    // 合計 of the number by value.
    await dashboard(page).getByLabel('集計の方法').selectOption('sum');
    await expect(bar(page, '公園').locator('.value')).toHaveText('60');

    // A range of the number (the filter of values stays).
    await dashboard(page).locator('.dashboard-histogram .dashboard-column').last().click();
    await expect(rows(page)).toHaveCount(1);
    await dashboard(page).getByRole('button', { name: '絞り込みを解除' }).click();
    await expect(rows(page)).toHaveCount(6);

    // Select what is shown.
    await bar(page, '公園').click();
    await dashboard(page).getByRole('button', { name: '地物を選択' }).click();
    await expect(tile(page, '選択中')).toHaveText('3');

    // The heatmap follows the filter.
    await dashboard(page).getByRole('checkbox', { name: 'ヒートマップ' }).check();
    await expect.poll(() => page.evaluate(() => window.viewer.dashboard.heatmapFeatures())).toBe(3);

    // The time chart opens the timeline on a step.
    await expect(dashboard(page).locator('.dashboard-time .dashboard-column').first()).toBeVisible();
    await dashboard(page).locator('.dashboard-time .dashboard-column').first().click();
    await expect(page.locator('#timeline')).toBeVisible();
    await expect(page.locator('#timeline .timeline-label')).not.toHaveText('');
    await expect(rows(page)).toHaveCount(1);

    // Closing: everything again.
    await dashboard(page).getByRole('button', { name: 'ダッシュボードを閉じる' }).click();
    await page.locator('#timeline').getByRole('button', { name: 'タイムラインを閉じる' }).click();
    await expect(rows(page)).toHaveCount(6);
    expect(await drawn()).toBe(6);
    expect(errors).toEqual([]);
  });
}

test('a project keeps the layout: panels, the timeline and the dashboard', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await page.evaluate(() => {
    const { timeline, dashboard, table } = window.viewer;
    document.querySelector<HTMLElement>('.app')!.style.setProperty('--side-width', '300px');
    table.setCollapsed(true);
    timeline.setOpen(true);
    timeline.setWidth('month');
    timeline.setWindow(new Date(2024, 1, 1).getTime(), new Date(2024, 2, 1).getTime() - 1);
    timeline.setCumulative(true);
    dashboard.setOpen(true);
    dashboard.setValues(['公園']);
    dashboard.setHeatmap(true);
  });
  await page.keyboard.press('Control+s');
  await expect(page.locator('#status')).toHaveText('layout.ivproj に保存しました');
  const saved = JSON.parse(await page.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('layout.ivproj')).getFile()).text()));
  expect(saved.layout).toMatchObject({ sideWidth: 300, tableCollapsed: true, timeline: { open: true, width: 'month', cumulative: true }, dashboard: { open: true, values: ['公園'], heatmap: true, groupBy: 'kind' } });
  expect(saved.layers[0].time).toEqual({ on: true, start: 'observed', end: null });

  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);
  await expect(page.locator('#timeline')).toBeHidden();
  await page.getByRole('button', { name: 'プロジェクト' }).click();
  await page.getByRole('button', { name: '開く…' }).click();
  await expect(page.locator('#status')).toHaveText('プロジェクト「layout」を開きました');
  await expect(page.locator('#timeline')).toBeVisible();
  await expect(dashboard(page)).toBeVisible();
  await expect(bar(page, '公園')).toHaveClass(/chosen/);
  await expect(dashboard(page).getByRole('checkbox', { name: 'ヒートマップ' })).toBeChecked();
  await expect(page.locator('#timeline').getByLabel('期間の幅')).toHaveValue('month');
  await expect(page.locator('#timeline').getByLabel('累積')).toBeChecked();
  // 累積 to the end of February, 公園 only: 地点1 and 地点2.
  const shown = await page.evaluate(() => {
    const layer = window.viewer.images.layers()[0];
    return layer.type === 'service' ? layer.service.vector!.source.getFeatures().filter((f) => layer.service.style!.shows(f)).map((f) => f.get('name')) : [];
  });
  expect(shown.sort()).toEqual(['地点1', '地点2']);
  expect(await page.evaluate(() => document.querySelector<HTMLElement>('.app')!.style.getPropertyValue('--side-width'))).toBe('300px');
  expect(await page.evaluate(() => window.viewer.table.isCollapsed())).toBe(true);
  expect(errors).toEqual([]);
});
