import { expect, test, type Page } from '@playwright/test';

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

/** Opens `url`, waits for its first raw stretch (deeper than 8 bits) and a drawn map, and reads pixels across the middle row. */
async function openAndRead(page: Page, url: string, xs: number[]): Promise<number[][]> {
  await page.goto(`/index.html?url=${url}`);
  await expect(page.locator('#status')).toContainText('を開きました');
  await page.waitForFunction(() => {
    const source = window.viewer.images.list()[0]?.source;
    return source?.getState() === 'ready' && source.getTiffImages().length > 0;
  });
  await page.waitForFunction(() => {
    const source = window.viewer.images.list()[0].source;
    const info = source.getDraInfo();
    return info?.rawStretch !== undefined || (source.getTiffImages()[0][0] as { getBitsPerSample(): number }).getBitsPerSample() === 8;
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        window.viewer.map.once('rendercomplete', () => resolve());
        window.viewer.map.render();
      }),
  );
  return page.evaluate((fs) => {
    const { map, images } = window.viewer;
    const [w, h] = map.getSize()!;
    const layer = images.list()[0].layer;
    return fs.map((f) => Array.from(layer.getData([w * f, h / 2]) as Uint8Array));
  }, xs);
}

/*
 * Satellite products some imagery came out all white from: the stretch must
 * follow the scene, not a fill value or statistics written in the file.
 */
test('a fill value not tagged as no data does not wash the scene out white', async ({ page }) => {
  // The image spans about 0.25-0.75 of the map's width; the fill is its left 40 %.
  const [fill, dark, mid, bright] = await openAndRead(page, '/fixture-fill.tif', [0.3, 0.48, 0.6, 0.73]);
  const stretch = await page.evaluate(() => window.viewer.images.list()[0].source.getDraInfo()!.rawStretch!);
  expect(stretch.black[0]).toBeGreaterThan(0);
  expect(fill[0]).toBe(0);
  // Before: black was the fill (-9999), and the whole scene drew at 255.
  expect(dark[0]).toBeLessThan(80);
  expect(mid[0]).toBeGreaterThan(80);
  expect(mid[0]).toBeLessThan(200);
  expect(bright[0]).toBeGreaterThan(200);
});

test('a float no-data value written rounded ("-3.40282e+38") still hides the fill', async ({ page }) => {
  const [fill, , mid] = await openAndRead(page, '/fixture-nodata.tif', [0.3, 0.48, 0.6]);
  // Transparent, as with an exact no-data value.
  expect(fill[3]).toBe(0);
  expect(mid[0]).toBeGreaterThan(80);
  expect(mid[0]).toBeLessThan(200);
});

test('an 8-bit image is not scaled by the statistics GDAL wrote for its first band', async ({ page }) => {
  const [, mid] = await openAndRead(page, '/fixture-stats.tif', [0.3, 0.5]);
  // Bands 1 and 2 hold about 150 here; scaled by band 0's 0-60 they were 255.
  expect(mid[1]).toBeLessThan(230);
  expect(mid[1]).toBeGreaterThan(60);
});
