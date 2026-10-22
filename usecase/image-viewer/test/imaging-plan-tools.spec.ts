import { expect, test, type Page } from '@playwright/test';

/*
 * The imaging plan panel's extra tools: conditions on the incidence, the
 * pass direction and the side; the timeline of the shots; the calendar file
 * and reminders that become notices; and dragging a scene on the map.
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
  { attributes: { OBJECTID: 2, SAT_NAME: 'SAR-1', TLE1: line1, TLE2: line2, MAX_ONA: 45, SWATH_KM: 30, LOOK: 'both', SENSOR: 'SAR', GAP_MIN: 90 } },
];
const sites = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [139.7, 35.68] }, properties: { name: '東京' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [135.5, 34.7] }, properties: { name: '大阪' } },
  ],
};

async function start(page: Page): Promise<void> {
  await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config) }));
  await page.route(`${layerUrl}**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ features: satellites }) }));
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.evaluate(async (text) => window.viewer.project.openFiles([new File([text], 'sites.geojson', { type: 'application/geo+json' })]), JSON.stringify(sites));
  await expect(page.locator('#images li')).toHaveCount(1);
  await page.locator('#tools-menu .menu-button').click();
  await page.locator('#plan-open').click();
  await expect(page.locator('.plan-dialog .service-status')).toContainText('テスト衛星: 2 機');
  await page.locator('.plan-dialog .plan-more > summary').click();
}

test('keeps shots within the incidence, pass and side asked for, with a timeline', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await start(page);
  const dialog = page.locator('.plan-dialog');
  await dialog.locator('input[name=start]').fill('2026-10-07T12:00');
  await dialog.locator('select[name=days]').selectOption('14');
  await dialog.locator('select[name=daylight]').selectOption('none');
  await dialog.getByRole('button', { name: '計算' }).click();
  await expect(dialog.locator('.service-status')).toContainText('最短は', { timeout: 30_000 });
  const all = await page.evaluate(() => window.viewer.imagingPlan.opportunities());
  expect(all.some((o) => o.ascending) && all.some((o) => !o.ascending)).toBe(true);
  expect(all.some((o) => o.side === 'left') && all.some((o) => o.side === 'right')).toBe(true);

  await dialog.locator('select[name=pass]').selectOption('descending');
  await dialog.locator('select[name=side]').selectOption('right');
  await dialog.locator('input[name=minIncidence]').fill('10');
  await dialog.locator('input[name=maxIncidence]').fill('35');
  await dialog.getByRole('button', { name: '計算' }).click();
  await expect(dialog.locator('.service-status')).toContainText('最短は', { timeout: 30_000 });
  const some = await page.evaluate(() => window.viewer.imagingPlan.opportunities());
  expect(some.length).toBeGreaterThan(0);
  expect(some.length).toBeLessThan(all.length);
  for (const op of some) {
    expect(op.ascending).toBe(false);
    expect(op.side).toBe('right');
    expect(op.incidence).toBeGreaterThanOrEqual(10);
    expect(op.incidence).toBeLessThanOrEqual(35);
  }

  // The timeline: a row per satellite, a bar per shot; clicking a bar chooses its row.
  await dialog.locator('input[name=timeline]').check();
  const timeline = dialog.locator('.plan-timeline');
  await expect(timeline).toBeVisible();
  await expect(timeline.locator('.plan-tl-shot')).toHaveCount(some.length);
  expect(await timeline.locator('.plan-tl-label').count()).toBe(new Set(some.map((o) => o.satellite)).size);
  // The SAR satellite's 90 minutes after each shot are shaded.
  if (some.some((o) => o.satellite === 1)) expect(await timeline.locator('.plan-tl-busy').count()).toBeGreaterThan(0);
  await timeline.locator('.plan-tl-shot').last().dispatchEvent('click');
  await expect(timeline.locator('.plan-tl-shot.chosen')).toHaveCount(1);
  await expect(dialog.locator('tbody tr.chosen')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('saves the shots as a calendar and reminds of them in the notification centre', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await start(page);
  const dialog = page.locator('.plan-dialog');
  // From now on (the start the panel fills in), so the shots are ahead.
  await dialog.locator('select[name=days]').selectOption('3');
  await dialog.locator('select[name=daylight]').selectOption('none');
  await dialog.getByRole('button', { name: '計算' }).click();
  await expect(dialog.locator('.service-status')).toContainText('最短は', { timeout: 30_000 });

  await dialog.getByRole('button', { name: '予定・通知…' }).click();
  const [file] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: '予定表 (.ics)' }).click()]);
  expect(file.suggestedFilename()).toMatch(/^imaging-plan_\d{8}-\d{8}\.ics$/);
  const text = await (await file.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString('utf8'));
  expect(text).toContain('BEGIN:VEVENT');
  expect(text).toContain('TRIGGER:-PT30M');

  // A day ahead: the first shots are due at once and turn into notices.
  await dialog.locator('input[name=remindMinutes]').fill('1440');
  await dialog.getByRole('button', { name: '通知を設定' }).click();
  await expect(dialog.locator('.plan-remind-count')).toContainText('通知予定');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('#watch-open')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#watch-open .watch-count')).not.toHaveText('', { timeout: 30_000 });
  await page.locator('#watch-open').click();
  const notice = page.locator('.watch-dialog .watch-notice').first();
  await expect(notice).toContainText('が撮像');
  // A reminder has nothing to open, but shows where.
  await expect(notice.getByRole('button', { name: '開く' })).toHaveCount(0);
  await notice.getByRole('button', { name: '移動' }).dispatchEvent('click');
  await dialog.getByRole('button', { name: '通知を解除' }).click();
  await expect(dialog.locator('.plan-remind-count')).toHaveText('');
  expect(errors).toEqual([]);
});

test('moves the chosen scene by dragging it on the map', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await start(page);
  const dialog = page.locator('.plan-dialog');
  await dialog.locator('input[name=start]').fill('2026-10-07T12:00');
  await dialog.locator('select[name=daylight]').selectOption('none');
  await dialog.getByRole('button', { name: '計算' }).click();
  await expect(dialog.locator('.service-status')).toContainText('ドラッグで動かせます', { timeout: 30_000 });
  await dialog.locator('input[name=firstOnly]').check();
  await page.evaluate(() => window.viewer.imagingPlan.choose(window.viewer.imagingPlan.opportunities()[0]));
  // Zoomed out enough that the scene and some room around it are on the map, left of the panel.
  await page.evaluate(() => {
    const scene = window.viewer.imagingPlan.overlay
      .getSource()!
      .getFeatures()
      .find((f) => f.get('kind') === 'scene')!;
    const view = window.viewer.map.getView();
    const e = scene.getGeometry()!.getExtent();
    view.fit(e, { size: [300, 300] });
    // Near the map's left edge, clear of the panel.
    const size = window.viewer.map.getSize()!;
    view.centerOn([(e[0] + e[2]) / 2, (e[1] + e[3]) / 2], size, [160, size[1] / 2]);
    window.viewer.map.renderSync();
  });
  const before = await page.evaluate(() => window.viewer.imagingPlan.opportunities()[0]);
  const pixel = await page.evaluate(() => {
    const scene = window.viewer.imagingPlan.overlay
      .getSource()!
      .getFeatures()
      .find((f) => f.get('kind') === 'scene')!;
    const e = scene.getGeometry()!.getExtent();
    return window.viewer.map.getPixelFromCoordinate([(e[0] + e[2]) / 2, (e[1] + e[3]) / 2]);
  });
  const box = (await page.locator('#map').boundingBox())!;
  await page.mouse.move(box.x + pixel[0], box.y + pixel[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + pixel[0] + 20, box.y + pixel[1] + 10, { steps: 4 });
  await page.mouse.move(box.x + pixel[0] + 60, box.y + pixel[1] + 20, { steps: 4 });
  await page.mouse.up();
  await expect(dialog.locator('.service-status')).toContainText('撮像範囲を動かしました');
  const after = await page.evaluate(() => window.viewer.imagingPlan.opportunities()[0]);
  expect(after.adjusted).toBe(true);
  expect(after.window[0]).not.toBeCloseTo(before.window[0], 6);
  await expect(dialog.locator('tbody tr').first()).toContainText('✎');
  expect(errors).toEqual([]);
});

test('adds the cloud forecast of optical shots and when each can be sent down', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const forecastUrl = 'http://localhost:4175/wx/v1/forecast';
  const asked: string[] = [];
  await page.route(`${forecastUrl}**`, (route) => {
    asked.push(route.request().url());
    const url = new URL(route.request().url());
    const n = url.searchParams.get('latitude')!.split(',').length;
    const now = Math.floor(Date.now() / 3600000) * 3600;
    const hours = Array.from({ length: 16 * 24 }, (_, i) => now - 3600 + i * 3600);
    // Clear on even hours, overcast on odd ones.
    const one = { hourly: { time: hours, cloud_cover: hours.map((t) => ((t / 3600) % 2 ? 100 : 0)) } };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(n === 1 ? one : Array.from({ length: n }, () => one)) });
  });
  await page.route('**/config.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...config, cloudForecast: { url: forecastUrl, label: 'テスト予報' }, groundStations: [{ name: '勝浦', lon: 140.3, lat: 35.15 }] }) }),
  );
  await page.route(`${layerUrl}**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ features: satellites }) }));
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.evaluate(async (text) => window.viewer.project.openFiles([new File([text], 'sites.geojson', { type: 'application/geo+json' })]), JSON.stringify(sites));
  await page.locator('#tools-menu .menu-button').click();
  await page.locator('#plan-open').click();
  const dialog = page.locator('.plan-dialog');
  await expect(dialog.locator('.service-status')).toContainText('テスト衛星: 2 機');
  await dialog.locator('.plan-more > summary').click();
  // Off until turned on: nothing is asked.
  await expect(dialog.locator('input[name=cloud]')).not.toBeChecked();
  await dialog.locator('select[name=days]').selectOption('7');
  await dialog.locator('select[name=daylight]').selectOption('none');
  await dialog.getByRole('button', { name: '計算' }).click();
  await expect(dialog.locator('.service-status')).toContainText('最短は', { timeout: 30_000 });
  expect(asked).toHaveLength(0);
  await expect(dialog.locator('thead')).toContainText('受信見込み');
  await expect(dialog.locator('thead')).not.toContainText('雲量');
  const ops = await page.evaluate(() => window.viewer.imagingPlan.opportunities());
  expect(ops.some((o) => o.downlink)).toBe(true);

  await dialog.locator('input[name=cloud]').check();
  await expect(dialog.locator('thead')).toContainText('雲量');
  expect(asked.length).toBeGreaterThan(0);
  const clouded = await page.evaluate(() => window.viewer.imagingPlan.opportunities());
  const sats = await page.evaluate(() => window.viewer.imagingPlan.satellites().map((s) => s.sat.name));
  // The optical satellite's shots have a forecast; the SAR one's do not.
  expect(clouded.filter((o) => sats[o.satellite] === 'OPT-1').every((o) => o.cloud !== undefined)).toBe(true);
  expect(clouded.filter((o) => sats[o.satellite] === 'SAR-1').every((o) => o.cloud === undefined)).toBe(true);
  // At most 30%: the cloudy optical shots go; SAR ones stay.
  await dialog.locator('input[name=maxCloud]').fill('30');
  await dialog.locator('input[name=maxCloud]').dispatchEvent('change');
  const clear = await page.evaluate(() => window.viewer.imagingPlan.opportunities());
  expect(clear.length).toBeLessThan(clouded.length);
  expect(clear.every((o) => o.cloud === undefined || o.cloud <= 30)).toBe(true);
  const [file] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'CSV 保存' }).click()]);
  const text = await (await file.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString('utf8'));
  expect(text).toContain('雲量予報%');
  expect(text).toContain('勝浦');
  expect(errors).toEqual([]);
});
