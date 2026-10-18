import { expect, test, type Page } from '@playwright/test';
import { writeArrayBuffer } from 'geotiff';
import { toBase64 } from './fixtures.js';

/*
 * Files as inputs of the processing tools (📂 next to a tool's layer
 * choice), like ArcGIS's and QGIS's tool dialogs: the file is used without
 * being added to the map, and stays offered (📄) to the other tools.
 */

test.beforeEach(async ({ page }) => {
  // The ordinary file chooser (Playwright answers it), not the File System Access picker.
  await page.addInitScript(() => delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker);
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
});

/** Opens files the usual way (on the map). */
async function openOnMap(page: Page, name: string, bytes: Uint8Array) {
  await page.evaluate((f) => {
    const list = new DataTransfer();
    list.items.add(new File([Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))], f.name));
    const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
    input.files = list.files;
    input.dispatchEvent(new Event('change'));
  }, { name, base64: toBase64(bytes) });
  await expect(page.locator('#images .name', { hasText: name })).toHaveCount(1);
}

/** Chooses a file with a dialog's 📂 next to `field`. */
async function browse(page: Page, field: ReturnType<Page['locator']>, name: string, bytes: Uint8Array) {
  const button = field.locator('xpath=ancestor::*[contains(@class,"source-field")][1]').locator('.source-browse');
  await button.click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'ファイルを選ぶ…' }).click();
  await (await chooser).setFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
}

/** 32 × 32 px, four 16-bit bands (blue, green, red, near infrared), UTM 54N: red 100, NIR 100 + 10·x. */
function fourBands(): Uint8Array {
  const size = 32;
  const values = new Uint16Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) values.set([50, 80, 100, 100 + 10 * x], (y * size + x) * 4);
  return new Uint8Array(
    writeArrayBuffer(values, {
      width: size,
      height: size,
      SamplesPerPixel: 4,
      BitsPerSample: [16, 16, 16, 16],
      SampleFormat: [1, 1, 1, 1],
      PlanarConfiguration: 1,
      PhotometricInterpretation: 1,
      ExtraSamples: [0, 0, 0],
      ModelPixelScale: [10, 10, 0],
      ModelTiepoint: [0, 0, 0, 380000, 3950000, 0],
      ProjectedCSTypeGeoKey: 32654,
      GTModelTypeGeoKey: 1,
      GTRasterTypeGeoKey: 1,
    }),
  );
}

/** A 3-band 8-bit UTM 54N GeoTIFF, 40 px of 1 m from `origin`. */
function scene(origin: number[], rgb: number[]): Uint8Array {
  const size = 40;
  const values = new Uint8Array(size * size * 3);
  for (let i = 0; i < size * size; i++) values.set(rgb, i * 3);
  return new Uint8Array(
    writeArrayBuffer(values, {
      width: size,
      height: size,
      SamplesPerPixel: 3,
      BitsPerSample: [8, 8, 8],
      SampleFormat: [1, 1, 1],
      PlanarConfiguration: 1,
      PhotometricInterpretation: 2,
      ModelPixelScale: [1, 1, 0],
      ModelTiepoint: [0, 0, 0, origin[0], origin[1], 0],
      ProjectedCSTypeGeoKey: 32654,
      GTModelTypeGeoKey: 1,
      GTRasterTypeGeoKey: 1,
    }),
  );
}

test('runs band math on a file chosen in the dialog, without adding it to the map', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const view = await page.evaluate(() => ({ center: window.viewer.map.getView().getCenter(), resolution: window.viewer.map.getView().getResolution() }));
  const mapLayers = await page.evaluate(() => window.viewer.map.getLayers().getLength());
  await page.evaluate(() => void window.viewer.bandMath.open());
  const dialog = page.locator('.band-math-dialog');
  const image = dialog.getByLabel('画像', { exact: true });
  await browse(page, image, 'field.tif', fourBands());

  await expect(image.locator('option:checked')).toHaveText('📄 field.tif（4 バンド）');
  await expect(dialog.getByLabel('近赤外（NIR）')).toHaveValue('3');
  // Not on the map, nor in the list, and the view stayed where it was.
  await expect(page.locator('#images .name')).toHaveCount(0);
  expect(await page.evaluate(() => window.viewer.map.getLayers().getLength())).toBe(mapLayers);
  expect(await page.evaluate(() => window.viewer.images.sources().map((s) => s.name))).toEqual(['field.tif']);
  expect(await page.evaluate(() => ({ center: window.viewer.map.getView().getCenter(), resolution: window.viewer.map.getView().getResolution() }))).toEqual(view);

  await dialog.getByRole('button', { name: '実行' }).click();
  await expect(page.locator('#status')).toContainText('field_ndvi.tif を作りました');
  // Only the result is on the map.
  await expect(page.locator('#images .name')).toHaveCount(1);
  await expect(page.locator('#images .name')).toContainText('field_ndvi.tif');

  // The file stays offered to the other tools.
  await page.evaluate(() => window.viewer.panSharpen.open());
  await expect(page.locator('.pansharpen-dialog').getByLabel('マルチスペクトル画像').locator('option', { hasText: '📄 field.tif' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('adds a file to a mosaic next to an open image, ticked', async ({ page }) => {
  await openOnMap(page, 'west.tif', scene([380000, 3950000], [200, 40, 40]));
  await page.evaluate(() => void window.viewer.mosaic.open());
  const dialog = page.locator('.mosaic-dialog');
  await expect(dialog.locator('.mosaic-list li')).toHaveCount(1);
  await browse(page, dialog.locator('.mosaic-list'), 'east.tif', scene([380030, 3950000], [40, 40, 200]));
  await expect(dialog.locator('.mosaic-list li')).toHaveCount(2);
  await expect(dialog.locator('.mosaic-list li', { hasText: '📄 east.tif' }).locator('input')).toBeChecked();
  await expect(page.locator('#images .name')).toHaveCount(1);
  await dialog.getByRole('button', { name: '実行' }).click();
  await expect(page.locator('#images .name')).toHaveCount(2);
  expect(await page.evaluate(() => (window.viewer.images.list()[0].source.getTiffImages()[0][0] as { getWidth(): number }).getWidth())).toBe(70);
});

test('buffers a GeoJSON file chosen in the processing dialog', async ({ page }) => {
  const geojson = JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: { name: 'a' }, geometry: { type: 'Point', coordinates: [139.7, 35.68] } }],
  });
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#processing').click();
  const dialog = page.locator('.processing-dialog').first();
  const input = dialog.getByLabel('入力レイヤー');
  await expect(dialog.getByRole('button', { name: '実行' })).toBeDisabled();
  await browse(page, input, 'points.geojson', new TextEncoder().encode(geojson));
  await expect(input.locator('option:checked')).toHaveText('📄 points');
  await expect(page.locator('#images .name')).toHaveCount(0);
  await dialog.getByRole('button', { name: '実行' }).click();
  await expect(page.locator('#images .name')).toHaveCount(1);
  await expect(page.locator('#status')).toContainText('作成しました');
});
