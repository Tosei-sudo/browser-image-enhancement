import { expect, test, type Download, type Page } from '@playwright/test';
import { plainGeoTiff } from './fixtures.js';

/*
 * 観測記録, more: the things of other images offered as the same one at a
 * click (同一候補), 確度 and who recorded, checked areas (確認範囲) whose
 * unrecorded things were not there, the report, and the same from a script.
 */

async function openImages(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  const bytes = Array.from(plainGeoTiff(400, 300));
  await page.evaluate(async (data) => {
    const files = ['site_20261005.tif', 'site_20261001.tif', 'site_20261003.tif'].map((name) => new File([new Uint8Array(data)], name, { type: 'image/tiff' }));
    await window.viewer.project.openFiles(files);
  }, bytes);
  await expect(page.locator('#images .name')).toHaveCount(3);
  await page.waitForFunction(() => window.viewer.map.getView().getResolution() !== undefined);
}

async function openPanel(page: Page) {
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#observe-open').click();
  const panel = page.locator('.obs-dialog');
  await expect(panel).toBeVisible();
  // The images' middle at a quarter of the map's width, clear of the panel.
  await page.evaluate(() => {
    const map = window.viewer.map;
    const view = map.getView();
    const size = map.getSize()!;
    view.centerOn(view.getCenter()!, size, [size[0] / 4, size[1] / 2]);
  });
  await panel.locator('select[name=image]').selectOption({ index: 0 });
  return panel;
}

async function textOf(download: Download): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

test('a click near where a thing was offers it as the same one; 確度 and the recorder go with each record', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openImages(page);
  const panel = await openPanel(page);
  await panel.locator('.catalog-more > summary').first().click();
  await panel.locator('input[name=observer]').fill('田中');
  await panel.locator('input[name=observer]').press('Tab');
  await panel.locator('.catalog-more > summary').first().click();

  const map = page.locator('#map');
  const box = (await map.boundingBox())!;
  const form = panel.locator('.obs-form');
  await map.click({ position: { x: box.width / 4, y: box.height / 2 } });
  // Nothing to offer in the first image.
  await expect(form.locator('.obs-candidates')).toBeHidden();
  await expect(form.locator('select[name=confidence] option')).toHaveText(['確度なし', '確定', '推定', '不明']);
  await form.locator('input[name=object]').fill('タンカーA');
  await form.locator('input[name=activity]').fill('停泊');
  await form.locator('select[name=confidence]').selectOption('推定');
  await form.locator('input[name=object]').press('Enter');
  await expect(panel.locator('.service-status')).toContainText('タンカーA（停泊）を記録');
  expect(await page.evaluate(() => window.viewer.observations.records()[0])).toMatchObject({ confidence: '推定', recordedBy: '田中', updatedBy: '田中' });

  // The next image: it has moved a little; a click beside its old mark offers it, Alt+1 takes it.
  await page.keyboard.press('PageDown');
  await expect(panel.locator('select[name=image]')).toHaveValue('1');
  await map.click({ position: { x: box.width / 4 + 30, y: box.height / 2 + 10 } });
  const offered = form.locator('.obs-candidates button');
  await expect(offered).toHaveText(['1 タンカーA']);
  await expect(offered.first()).toHaveAttribute('title', /同じ分類/);
  await page.keyboard.press('Alt+1');
  await expect(form.locator('input[name=object]')).toHaveValue('タンカーA');
  await expect(form.locator('input[name=activity]')).toHaveValue('停泊');
  await expect(offered.first()).toHaveAttribute('aria-pressed', 'true');
  // The level chosen last stays.
  await expect(form.locator('select[name=confidence]')).toHaveValue('推定');
  await form.locator('select[name=confidence]').selectOption('確定');
  await form.getByRole('button', { name: '記録（Enter）' }).click();
  await expect
    .poll(() => page.evaluate(() => window.viewer.observations.flows().map((f) => ({ name: f.name, images: f.observations.length, confidence: f.observations.map((o) => o.confidence) }))))
    .toEqual([{ name: 'タンカーA', images: 2, confidence: ['推定', '確定'] }]);

  // Another thing in the same image: タンカーA is recorded here already, so nothing is offered; it is a new one.
  await map.click({ position: { x: box.width / 4, y: box.height / 2 - 60 } });
  await expect(form).toBeVisible();
  await expect(form.locator('.obs-candidates')).toBeHidden();
  await form.locator('input[name=object]').press('Enter');
  await expect.poll(() => page.evaluate(() => window.viewer.observations.flows().length)).toBe(2);
  expect(errors).toEqual([]);
});

test('a checked area says the things of other images not recorded there were gone; the report holds it all', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openImages(page);
  const panel = await openPanel(page);
  const map = page.locator('#map');
  const box = (await map.boundingBox())!;
  const form = panel.locator('.obs-form');
  const at = { x: box.width / 4, y: box.height / 2 };
  for (const [name, dx] of [
    ['桟橋の船', 0],
    ['沖の船', 120],
  ] as const) {
    await map.click({ position: { x: at.x + dx, y: at.y } });
    await form.locator('input[name=object]').fill(name);
    await form.locator('input[name=activity]').fill('停泊');
    await form.locator('input[name=object]').press('Enter');
    await expect(panel.locator('.service-status')).toContainText(`${name}（停泊）を記録`);
  }

  // The next image: the pier was looked over (A, two corners, Enter) and the ship there was not seen.
  await page.keyboard.press('PageDown');
  await expect(panel.locator('.obs-carry')).toHaveText('前後の画像のモノ 2 件');
  await page.keyboard.press('a');
  await expect(panel.getByRole('button', { name: '確認範囲', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await map.click({ position: { x: at.x - 40, y: at.y - 40 } });
  await map.click({ position: { x: at.x + 40, y: at.y + 40 } });
  await expect(panel.locator('.obs-area-range')).toContainText(/範囲: .+ × /);
  await panel.locator('input[name=area-kind]').fill('船舶');
  await panel.locator('input[name=area-note]').fill('桟橋周辺');
  await panel.locator('input[name=area-note]').press('Enter');
  await expect(panel.locator('.service-status')).toContainText('確認範囲（船舶）を記録（範囲内で記録のない前後の画像のモノ 1 件）');
  await expect(panel.locator('.obs-area-form')).toBeHidden();
  await expect(panel.locator('.obs-area-row')).toHaveCount(1);
  await expect(panel.locator('.obs-inside')).toContainText('桟橋の船');
  // 「すべて継続」 leaves it out; it is recorded as gone with one press.
  await panel.getByRole('button', { name: 'すべて継続' }).click();
  await expect(panel.locator('.service-status')).toContainText('1 のモノを継続として記録（確認範囲内の 1 件を除く）');
  await panel.getByRole('button', { name: '確認範囲内 1 件を不在' }).click();
  await expect(panel.locator('.service-status')).toContainText('1 のモノを不在として記録（確認範囲内）');
  const steps = await page.evaluate(() => Object.fromEntries(window.viewer.observations.flows().map((f) => [f.name, f.steps.map((s) => (s.present ? s.activity : '不在'))])));
  expect(steps).toEqual({ 桟橋の船: ['停泊', '不在'], 沖の船: ['停泊'] });
  expect(await page.evaluate(() => window.viewer.observations.areas().map((a) => [a.imageName, a.kind, a.note, a.ring.length]))).toEqual([['site_20261003.tif', '船舶', '桟橋周辺', 5]]);

  // Kept in the browser with the records.
  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.evaluate(() => window.viewer.observations.reload());
  expect(await page.evaluate(() => window.viewer.observations.areas().length)).toBe(1);
  await openImages(page);
  const again = await openPanel(page);

  // The report: a period, a title, the parts; one HTML file with the map inside.
  await again.locator('.catalog-more > summary').first().click();
  await again.getByRole('button', { name: '報告書…' }).click();
  const report = again.locator('.obs-report-form');
  await expect(report).toBeVisible();
  await expect(report.locator('select[name=report-confidence] option')).toHaveText(['すべて', '確定 以上', '推定 以上', '不明']);
  await expect(report.locator('.obs-report-count')).toHaveText('モノ 2・記録 4・画像 2・確認範囲 1');
  await report.locator('input[name=report-title]').fill('weekly');
  await report.locator('input[name=report-records]').check();
  const download = page.waitForEvent('download');
  await report.getByRole('button', { name: 'HTML 保存' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^weekly_\d{8}\.html$/);
  const html = await textOf(file);
  expect(html).toContain('<h1>weekly</h1>');
  expect(html).toContain('モノ 2 件（最新で所在 1・不在 1）・記録 4 件・画像 2 枚・確認範囲 1 件');
  expect(html).toContain('<img src="data:image/jpeg;base64,');
  expect(html).toContain('桟橋周辺');
  expect(html).toContain('<h2>記録一覧</h2>');
  expect(errors).toEqual([]);
});

test('a script reads and writes the records, checked areas and candidates, asking once before writing', async ({ page }) => {
  await openImages(page);
  await openPanel(page);
  await page.locator('.obs-dialog .catalog-close').click();
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.accept();
  });
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.getByRole('button', { name: 'スクリプト…' }).click();
  const scripts = page.getByRole('dialog', { name: 'スクリプト' });
  await scripts.getByLabel('スクリプト（JavaScript）').fill(`
const images = await viewer.observationImages();
const [first, second] = images;
const centre = [(first.bbox[0] + first.bbox[2]) / 2, (first.bbox[1] + first.bbox[3]) / 2];
const a = await viewer.addObservation({ image: first.id, lon: centre[0], lat: centre[1], object: '作業船', kind: '船舶', activity: '工事', confidence: '確定' });
await viewer.addObservation({ image: first.id, lon: centre[0] + 0.001, lat: centre[1], object: '台船', kind: '船舶' });
const near = await viewer.observationCandidates({ image: second.id, lon: centre[0], lat: centre[1] + 0.0002, kind: '船舶' });
await viewer.addObservation({ image: second.id, lon: centre[0], lat: centre[1] + 0.0002, object: near[0].name, confidence: '推定' });
await viewer.addCheckedArea({ image: second.id, bbox: [centre[0] + 0.0005, centre[1] - 0.0005, centre[0] + 0.0015, centre[1] + 0.0005], kind: '船舶', note: 'スクリプト' });
await viewer.updateObservation(a.id, { note: '浚渫' });
let bad = '';
try { await viewer.addObservation({ image: first.id, lon: 0, lat: 0, confidence: 'たぶん' }); } catch (e) { bad = e.message; }
const things = await viewer.observedThings({ kind: '船舶' });
print(JSON.stringify({ images: images.length, near: near.map((c) => c.name), things: things.map((t) => [t.name, t.seen]), areas: (await viewer.checkedAreas()).map((x) => x.note), records: (await viewer.observations({ object: '作業船' })).map((r) => [r.confidence, r.note]), levels: (await viewer.confidences()).length, bad }));
`);
  await scripts.getByRole('button', { name: '実行' }).click();
  await expect(scripts.getByRole('button', { name: '実行' })).toBeEnabled({ timeout: 30_000 });
  const out = JSON.parse((await scripts.locator('.script-output').textContent())!.trim());
  expect(out).toEqual({
    images: 3,
    near: ['作業船', '台船'],
    things: [
      ['作業船', 2],
      ['台船', 1],
    ],
    areas: ['スクリプト'],
    records: [
      ['確定', '浚渫'],
      ['推定', ''],
    ],
    levels: 3,
    bad: '確度「たぶん」なし（確定・推定・不明）',
  });
  // One question for the whole run.
  expect(dialogs).toEqual([expect.stringContaining('観測記録（保存先: このブラウザ）に書き込もう')]);
});
