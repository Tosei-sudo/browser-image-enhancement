import { expect, test, type Page } from '@playwright/test';
import { writeArrayBuffer } from 'geotiff';
import { toBase64 } from './fixtures.js';

/*
 * Land cover classification from the processing dialog: a 3-band scene of
 * water, vegetation and bare ground put in classes automatically (k-means)
 * and from training polygons, the classes opened as a layer in their colors,
 * the table of areas, and the classes outlined as polygons.
 */

const LON0 = 139;
const LAT0 = 35;
const RES = 0.0001;
const SIZE = 40;

/** A 3-band 8-bit WGS 84 GeoTIFF: water left (x < 15), vegetation in the middle, bare ground right (x ≥ 30). */
function scene(): Uint8Array {
  const values = new Uint8Array(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const look = x < 15 ? [10, 20, 30] : x < 30 ? [40, 120, 50] : [200, 180, 160];
      for (let b = 0; b < 3; b++) values[(y * SIZE + x) * 3 + b] = look[b] + ((x + y * (b + 1)) % 3);
    }
  }
  return new Uint8Array(
    writeArrayBuffer(values, {
      width: SIZE,
      height: SIZE,
      SamplesPerPixel: 3,
      BitsPerSample: [8, 8, 8],
      SampleFormat: [1, 1, 1],
      PhotometricInterpretation: 2,
      PlanarConfiguration: 1,
      ModelPixelScale: [RES, RES, 0],
      ModelTiepoint: [0, 0, 0, LON0, LAT0, 0],
      GeographicTypeGeoKey: 4326,
      GTModelTypeGeoKey: 2,
      GTRasterTypeGeoKey: 1,
    }),
  );
}

async function choose(page: Page, name: string, bytes: Uint8Array) {
  await page.evaluate(
    (f) => {
      const list = new DataTransfer();
      list.items.add(new File([Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))], f.name));
      const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
      input.files = list.files;
      input.dispatchEvent(new Event('change'));
    },
    { name, base64: toBase64(bytes) },
  );
  await expect(page.locator('#images .name', { hasText: name })).toHaveCount(1);
}

/** A rectangle of pixels `[x0, y0, x1, y1]` as a GeoJSON polygon in lon / lat. */
const box = ([x0, y0, x1, y1]: number[]) => ({
  type: 'Polygon',
  coordinates: [
    [
      [LON0 + x0 * RES, LAT0 - y0 * RES],
      [LON0 + x1 * RES, LAT0 - y0 * RES],
      [LON0 + x1 * RES, LAT0 - y1 * RES],
      [LON0 + x0 * RES, LAT0 - y1 * RES],
      [LON0 + x0 * RES, LAT0 - y0 * RES],
    ],
  ],
});

/** Pixels per class of the classification made last. */
const counts = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLTableRowElement>('.classify-table tbody tr')].map((r) => [r.cells[0].textContent, r.cells[1].textContent]));

test('classifies automatically into the classes asked for, with their areas and outlines', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  await choose(page, 'scene.tif', scene());
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#processing').click();
  await page.locator('.processing-dialog').first().getByLabel('処理').selectOption('classify');
  const dialog = page.locator('.classify-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.composite-plan')).toContainText('40 × 40 px（3 バンド）を 6 クラス');
  await dialog.getByRole('spinbutton', { name: 'クラスの数' }).fill('3');
  await dialog.getByText('クラスごとにポリゴンにする').click();
  await dialog.getByRole('button', { name: '実行' }).click();
  await expect(dialog.locator('.processing-note')).toContainText('scene_分類.tif を作りました、ポリゴン 3 個');
  expect(await counts(page)).toEqual([
    ['クラス 1', '600'],
    ['クラス 2', '600'],
    ['クラス 3', '400'],
  ]);

  const state = await page.evaluate(async () => {
    const { images } = window.viewer;
    const image = images.list()[0];
    const tiff = image.source.getTiffImages()[0][0] as { readRasters(o: object): Promise<ArrayLike<number>> };
    const row = await tiff.readRasters({ window: [0, 0, 40, 1], interleave: true });
    const outlines = images.layers()[0];
    return {
      name: image.name,
      colors: [0, 20, 39].map((x) => Array.from(row).slice(4 * x, 4 * x + 4)),
      polygons: outlines.type === 'service' ? outlines.service.vector!.source.getFeatures().map((f) => [f.get('クラス'), f.get('画素数')]) : null,
    };
  });
  expect(state.name).toBe('scene_分類.tif');
  expect(state.colors).toEqual([
    [31, 119, 180, 255],
    [44, 160, 44, 255],
    [214, 39, 40, 255],
  ]);
  expect(state.polygons).toEqual([
    ['クラス 1', 600],
    ['クラス 2', 600],
    ['クラス 3', 400],
  ]);
  // About 9 m × 11 m a pixel at 35°N.
  const area = await dialog.locator('.classify-table tbody tr').first().locator('td').nth(2).textContent();
  expect(area).toMatch(/m²|ha/);
  expect(errors).toEqual([]);
});

test('classifies from training polygons named by an attribute', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  await choose(page, 'scene.tif', scene());
  const training = JSON.stringify({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: box([2, 2, 8, 10]), properties: { 種別: '水' } },
      { type: 'Feature', geometry: box([18, 20, 26, 30]), properties: { 種別: '植生' } },
      { type: 'Feature', geometry: box([33, 5, 38, 12]), properties: { 種別: '裸地' } },
      { type: 'Feature', geometry: box([33, 25, 38, 32]), properties: { 種別: '裸地' } },
    ],
  });
  await page.evaluate((text) => {
    const list = new DataTransfer();
    list.items.add(new File([text], 'training.geojson'));
    const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
    input.files = list.files;
    input.dispatchEvent(new Event('change'));
  }, training);
  await expect(page.locator('#images .name', { hasText: 'training' })).toHaveCount(1);

  await page.evaluate(() => window.viewer.classify.open());
  const dialog = page.locator('.classify-dialog');
  await dialog.getByText('学習ポリゴン（教師あり）').click();
  await expect(dialog.getByLabel('学習用のレイヤー').locator('option:checked')).toHaveText('training');
  await expect(dialog.getByLabel('クラス名の属性')).toHaveValue('種別');
  await expect(dialog.locator('.composite-plan')).toContainText('水・植生・裸地 の 3 クラス');
  for (const method of ['likelihood', 'distance']) {
    await dialog.getByLabel('分類方法').selectOption(method);
    await dialog.getByRole('button', { name: '実行' }).click();
    await expect(dialog.locator('.processing-note')).toContainText('を作りました');
    expect(await counts(page)).toEqual([
      ['水', '600'],
      ['植生', '600'],
      ['裸地', '400'],
    ]);
  }
  expect(errors).toEqual([]);
});
