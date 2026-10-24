import { expect, test, type Page } from '@playwright/test';

/*
 * Imaging modes: the satellite catalog names each satellite's sensor, and a
 * sensor catalog (a stand-in Esri table, and modes written in config.json)
 * gives the sensor's modes. The satellites are listed once per mode, chosen
 * by their usual mode; a mode can be chosen for every satellite at once, and
 * the plan's list, CSV and the 「衛星パス」 panel say which mode each is.
 */

const layerUrl = 'http://localhost:4175/svc/satellites/FeatureServer/0';
const sensorUrl = 'http://localhost:4175/svc/satellites/FeatureServer/1';
const line1 = '1 25544U 98067A   26280.50000000  .00016717  00000-0  10270-3 0  9994';
const line2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49815399432717';
const config = {
  satelliteCatalogs: [{ label: 'テスト衛星', url: layerUrl, fields: { name: 'SAT_NAME', tle1: 'TLE1', tle2: 'TLE2', maxOffNadir: 'MAX_ONA', swath: 'SWATH_KM', kind: 'KIND', sensor: 'SENSOR' } }],
  sensorCatalogs: [
    { label: 'SAR センサー', url: sensorUrl, fields: { sensor: 'SENSOR', mode: 'MODE', minOffNadir: 'MIN_ONA', maxOffNadir: 'MAX_ONA', swath: 'SWATH_KM', length: 'LENGTH_KM', resolution: 'RES_M', primary: 'IS_DEFAULT' } },
    { label: '光学センサー', sensors: [{ sensor: 'OPT', kind: 'optical', modes: [{ mode: '標準', maxOffNadir: 30, swath: 12, resolution: 0.5 }] }] },
  ],
};
const satellites = [
  { attributes: { OBJECTID: 1, SAT_NAME: 'OPT-1', TLE1: line1, TLE2: line2, MAX_ONA: 30, SWATH_KM: 12, KIND: 'optical', SENSOR: 'OPT' } },
  { attributes: { OBJECTID: 2, SAT_NAME: 'SAR-1', TLE1: line1, TLE2: line2, MAX_ONA: 45, SWATH_KM: 30, KIND: 'SAR', SENSOR: 'XSAR' } },
];
const modes = [
  { attributes: { OBJECTID: 1, SENSOR: 'XSAR', MODE: 'ストリップマップ', MIN_ONA: 15, MAX_ONA: 30, SWATH_KM: 30, LENGTH_KM: 50, RES_M: 3, IS_DEFAULT: 1 } },
  { attributes: { OBJECTID: 2, SENSOR: 'XSAR', MODE: 'スポットライト', MIN_ONA: 10, MAX_ONA: 40, SWATH_KM: 5, LENGTH_KM: 5, RES_M: 0.5, IS_DEFAULT: 0 } },
  { attributes: { OBJECTID: 3, SENSOR: 'XSAR', MODE: 'スキャンSAR', MIN_ONA: 20, MAX_ONA: 45, SWATH_KM: 100, LENGTH_KM: 100, RES_M: 15, IS_DEFAULT: 0 } },
];

async function serve(page: Page): Promise<void> {
  await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config) }));
  const json = (body: object) => ({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  await page.route(`${layerUrl}**`, (route) => route.fulfill(json({ features: satellites })));
  await page.route(`${sensorUrl}**`, (route) => route.fulfill(json({ features: modes })));
}

async function openTool(page: Page, id: string): Promise<void> {
  await page.locator('#tools-menu .menu-button').click();
  await page.locator(id).click();
}

test('plans by imaging mode from a sensor catalog', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await serve(page);
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  await openTool(page, '#plan-open');
  const dialog = page.locator('.plan-dialog');
  await expect(dialog.locator('.service-status')).toContainText('テスト衛星: 2 機（撮像モード 4 種）');
  // Two satellites, each chosen by its usual mode.
  await expect(dialog.locator('.plan-sats-count')).toHaveText('（2 / 2）');
  expect(await page.evaluate(() => window.viewer.imagingPlan.satellites().map((s) => [s.sat.name, s.sat.mode, s.checked]))).toEqual([
    ['OPT-1', '標準', true],
    ['SAR-1', 'ストリップマップ', true],
    ['SAR-1', 'スポットライト', false],
    ['SAR-1', 'スキャンSAR', false],
  ]);
  await dialog.locator('.plan-more > summary').click();
  // SAR-1 folds its modes under its name; the bar above chooses a mode of every satellite.
  await expect(dialog.locator('.plan-group-3 > summary')).toContainText('SAR-1');
  await expect(dialog.locator('.plan-group-3 label')).toHaveText([/ストリップマップ.*分解能 3 m/, /スポットライト.*幅 5 km.*分解能 0.5 m/, /スキャンSAR/]);
  const modeBar = dialog.locator('.plan-modes');
  await expect(modeBar.locator('label')).toHaveText(['標準', 'ストリップマップ', 'スポットライト', 'スキャンSAR']);
  await modeBar.getByRole('checkbox', { name: 'スポットライト' }).check();
  await modeBar.getByRole('checkbox', { name: 'ストリップマップ' }).uncheck();
  await expect(dialog.locator('.plan-sats-count')).toHaveText('（2 / 2）');
  expect(await page.evaluate(() => window.viewer.imagingPlan.satellites().map((s) => s.checked))).toEqual([true, false, true, false]);
  await page.screenshot({ path: 'test-results/sensor-modes-tree.png' });
  // Clearing the SAR kind clears every mode; checking it again brings back the usual one.
  const sar = dialog.locator('.plan-group-1', { hasText: 'SAR' }).locator('summary input').first();
  await sar.uncheck();
  await expect(dialog.locator('.plan-sats-count')).toHaveText('（1 / 2）');
  await sar.check();
  expect(await page.evaluate(() => window.viewer.imagingPlan.satellites().map((s) => s.checked))).toEqual([true, true, false, false]);
  await modeBar.getByRole('checkbox', { name: 'スポットライト' }).check();

  // Plan a point: the list says which mode each pass is taken in.
  await dialog.locator('input[name=start]').fill('2026-10-07T12:00');
  await dialog.locator('select[name=days]').selectOption('7');
  await dialog.locator('select[name=daylight]').selectOption('none');
  await page.evaluate(() => window.viewer.imagingPlan.planAt([139.7, 35.68]));
  await expect(dialog.locator('.service-status')).toContainText('最短は', { timeout: 30_000 });
  const names = await dialog.locator('tbody tr td:nth-child(2)').allTextContents();
  expect(names.some((n) => n === 'SAR-1（スポットライト）')).toBe(true);
  expect(names.some((n) => n === 'SAR-1（ストリップマップ）')).toBe(true);
  await page.screenshot({ path: 'test-results/sensor-modes-plan.png' });
  const [file] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'CSV 保存' }).click()]);
  const csv = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    void file.createReadStream().then((stream) => {
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  });
  expect(csv.split('\r\n')[0]).toContain('衛星,撮像モード,衛星ID');
  expect(csv).toContain(',SAR-1,スポットライト,');

  // The 「衛星パス」 panel lists the same modes, each with its own reach.
  await dialog.locator('.catalog-close').click();
  await openTool(page, '#track-open');
  const track = page.locator('.track-dialog');
  await expect(track.locator('.plan-modes label')).toHaveCount(4);
  await track.locator('.plan-modes').getByRole('checkbox', { name: 'スキャンSAR' }).check();
  await expect.poll(() => page.evaluate(() => window.viewer.satelliteTracks.tracks().map((t) => t.track.sat.mode))).toContain('スキャンSAR');
  expect(errors).toEqual([]);
});
