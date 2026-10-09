import { expect, test } from '@playwright/test';

/*
 * config.json's imageRules: an image whose file name matches a rule opens
 * with its correction and bands (/fixture16.tif names its bands Blue, Green,
 * Red and NIR); other images open as before, and the panel still changes them.
 */

const config = {
  imageRules: [
    { label: 'フォールスカラー', match: '^fixture16\\.TIF$', preset: 'satellite', enhance: { contrast: 0.2 }, bands: ['NIR', 'red', 2] },
    { label: '使われない', match: '16', enhance: { contrast: -0.5 } },
  ],
};

test('a matching file opens with the rule’s correction and bands', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config) }));
  await page.goto('/index.html?url=/fixture16.tif');
  await expect(page.locator('#status')).toHaveText('/fixture16.tif を開きました（設定「フォールスカラー」を適用）');

  await expect.poll(() => page.evaluate(() => window.viewer.images.list()[0].source.getSelect())).toEqual([3, 2, 1]);
  await expect(page.locator('.ol-enhance-bands select').first()).toHaveValue('3');
  const steps = await page.evaluate(() => window.viewer.enhance.getPipeline().toJSON().ops);
  expect(steps.find((s) => s.op === 'contrast')).toMatchObject({ amount: 0.2 });
  expect(steps.find((s) => s.op === 'autoStretch')).toMatchObject({ lowPercent: 2, highPercent: 2 });

  // The panel still decides from here.
  await page.locator('.ol-enhance-bands select').first().selectOption('2');
  await expect.poll(() => page.evaluate(() => window.viewer.images.list()[0].source.getSelect())).toEqual([2, 2, 1]);
  expect(errors).toEqual([]);
});

test('other files open as before', async ({ page }) => {
  await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config) }));
  await page.goto('/index.html?url=/fixture.tif');
  await expect(page.locator('#status')).toHaveText('/fixture.tif を開きました');
  const steps = await page.evaluate(() => window.viewer.images.list()[0].source.getPipeline().ops.length);
  expect(steps).toBe(0);
});

test('a rule’s bands the image does not have are reported, and the rest still applies', async ({ page }) => {
  const rules = { imageRules: [{ label: '8 バンド用', match: 'fixture16', enhance: { brightness: 0.1 }, bands: [8, 7, 6] }] };
  await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rules) }));
  await page.goto('/index.html?url=/fixture16.tif');
  await expect(page.locator('#status')).toContainText('設定「8 バンド用」のバンド割り当てを使えませんでした（バンド 8 はありません（4 バンドの画像です））');
  expect(await page.evaluate(() => window.viewer.images.list()[0].source.getSelect())).toBeNull();
  expect(await page.evaluate(() => window.viewer.enhance.getPipeline().get('brightness')?.amount)).toBe(0.1);
});
