import { expect, test, type Page } from '@playwright/test';
import { writeArrayBuffer } from 'geotiff';
import { toBase64 } from './fixtures.js';

/*
 * Change detection from the processing dialog: two dates compared on one
 * grid, the change image in blue-white-red around "no change", and what
 * changed outlined as a temporary polygon layer.
 */

async function open(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

async function choose(page: Page, files: Array<{ name: string; bytes: Uint8Array }>) {
  for (const f of files) {
    await page.evaluate((f) => {
      const list = new DataTransfer();
      list.items.add(new File([Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))], f.name));
      const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
      input.files = list.files;
      input.dispatchEvent(new Event('change'));
    }, { name: f.name, base64: toBase64(f.bytes) });
    await expect(page.locator('#images .name', { hasText: f.name })).toHaveCount(1);
  }
}

/** A one-band 16-bit UTM 54N GeoTIFF of 32 × 32 px of 2 m. */
function tiff(value: (x: number, y: number) => number): Uint8Array {
  const size = 32;
  const values = new Uint16Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) values[y * size + x] = value(x, y);
  return new Uint8Array(
    writeArrayBuffer(values, {
      width: size,
      height: size,
      SamplesPerPixel: 1,
      BitsPerSample: [16],
      SampleFormat: [1],
      PhotometricInterpretation: 1,
      ModelPixelScale: [2, 2, 0],
      ModelTiepoint: [0, 0, 0, 380000, 3950000, 0],
      ProjectedCSTypeGeoKey: 32654,
      GTModelTypeGeoKey: 1,
      GTRasterTypeGeoKey: 1,
    }),
  );
}

const base = (x: number, y: number) => 1000 + x * 3 + (y % 2);
// A new building (8 × 8 px brighter) and a cleared one (6 × 6 px darker).
const after = (x: number, y: number) => base(x, y) + (x >= 4 && x < 12 && y >= 4 && y < 12 ? 800 : 0) - (x >= 20 && x < 26 && y >= 20 && y < 26 ? 600 : 0);

test('compares two dates, colors the change around no change, and outlines what changed', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await choose(page, [
    { name: 'site_2024.tif', bytes: tiff(base) },
    { name: 'site_2025.tif', bytes: tiff(after) },
  ]);
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#processing').click();
  await page.locator('.processing-dialog').first().getByLabel('処理').selectOption('change');
  const dialog = page.locator('.change-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('前の画像').locator('option:checked')).toHaveText('site_2024.tif');
  await expect(dialog.getByLabel('後の画像').locator('option:checked')).toHaveText('site_2025.tif');
  await expect(dialog.locator('.composite-plan')).toContainText('32 × 32 px');
  await dialog.getByRole('button', { name: '実行' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#status')).toContainText('変化 2 か所');

  const state = await page.evaluate(async () => {
    const { images } = window.viewer;
    const layers = images.layers();
    const polygons = layers[0];
    const image = images.list()[0];
    const tiff = image.source.getTiffImages()[0][0] as { readRasters(o: object): Promise<ArrayLike<number>[]> };
    const [band] = await tiff.readRasters({ window: [0, 5, 32, 6] });
    return {
      polygons: polygons.type === 'service' ? polygons.service.vector!.source.getFeatures().map((f) => [f.get('方向'), f.get('画素数'), Math.round(f.get('面積_m2'))]).sort() : null,
      row: Array.from(band),
      image: image.name,
      scale: image.layer.getColorScale()?.scale,
      stretch: image.source.getFixedRawStretch(),
    };
  });
  expect(state.image).toBe('site_2024_site_2025_difference.tif');
  expect(state.polygons).toEqual([
    ['増加', 64, 256],
    ['減少', 36, 144],
  ]);
  expect(state.row.slice(0, 4)).toEqual([0, 0, 0, 0]);
  expect(state.row.slice(4, 12)).toEqual(new Array(8).fill(800));
  expect(state.scale).toBe('blueWhiteRed');
  // Symmetric around 0.
  expect(state.stretch!.black).toBe(-(state.stretch!.white as number));
  expect(errors).toEqual([]);
});

test('takes a threshold and a direction', async ({ page }) => {
  await open(page);
  await choose(page, [
    { name: 'site_2024.tif', bytes: tiff(base) },
    { name: 'site_2025.tif', bytes: tiff(after) },
  ]);
  await page.evaluate(() => void window.viewer.change.open());
  const dialog = page.locator('.change-dialog');
  await dialog.getByLabel('比べ方').selectOption('ratio');
  await dialog.locator('summary', { hasText: '詳細設定' }).click();
  await dialog.getByLabel('しきい値').fill('0.3');
  await dialog.getByLabel('向き').selectOption('decrease');
  await dialog.getByRole('button', { name: '実行' }).click();
  await expect(page.locator('#status')).toContainText('変化 1 か所（0.7 以下）');
});
