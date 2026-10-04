import { expect, test } from '@playwright/test';

/*
 * A GeoTIFF's metadata dialog, and band names from the file in the band
 * assignment: test/server.mjs names the bands of /fixture16.tif Blue, Green,
 * Red and NIR in GDAL's metadata, as gdal_translate does.
 */

test('band names from GDAL metadata label the band selects, and the metadata dialog lists the file', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/index.html?url=/fixture16.tif');
  await expect(page.locator('#status')).toContainText('fixture16.tif を開きました');

  // The correction panel (open from the start) names each band.
  const red = page.locator('.ol-enhance-bands select').first();
  await expect(red.locator('option')).toHaveText(['バンド 1 (Blue)', 'バンド 2 (Green)', 'バンド 3 (Red)', 'バンド 4 (NIR)']);
  await expect(page.locator('#info')).toContainText('Blue, Green, Red, NIR');

  // False colour by name: NIR as red.
  await red.selectOption({ label: 'バンド 4 (NIR)' });
  await expect.poll(() => page.evaluate(() => window.viewer.images.list()[0].source.getSelect())).toEqual([3, 1, 2]);

  await page.locator('#metadata-open').click();
  const dialog = page.locator('.metadata-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('h2')).toHaveText('メタデータ — /fixture16.tif');
  await expect(dialog).toContainText('バンド 4');
  await expect(dialog).toContainText('NIR・UInt16');
  await expect(dialog).toContainText('EPSG:4326');
  await expect(dialog).toContainText('AREA_OR_POINT');
  await expect(dialog).toContainText('GDAL_METADATA（42112）');
  const sections = await page.evaluate(() => window.viewer.metadata.sections().map((s) => s.title));
  expect(sections).toEqual(['概要', 'バンド', '地理参照（GeoKeys）', 'GDAL メタデータ', 'IFD 構成', 'TIFF タグ（原画像）']);

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await dialog.getByRole('button', { name: 'JSON でコピー' }).click();
  await expect(page.locator('#status')).toHaveText('メタデータをコピーしました');
  const json = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(json['概要']['サイズ']).toBe('512 × 256 px');
  expect(json['バンド']['バンド 4']).toBe('NIR・UInt16');

  await dialog.getByRole('button', { name: '閉じる' }).click();
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});
