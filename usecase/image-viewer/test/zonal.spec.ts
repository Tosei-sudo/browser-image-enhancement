import { expect, test, type Page } from '@playwright/test';
import { writeArrayBuffer } from 'geotiff';
import proj4 from 'proj4';
import { toBase64 } from './fixtures.js';

/*
 * Zonal statistics from the processing dialog: two fields over a four-band
 * image and one off it, counted per polygon into a temporary layer.
 */

async function open(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
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
  await expect(page.locator('#images .name', { hasText: name.replace(/\.[^.]+$/, '') })).not.toHaveCount(0);
}

/** 32 × 32 px of 10 m from (380000, 3950000) in UTM 54N, four 16-bit bands: 50, 80, 100 and 100 + 10·x. */
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

/** A square of pixels (columns c0…c1, rows r0…r1, ends excluded) as a WGS 84 ring. */
function pixelSquare(c0: number, r0: number, c1: number, r1: number): number[][] {
  const utm = '+proj=utm +zone=54 +datum=WGS84 +units=m +no_defs';
  const at = (c: number, r: number) => proj4(utm, 'EPSG:4326', [380000 + 10 * c, 3950000 - 10 * r]);
  return [at(c0, r0), at(c1, r0), at(c1, r1), at(c0, r1), at(c0, r0)];
}

const fields = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'west' }, geometry: { type: 'Polygon', coordinates: [pixelSquare(0, 0, 10, 10)] } },
    { type: 'Feature', properties: { name: 'east' }, geometry: { type: 'Polygon', coordinates: [pixelSquare(20, 5, 30, 15)] } },
    { type: 'Feature', properties: { name: 'away' }, geometry: { type: 'Polygon', coordinates: [pixelSquare(100, 100, 110, 110)] } },
  ],
});

test('counts each polygon’s pixels per band into a temporary layer', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await choose(page, 'field.tif', fourBands());
  await choose(page, 'fields.geojson', new TextEncoder().encode(fields));

  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#processing').click();
  await page.locator('.processing-dialog').first().getByLabel('処理').selectOption('zonal');
  const dialog = page.locator('.zonal-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('画像')).toContainText('field.tif');
  await expect(dialog.locator('input[name=band]')).toHaveCount(4);
  // Only B4, with the max as well.
  for (const b of ['B1', 'B2', 'B3']) await dialog.getByText(b, { exact: true }).click();
  await dialog.getByText('最大', { exact: true }).click();
  await dialog.getByRole('button', { name: '実行' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#status')).toContainText('_統計 を作成しました（3 件');
  await expect(page.locator('#status')).toContainText('1 件は画像の外');

  const rows = await page.evaluate(() => {
    const layer = window.viewer.images.layers().find((l) => l.name.endsWith('_統計'))!;
    if (layer.type !== 'service') return [];
    return layer.service.vector!.source.getFeatures().map((f) => ({ name: f.get('name'), mean: f.get('B4_mean'), max: f.get('B4_max'), count: f.get('B4_count'), b1: f.get('B1_mean') }));
  });
  rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  expect(rows).toEqual([
    { name: 'away', mean: null, max: null, count: 0, b1: undefined },
    { name: 'east', mean: 345, max: 390, count: 100, b1: undefined },
    { name: 'west', mean: 145, max: 190, count: 100, b1: undefined },
  ]);
  expect(errors).toEqual([]);
});
