import { expect, test, type Download, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fromArrayBuffer } from 'geotiff';

/*
 * "表示範囲を保存": the view as drawn (PNG, or an RGBA GeoTIFF placed where
 * the view is, also at twice the screen's size), and the selected GeoTIFF's
 * own samples under the view. /fixture.tif is 512 × 256 RGB in EPSG:4326
 * over 139.6–139.9 E, 35.6–35.75 N: red rises to the right, green downwards.
 */

async function open(page: Page) {
  await page.goto('/index.html?url=/fixture.tif');
  await expect(page.locator('#status')).toContainText('fixture.tif を開きました');
  await page.waitForFunction(() => window.viewer.map.getView().getResolution() !== undefined);
}

/** Saves through the dialog with the given choices; returns the download. */
async function save(page: Page, choices: { content?: string; format?: string; scale?: string }): Promise<Download> {
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#save-view').click();
  const dialog = page.locator('.view-export');
  await expect(dialog).toBeVisible();
  if (choices.content) await dialog.locator('select[name=content]').selectOption(choices.content);
  if (choices.format) await dialog.locator('select[name=format]').selectOption(choices.format);
  if (choices.scale) await dialog.locator('select[name=scale]').selectOption(choices.scale);
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '保存' }).click();
  return download;
}

async function tiffOf(download: Download) {
  const bytes = await readFile((await download.path())!);
  return (await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))).getImage();
}

test('the view saves as a PNG and as a georeferenced GeoTIFF, at the screen size or larger', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  const [width, height] = await page.evaluate(() => window.viewer.map.getSize()!);

  const png = await save(page, { format: 'png' });
  expect(png.suggestedFilename()).toBe('fixture_view.png');
  await expect(page.locator('#status')).toHaveText(`fixture_view.png を保存しました（${width} × ${height} px）`);
  // The image is drawn in the middle (corrected on the GPU), nothing at the corner of the checkerboard.
  const base64 = (await readFile((await png.path())!)).toString('base64');
  const [middle, corner, size] = await page.evaluate(async (base64) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: 'image/png' }));
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const px = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    return [px(bitmap.width >> 1, bitmap.height >> 1), px(0, 0), [bitmap.width, bitmap.height]];
  }, base64);
  expect(size).toEqual([width, height]);
  expect(middle[3]).toBe(255);
  expect(middle[2]).toBeGreaterThan(0);
  expect(corner[3]).toBe(0);

  // Twice the size, the same area: a GeoTIFF in the map's projection.
  const extent = await page.evaluate(() => window.viewer.map.getView().calculateExtent(window.viewer.map.getSize()));
  const tif = await tiffOf(await save(page, { format: 'geotiff', scale: '2' }));
  expect(tif.getWidth()).toBe(width * 2);
  expect(tif.getHeight()).toBe(height * 2);
  expect(tif.getSamplesPerPixel()).toBe(4);
  expect(tif.getGeoKeys()!.ProjectedCSTypeGeoKey).toBe(3857);
  const [x0, y0] = tif.getOrigin();
  const [rx, ry] = tif.getResolution();
  expect(x0).toBeCloseTo(extent[0], 3);
  expect(y0).toBeCloseTo(extent[3], 3);
  expect(rx * tif.getWidth()).toBeCloseTo(extent[2] - extent[0], 3);
  expect(-ry * tif.getHeight()).toBeCloseTo(extent[3] - extent[1], 3);
  // The map is back at its own size and view.
  expect(await page.evaluate(() => window.viewer.map.getSize())).toEqual([width, height]);
  expect(await page.evaluate(() => window.viewer.map.getView().calculateExtent(window.viewer.map.getSize()))).toEqual(extent);
  expect(errors).toEqual([]);
});

test("the selected GeoTIFF's samples under the view save with its bands, values and CRS", async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  // Zoom into part of the image.
  await page.evaluate(() => {
    const view = window.viewer.map.getView();
    const [x, y] = view.getCenter()!;
    view.setCenter([x - 5000, y + 2000]);
    view.setResolution(view.getResolution()! / 4);
  });
  await page.waitForFunction(() => new Promise((resolve) => window.viewer.map.once('rendercomplete', () => resolve(true))));

  const file = await save(page, { content: 'data' });
  expect(file.suggestedFilename()).toBe('fixture_clip.tif');
  const tif = await tiffOf(file);
  expect(tif.getSamplesPerPixel()).toBe(3);
  expect(tif.getBitsPerSample()).toBe(8);
  expect(tif.getGeoKeys()!.GeographicTypeGeoKey).toBe(4326);
  const res = 0.3 / 512;
  const [ox, oy] = tif.getOrigin();
  expect(tif.getResolution()[0]).toBeCloseTo(res, 12);
  // On the source's pixel grid, inside it, and smaller than it.
  const col = (ox - 139.6) / res;
  const row = (35.75 - oy) / (0.15 / 256);
  expect(Math.abs(col - Math.round(col))).toBeLessThan(1e-6);
  expect(Math.abs(row - Math.round(row))).toBeLessThan(1e-6);
  expect(tif.getWidth()).toBeLessThan(512);
  expect(tif.getHeight()).toBeLessThan(256);
  // The original values, not the corrected ones.
  const data = (await tif.readRasters({ interleave: true })) as Uint8Array;
  const w = tif.getWidth();
  for (const [x, y] of [[0, 0], [w - 1, tif.getHeight() - 1]]) {
    const i = (y * w + x) * 3;
    expect(data[i]).toBe(Math.round(((Math.round(col) + x) / 511) * 200));
    expect(data[i + 1]).toBe(Math.round(((Math.round(row) + y) / 255) * 200));
    expect(data[i + 2]).toBe(120);
  }
  await expect(page.locator('#status')).toContainText(`fixture_clip.tif を保存しました（${w} × ${tif.getHeight()} px、3 バンド）`);
  expect(errors).toEqual([]);
});

test('the data choice needs a GeoTIFF selected', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#save-view').click();
  const dialog = page.locator('.view-export');
  await expect(dialog.locator('option[value=data]')).toHaveAttribute('disabled', '');
  await expect(dialog.locator('select[name=content]')).toHaveValue('view');
  await dialog.getByRole('button', { name: 'キャンセル' }).click();
  await expect(dialog).toBeHidden();
});
