import { expect, test, type Page } from '@playwright/test';
import { fakeEsri, type FakeImage } from './plan-store-fake.js';

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

test('saves a plan to a feature service and follows its shots up in the image catalog', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const planUrl = 'http://localhost:4175/svc/plans/FeatureServer/0';
  const catalogUrl = 'http://localhost:4175/svc/images/FeatureServer/0';
  const images: FakeImage[] = [];
  const fake = fakeEsri(planUrl, catalogUrl, images);
  for (const url of [planUrl, catalogUrl]) {
    await page.route(`${url}**`, (route) => {
      const request = route.request();
      const target = request.url().split('?')[0];
      const params = Object.fromEntries(new URLSearchParams(request.postData() ?? request.url().split('?')[1] ?? ''));
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(fake.answer(target, params)) });
    });
  }
  await page.route('**/config.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...config,
        imageCatalogs: [{ label: '画像', url: catalogUrl, fields: { id: 'IMAGE_ID', acquired: 'ACQ', sensor: 'SENSOR', source: 'URL' } }],
        planStores: [{ label: '計画レイヤー', url: planUrl }],
      }),
    }),
  );
  await page.route(`${layerUrl}**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ features: satellites }) }));
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.evaluate(async (text) => window.viewer.project.openFiles([new File([text], 'sites.geojson', { type: 'application/geo+json' })]), JSON.stringify(sites));
  await page.locator('#tools-menu .menu-button').click();
  await page.locator('#plan-open').click();
  const dialog = page.locator('.plan-dialog');
  await expect(dialog.locator('.service-status')).toContainText('テスト衛星: 2 機');
  await dialog.locator('input[name=start]').fill('2026-10-07T12:00');
  await dialog.locator('select[name=days]').selectOption('3');
  await dialog.getByRole('button', { name: '計算' }).click();
  await expect(dialog.locator('.service-status')).toContainText('最短は', { timeout: 30_000 });
  await dialog.locator('input[name=firstOnly]').check();
  const ops = await page.evaluate(() => window.viewer.imagingPlan.opportunities().map((o) => ({ time: o.time, target: o.target })));
  // An image came over the first shot's target 5 minutes after it.
  const first = ops[0];
  const center = sites.features[first.target].geometry.coordinates as number[];
  images.push({ attributes: { IMAGE_ID: 'IMG-1', ACQ: first.time + 300000, SENSOR: 'OPT-1', URL: 'https://example.com/a.tif' }, box: [center[0] - 0.2, center[1] - 0.2, center[0] + 0.2, center[1] + 0.2] });

  await dialog.getByRole('button', { name: '保存・追跡…' }).click();
  await dialog.locator('input[name=planName]').fill('テスト計画');
  await dialog.getByRole('button', { name: '保存先に保存' }).click();
  await expect(dialog.locator('.service-status')).toContainText('「テスト計画」を 計画レイヤー に保存しました');
  expect(fake.shots.length).toBe(ops.length);

  await dialog.getByRole('button', { name: '保存した計画…' }).click();
  const saved = page.locator('.plan-saved-dialog');
  await expect(saved.locator('.plan-saved-list tbody tr')).toHaveCount(1);
  await saved.locator('.plan-saved-list tbody tr').first().dispatchEvent('click');
  // Opened, the shots long past are followed up: the first was taken, the others are missed.
  await expect(saved.locator('.service-status')).toContainText('新たに撮像済み 1 回', { timeout: 10_000 });
  await expect(saved.locator('.plan-saved-shots tbody tr').first()).toContainText('IMG-1');
  const statuses = await page.evaluate(() => window.viewer.savedPlans.shots().map((s) => s.status));
  expect(statuses[0]).toBe('撮像済み');
  expect(statuses.slice(1).every((s) => s === '未撮像')).toBe(true);
  expect(fake.shots.find((s) => s.attributes.IMAGE_ID === 'IMG-1')).toBeDefined();
  // A status set by hand is saved.
  await saved.locator('.plan-saved-shots tbody tr').nth(1).locator('select').selectOption('取消');
  await expect.poll(() => fake.shots.filter((s) => s.attributes.STATUS === '取消').length).toBe(1);
  // Deleting takes two presses.
  await saved.getByRole('button', { name: '計画を削除' }).dispatchEvent('click');
  await saved.getByRole('button', { name: 'もう一度押すと削除' }).dispatchEvent('click');
  await expect(saved.locator('.service-status')).toContainText('保存した計画はまだありません');
  expect(fake.shots).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('lists stereo and interferometric pairs, and maps how long each place waits', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await start(page);
  const dialog = page.locator('.plan-dialog');
  await dialog.locator('input[name=start]').fill('2026-10-07T12:00');
  await dialog.locator('select[name=days]').selectOption('14');
  await dialog.locator('select[name=daylight]').selectOption('none');
  await dialog.getByRole('button', { name: '計算' }).click();
  await expect(dialog.locator('.service-status')).toContainText('最短は', { timeout: 30_000 });

  // Stereo: pairs of one kind of sensor, their convergence within the range asked for.
  await dialog.locator('select[name=view]').selectOption('stereo');
  await expect(dialog.locator('.plan-pair-stereo')).toBeVisible();
  await expect(dialog.locator('.service-status')).toContainText('ステレオペア');
  await expect(dialog.locator('thead')).toContainText('交会角');
  const column = (await dialog.locator('thead th').allTextContents()).findIndex((t) => t.startsWith('交会角')) + 1;
  const angles = await dialog.locator(`tbody tr td:nth-child(${column})`).allTextContents();
  expect(angles.length).toBeGreaterThan(0);
  for (const a of angles) {
    expect(parseFloat(a)).toBeGreaterThanOrEqual(15);
    expect(parseFloat(a)).toBeLessThanOrEqual(45);
  }
  // The first row's two shots on the map: its own scene and the second, numbered 2.
  const kinds = await page.evaluate(() => window.viewer.imagingPlan.overlay.getSource()!.getFeatures().map((f) => `${f.get('kind')}:${f.get('label') ?? ''}`));
  expect(kinds).toContain('scene:');
  expect(kinds).toContain('step:2');
  const [csv] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'CSV' }).click()]);
  const text = await (await csv.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString('utf8'));
  expect(text.split('\r\n')[0]).toContain('交会角');

  // Interferometry: SAR returns on the same track; the ISS orbit does not repeat exactly, so loosen the incidence.
  await dialog.locator('select[name=view]').selectOption('repeat');
  await dialog.locator('input[name=repeatIncidence]').fill('5');
  await dialog.locator('input[name=repeatIncidence]').dispatchEvent('change');
  await expect(dialog.locator('.service-status')).toContainText('干渉ペア');
  const rows = await dialog.locator('tbody tr').count();
  if (rows) await expect(dialog.locator('thead')).toContainText('垂直基線');

  // The revisit map: a 3 × 3 grid around the two places, coloured on the map.
  await dialog.locator('select[name=view]').selectOption('revisit');
  await dialog.locator('input[name=revisitGrid]').fill('3');
  await dialog.locator('input[name=revisitGrid]').dispatchEvent('change');
  await expect(dialog.locator('.service-status')).toContainText('9 セルのうち', { timeout: 30_000 });
  await expect(dialog.locator('tbody tr')).toHaveCount(9);
  await expect(dialog.locator('thead')).toContainText('最長の待ち');
  const cells = await page.evaluate(() => window.viewer.imagingPlan.overlay.getSource()!.getFeatures().filter((f) => f.get('kind') === 'revisit').length);
  expect(cells).toBe(9);
  const layer = await page.evaluate(() => window.viewer.imagingPlan.planLayer()?.features.length);
  expect(layer).toBe(9);
  expect(errors).toEqual([]);
});

test('plans ships of an AIS feed where they will be, with the circle they may be off by', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/stub/ais.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: { mmsi: 431000001, shipname: 'HIKARI', cog: 45, sog: 12, timestamp: new Date().toISOString() }, geometry: { type: 'Point', coordinates: [139.75, 35.6] } },
          { type: 'Feature', properties: { mmsi: 431000002, shipname: 'NOZOMI', cog: 270, sog: 8, timestamp: new Date().toISOString() }, geometry: { type: 'Point', coordinates: [139.8, 35.55] } },
        ],
      }),
    }),
  );
  await start(page);
  await page.evaluate(() => window.viewer.moving.connect({ label: 'AIS', type: 'poll', url: './stub/ais.json', interval: 600, kind: 'ship' }));
  await expect.poll(() => page.evaluate(() => window.viewer.moving.feeds()[0]?.source.getFeatures().length ?? 0)).toBe(2);
  const dialog = page.locator('.plan-dialog');
  // The feed is a target choice like any layer; from now, over three days.
  await page.evaluate(() => window.viewer.imagingPlan.listTargets());
  const choice = await dialog.locator('select[name=target] option', { hasText: 'AIS' }).getAttribute('value');
  await dialog.locator('select[name=target]').selectOption(choice!);
  await dialog.locator('select[name=days]').selectOption('3');
  await dialog.locator('select[name=daylight]').selectOption('none');
  await dialog.getByRole('button', { name: '計算' }).click();
  await expect(dialog.locator('.service-status')).toContainText('最短は', { timeout: 60_000 });
  await expect(dialog.locator('thead')).toContainText('位置の誤差');
  const plan = await page.evaluate(() => {
    const ops = window.viewer.imagingPlan.opportunities();
    const rows = [...document.querySelectorAll('.plan-dialog tbody tr')].map((r) => r.textContent ?? '');
    return { n: ops.length, rows };
  });
  expect(plan.n).toBeGreaterThan(0);
  expect(plan.rows.some((r) => r.includes('HIKARI'))).toBe(true);
  expect(plan.rows.every((r) => /±\d/.test(r))).toBe(true);
  // The chosen shot's circle is on the map with its scene.
  const kinds = await page.evaluate(() => window.viewer.imagingPlan.overlay.getSource()!.getFeatures().map((f) => `${f.get('kind')}:${f.getGeometry()!.getType()}`));
  expect(kinds).toContain('target:Polygon');
  expect(kinds).toContain('scene:Polygon');
  expect(errors).toEqual([]);
});
