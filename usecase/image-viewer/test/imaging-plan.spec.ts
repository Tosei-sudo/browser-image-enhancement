import { expect, test, type Page } from '@playwright/test';

/*
 * The imaging plan panel against a stand-in Esri table of satellites whose
 * attribute names are mapped in config.json: the satellites are read, the
 * passes over a layer's points are listed in time order, a chosen pass is
 * drawn on the map, and the list saves as CSV and adds as a layer. Without a
 * catalog, pasted TLEs and a clicked point work too.
 */

const layerUrl = 'http://localhost:4175/svc/satellites/FeatureServer/0';
const line1 = '1 25544U 98067A   26280.50000000  .00016717  00000-0  10270-3 0  9994';
const line2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49815399432717';
const config = {
  satelliteCatalogs: [
    {
      label: 'テスト衛星',
      url: layerUrl,
      fields: { name: 'SAT_NAME', tle1: 'TLE1', tle2: 'TLE2', maxOffNadir: 'MAX_ONA', swath: 'SWATH_KM', lookSide: 'LOOK', kind: 'SENSOR', minInterval: 'GAP_MIN' },
    },
  ],
};
const satellites = [
  { attributes: { OBJECTID: 1, SAT_NAME: 'OPT-1', TLE1: line1, TLE2: line2, MAX_ONA: 30, SWATH_KM: 12, LOOK: 'both', SENSOR: 'optical' } },
  { attributes: { OBJECTID: 2, SAT_NAME: 'SAR-1', TLE1: line1, TLE2: line2, MAX_ONA: 45, SWATH_KM: 30, LOOK: 'right', SENSOR: 'SAR', GAP_MIN: 10 } },
  { attributes: { OBJECTID: 3, SAT_NAME: 'NO-TLE', TLE1: '', TLE2: '', MAX_ONA: 30, SWATH_KM: 10, LOOK: '', SENSOR: '' } },
];
const sites = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [139.7, 35.68] }, properties: { name: '東京' } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[135.4, 34.6], [135.6, 34.6], [135.6, 34.75], [135.4, 34.75], [135.4, 34.6]]] }, properties: { name: '大阪' } },
  ],
};

async function serve(page: Page, settings: object = config): Promise<void> {
  await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(settings) }));
  await page.route(`${layerUrl}**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ features: satellites }) }));
}

async function openSites(page: Page, collection: object = sites): Promise<void> {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.evaluate(async (text) => window.viewer.project.openFiles([new File([text], 'sites.geojson', { type: 'application/geo+json' })]), JSON.stringify(collection));
  await expect(page.locator('#images li')).toHaveCount(1);
}

async function openPanel(page: Page): Promise<void> {
  await page.locator('#tools-menu .menu-button').click();
  await page.locator('#plan-open').click();
  await expect(page.locator('.plan-dialog')).toBeVisible();
}

test('plans the passes over a layer from a satellite catalog', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await serve(page);
  await openSites(page);
  await openPanel(page);

  const dialog = page.locator('.plan-dialog');
  await expect(dialog.locator('.service-status')).toContainText('テスト衛星: 2 機');
  await expect(dialog.locator('.service-status')).toContainText('NO-TLE: TLE がありません');
  await expect(dialog.locator('select[name=target]')).toHaveValue('layer:0');
  await dialog.locator('input[name=start]').fill('2026-10-07T12:00');
  await dialog.locator('select[name=days]').selectOption('14');
  await dialog.getByRole('button', { name: '計算' }).click();
  await expect(dialog.locator('.service-status')).toContainText('最短は', { timeout: 30_000 });

  const rows = dialog.locator('tbody tr');
  expect(await rows.count()).toBeGreaterThan(2);
  // Two targets: a column names them.
  await expect(dialog.locator('thead')).toContainText('対象');
  const ops = await page.evaluate(() => window.viewer.imagingPlan.opportunities());
  expect(ops.every((o, i) => i === 0 || o.time >= ops[i - 1].time)).toBe(true);
  // The optical satellite only by day and within 30°; the SAR one only looking right.
  const sats = await page.evaluate(() => window.viewer.imagingPlan.satellites().map((s) => s.sat.name));
  for (const op of ops) {
    if (sats[op.satellite] === 'OPT-1') {
      expect(op.offNadir).toBeLessThanOrEqual(30);
      expect(op.sunElevation).toBeGreaterThanOrEqual(10);
    } else expect(op.side).toBe('right');
  }

  // The first pass is drawn: the track, the reach, the scenes and the satellite.
  await expect(rows.first()).toHaveClass(/chosen/);
  const kinds = await page.evaluate(() => window.viewer.imagingPlan.overlay.getSource()!.getFeatures().map((f) => f.get('kind') as string));
  for (const kind of ['target', 'track', 'reach', 'scene', 'satellite']) expect(kinds).toContain(kind);
  await rows.nth(1).click();
  await expect(rows.nth(1)).toHaveClass(/chosen/);

  // Sorting by angle, and the first chance of each satellite and target only.
  await dialog.locator('thead button', { hasText: 'オフナディア角' }).click();
  const angles = await page.evaluate(() => window.viewer.imagingPlan.opportunities().map((o) => o.offNadir));
  expect(angles).toEqual([...angles].sort((a, b) => a - b));
  await dialog.locator('input[name=firstOnly]').check();
  expect(await rows.count()).toBeLessThanOrEqual(4);

  // CSV, then the scenes as a layer with their times.
  const [file] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'CSV 保存' }).click()]);
  expect(file.suggestedFilename()).toMatch(/^imaging-plan_20261007-20261021\.csv$/);
  await dialog.getByRole('button', { name: 'レイヤーとして追加' }).click();
  await expect(page.locator('#images li')).toHaveCount(2);
  await expect(page.locator('#images li').first()).toContainText('撮像計画');
  expect(errors).toEqual([]);
});

test('without a catalog, plans the samples and pasted TLEs over a clicked point', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  await openPanel(page);
  const dialog = page.locator('.plan-dialog');
  await expect(dialog.locator('.service-status')).toContainText('サンプル衛星 2 機');
  await expect(dialog.locator('.plan-sats-count')).toHaveText('（2 / 2）');
  await expect(dialog.locator('select[name=target]')).toHaveValue('click');
  await dialog.locator('.plan-more summary').click();
  await dialog.locator('textarea[name=tle]').fill(`ISS (ZARYA)\n${line1}\n${line2}`);
  await dialog.locator('textarea[name=tle]').dispatchEvent('change');
  await expect(dialog.locator('.plan-sats-count')).toHaveText('（3 / 3）');

  await dialog.getByRole('button', { name: '計算' }).click();
  await expect(dialog.locator('.service-status')).toContainText('地図をクリック');
  await page.evaluate(() => window.viewer.map.getView().setCenter([15550000, 4250000]));
  await page.locator('#map').click({ position: { x: 80, y: 300 } });
  await expect(dialog.locator('.service-status')).toContainText('を対象にしました');
  await dialog.locator('input[name=start]').fill('2026-10-07T12:00');
  await dialog.locator('select[name=daylight]').selectOption('none');
  await dialog.getByRole('button', { name: '計算' }).click();
  await expect(dialog.locator('.service-status')).toContainText('最短は', { timeout: 30_000 });
  await expect(dialog.locator('thead')).not.toContainText('対象');
  expect(errors).toEqual([]);
});

test('combines passes of several satellites to cover a wide polygon', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await serve(page);
  // About 140 × 70 km round Tokyo: wider than any scene.
  const wide = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[139.0, 35.4], [140.5, 35.4], [140.5, 36.0], [139.0, 36.0], [139.0, 35.4]]] }, properties: { name: '関東' } }],
  };
  await openSites(page, wide);
  await openPanel(page);
  const dialog = page.locator('.plan-dialog');
  await expect(dialog.locator('.service-status')).toContainText('テスト衛星: 2 機');
  await dialog.locator('.plan-more summary').click();
  await expect(dialog.locator('.plan-sats-list')).toContainText('間隔 10 分');
  await dialog.locator('input[name=start]').fill('2026-10-07T12:00');
  await dialog.locator('select[name=days]').selectOption('30');
  await dialog.locator('select[name=daylight]').selectOption('none');
  await dialog.getByRole('button', { name: '計算' }).click();

  // No single pass covers it, so the combination is shown: what each pass adds and the total so far.
  await expect(dialog.locator('.service-status')).toContainText('関東:', { timeout: 60_000 });
  await expect(dialog.locator('.service-status')).toContainText('パスで');
  await expect(dialog.locator('select[name=view]')).toHaveValue('cover');
  await expect(dialog.locator('thead')).toContainText('追加');
  await expect(dialog.locator('thead')).toContainText('累計');
  const steps = await page.evaluate(() => window.viewer.imagingPlan.opportunities().map((o) => ({ time: o.time, gain: o.gain!, cumulative: o.cumulative!, satellite: o.satellite })));
  expect(steps.length).toBeGreaterThan(1);
  steps.forEach((step, i) => {
    expect(step.gain).toBeGreaterThan(0);
    if (i) expect(step.cumulative).toBeGreaterThan(steps[i - 1].cumulative);
  });
  expect(new Set(steps.map((s) => s.satellite)).size).toBe(2);
  // The other passes of the combination are drawn, numbered.
  const labels = await page.evaluate(() =>
    window.viewer.imagingPlan.overlay
      .getSource()!
      .getFeatures()
      .filter((f) => f.get('kind') === 'step')
      .map((f) => f.get('label') as string),
  );
  expect(labels.length).toBeGreaterThan(0);

  // A lower goal needs no more passes.
  await dialog.locator('input[name=goal]').fill('50');
  await dialog.locator('input[name=goal]').dispatchEvent('change');
  expect((await page.evaluate(() => window.viewer.imagingPlan.opportunities())).length).toBeLessThanOrEqual(steps.length);

  // Every opportunity, with the share each covers.
  await dialog.locator('select[name=view]').selectOption('all');
  await expect(dialog.locator('thead')).toContainText('被覆');
  await expect(dialog.locator('tbody tr').first()).toContainText('%');
  const [file] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'CSV 保存' }).click()]);
  expect(file.suggestedFilename()).toMatch(/\.csv$/);
  expect(errors).toEqual([]);
});
