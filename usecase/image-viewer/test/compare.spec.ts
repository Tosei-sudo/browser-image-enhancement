import { expect, test, type Page } from '@playwright/test';

/*
 * Swipe comparison and the histogram, under the information panel:
 * /fixture16.tif opened over /fixture.tif (the same area) shows on the left
 * of the line only, and the histogram counts the selected image as shown.
 */

/** Waits for the map to finish drawing. */
const rendered = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        window.viewer.map.once('rendercomplete', () => resolve());
        window.viewer.map.render();
      }),
  );

/** Alpha of what the top image draws (into its own canvas) at fractions of the map's width, across the middle. */
const alphaAt = (page: Page, xs: number[]) =>
  page.evaluate(
    (xs) =>
      new Promise<number[]>((resolve) => {
        const layer = window.viewer.images.list()[0].layer;
        layer.once('postrender', (e) => {
          const canvas = (e.context as WebGLRenderingContext).canvas as HTMLCanvasElement;
          const ctx = document.createElement('canvas').getContext('2d')!;
          ctx.canvas.width = canvas.width;
          ctx.canvas.height = canvas.height;
          ctx.drawImage(canvas, 0, 0);
          resolve(xs.map((f) => ctx.getImageData(Math.round(canvas.width * f), Math.round(canvas.height / 2), 1, 1).data[3]));
        });
        window.viewer.map.render();
      }),
    xs,
  );

test('the swipe line shows the selected image on one side, and moves', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/index.html?url=/fixture.tif&url=/fixture16.tif');
  await expect(page.locator('#status')).toContainText('fixture16.tif を開きました');
  await expect.poll(() => page.evaluate(() => window.viewer.images.list().length)).toBe(2);
  // Fill the map with the images, so both sides of the line are over them.
  await page.evaluate(async () => {
    const { images, map } = window.viewer;
    await images.zoomTo(images.list()[0]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    map.getView().setResolution(map.getView().getResolution()! / 4);
  });
  await rendered(page);
  expect(await alphaAt(page, [0.4, 0.6])).toEqual([255, 255]);

  await page.getByRole('button', { name: 'スワイプ比較' }).click();
  await expect(page.locator('#swipe')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#status')).toContainText('fixture16.tif を線の左側だけに表示しています');
  await rendered(page);
  expect(await alphaAt(page, [0.4, 0.6])).toEqual([255, 0]);

  // Drag the line to a quarter of the width.
  const box = (await page.locator('#map').boundingBox())!;
  const handle = page.locator('.swipe-handle');
  const at = (await handle.boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.25, at.y + at.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.viewer.swipe.getPosition())).toBeCloseTo(0.25, 1);
  await rendered(page);
  expect(await alphaAt(page, [0.2, 0.4])).toEqual([255, 0]);

  // Keyboard: the arrows move it, Esc ends the swipe and the whole image shows again.
  await handle.focus();
  await page.keyboard.press('End');
  expect(await page.evaluate(() => window.viewer.swipe.getPosition())).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#swipe')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.swipe-bar')).toBeHidden();
  await rendered(page);
  expect(await alphaAt(page, [0.2, 0.4, 0.6])).toEqual([255, 255, 255]);
  expect(errors).toEqual([]);
});

test('the histogram counts the selected image as shown, before or after its correction', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/index.html?url=/fixture.tif');
  await expect(page.locator('#status')).toContainText('fixture.tif を開きました');
  await rendered(page);

  await page.getByRole('button', { name: 'ヒストグラム' }).click();
  const panel = page.locator('#histogram');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.histogram-note')).toContainText('画素');
  const after = await page.evaluate(() => window.viewer.histogram.getHistogram()!);
  expect(after.mode).toBe('rgb');
  expect(after.count).toBeGreaterThan(1000);
  await expect(panel.locator('.histogram-stats tr')).toHaveCount(4);

  // Before the correction, blue is 120 everywhere in the fixture.
  await panel.getByLabel('ヒストグラムの対象').selectOption('before');
  await expect(panel.locator('.histogram-note')).toContainText('補正前');
  const blue = await page.evaluate(() => {
    const bins = window.viewer.histogram.getHistogram()!.bins[2];
    let peak = 0;
    for (let v = 0; v < 256; v++) if (bins[v] > bins[peak]) peak = v;
    return peak;
  });
  expect(Math.abs(blue - 120)).toBeLessThanOrEqual(1);

  // The value under the pointer.
  const canvas = panel.locator('canvas');
  await canvas.scrollIntoViewIfNeeded();
  const width = await canvas.evaluate((c) => c.clientWidth);
  await canvas.hover({ position: { x: width * (120.5 / 256), y: 50 } });
  await expect(panel.locator('.histogram-readout')).toContainText('値 120');

  await page.getByRole('button', { name: 'ヒストグラム' }).click();
  await expect(panel).toBeHidden();
  expect(errors).toEqual([]);
});
