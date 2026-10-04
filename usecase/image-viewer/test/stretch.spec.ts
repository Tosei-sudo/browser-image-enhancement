import { expect, test } from '@playwright/test';

/*
 * 16-bit imagery (test/server.mjs serves /fixture16.tif, values 6000-15000
 * like a Landsat scene) is stretched band by band from its own values, as
 * QGIS does, instead of being squeezed into 0-255 over 0-65535 first.
 */

test('a 16-bit GeoTIFF is stretched from its own values, band by band', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/index.html?url=/fixture16.tif');
  await expect(page.locator('#status')).toContainText('fixture16.tif を開きました');
  await page.waitForFunction(() => window.viewer.images.list()[0]?.source.getDraInfo()?.rawStretch !== undefined);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        window.viewer.map.once('rendercomplete', () => resolve());
        window.viewer.map.render();
      }),
  );

  const stretch = await page.evaluate(() => window.viewer.images.list()[0].source.getDraInfo()!.rawStretch!);
  // Band 0 runs from 6000 to 10000: the stretch covers about that (2 % cut at each end), not 0-65535.
  expect(stretch.black[0]).toBeGreaterThan(6000);
  expect(stretch.white[0]).toBeLessThan(10000);
  // Each band has its own range: the brighter band 2 does not share band 0's.
  expect(stretch.black[2]).toBeGreaterThan(8400);

  const [left, right] = await page.evaluate(() => {
    const { map, images } = window.viewer;
    const [w, h] = map.getSize()!;
    const layer = images.list()[0].layer;
    return [0.35, 0.65].map((f) => Array.from(layer.getData([w * f, h / 2]) as Uint8Array));
  });
  // Band 0 uses the 8-bit range (0-65535 scaled to 0-255 would leave it between 23 and 39).
  expect(right[0] - left[0]).toBeGreaterThan(60);
  expect(errors).toEqual([]);
});
