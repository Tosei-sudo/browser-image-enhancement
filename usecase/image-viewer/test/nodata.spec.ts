import { expect, test, type Page } from '@playwright/test';

/*
 * No data drawn transparent: the file's own value and the usual fill values
 * by default, the black collar and other values from 「ノーデータの透明化」
 * (プロセッシング), saved in projects.
 */

/** Opens `url` and waits for its tiles to be drawn. */
async function open(page: Page, url: string): Promise<void> {
  await page.goto(`/index.html?url=${url}`);
  await expect(page.locator('#status')).toContainText('を表示');
  await page.waitForFunction(() => window.viewer.images.list()[0]?.source.getState() === 'ready');
  await drawn(page);
}

/** Waits until the map has drawn every tile. */
function drawn(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        window.viewer.map.once('rendercomplete', () => resolve());
        window.viewer.map.render();
      }),
  );
}

/** The image's pixels as drawn, across the middle row (the image spans about 0.25-0.75 of the map's width). */
function shown(page: Page, xs: number[]): Promise<number[][]> {
  return page.evaluate((fs) => {
    const { map } = window.viewer;
    const [w, h] = map.getSize()!;
    const canvas = document.querySelector<HTMLCanvasElement>('.ol-layers canvas.gpu-corrected')!;
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const ctx = copy.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(canvas, 0, 0);
    const ratio = canvas.width / w;
    return fs.map((f) => Array.from(ctx.getImageData(Math.floor(w * f * ratio), Math.floor((h / 2) * ratio), 1, 1).data));
  }, xs);
}

test('a black collar is made transparent from the no-data dialog, and saved in the project', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // A full URL, which a project can open again.
  await open(page, 'http://localhost:4175/fixture-collar.tif');
  // 0 is not no data by itself: a dark scene may hold it.
  let [collar, scene] = await shown(page, [0.3, 0.6]);
  expect(collar[3]).toBe(255);
  expect(scene[3]).toBe(255);

  await page.evaluate(() => window.viewer.noData.open());
  const dialog = page.locator('dialog.nodata-dialog');
  await expect(dialog.locator('.nodata-file')).toHaveText('ファイルのノーデータ値: なし');
  await dialog.getByLabel('黒い縁（すべてのバンドが 0 の画素）を透明化').check();
  await page.waitForFunction(() => window.viewer.images.list()[0].source.getNoData().values.includes(0));
  await drawn(page);
  [collar, scene] = await shown(page, [0.3, 0.6]);
  expect(collar[3]).toBe(0);
  expect(scene[3]).toBe(255);
  expect(scene[0]).toBeGreaterThan(40);

  await dialog.getByLabel('ほかに透明にする値').fill('255, abc');
  await dialog.getByLabel('ほかに透明にする値').press('Tab');
  await expect(dialog.locator('.processing-note')).toContainText('数字をカンマ区切り');
  await dialog.getByLabel('ほかに透明にする値').fill('255');
  await dialog.getByLabel('ほかに透明にする値').press('Tab');
  await page.waitForFunction(() => window.viewer.images.list()[0].source.getNoData().values.length === 2);

  const saved = await page.evaluate(() => window.viewer.project.collect().project.layers[0].noData);
  expect(saved).toEqual({ auto: true, values: [0, 255] });
  // Opened again from the project, the image keeps them.
  const reopened = await page.evaluate(async () => {
    const { project, images } = window.viewer;
    await project.open(project.collect().project, 'test.ivproj');
    return images.list()[0].source.getNoData();
  });
  expect(reopened).toEqual({ auto: true, values: [0, 255] });
  await page.evaluate(() => window.viewer.noData.open());

  await dialog.getByRole('button', { name: '既定に復元' }).click();
  await expect(dialog.getByLabel('黒い縁（すべてのバンドが 0 の画素）を透明化')).not.toBeChecked();
  expect(await page.evaluate(() => window.viewer.project.collect().project.layers[0].noData)).toBeUndefined();
  expect(errors).toEqual([]);
});

test('the file’s no-data value can be shown as it is', async ({ page }) => {
  await open(page, '/fixture-nodata.tif');
  let [fill] = await shown(page, [0.3]);
  expect(fill[3]).toBe(0);
  const value = await page.evaluate(() => window.viewer.images.list()[0].source.getFileNoData());
  expect(value).toBeCloseTo(-3.40282e38, -33);
  await page.evaluate(() => window.viewer.images.list()[0].source.setNoData({ auto: false }));
  await drawn(page);
  [fill] = await shown(page, [0.3]);
  expect(fill[3]).toBe(255);
});
