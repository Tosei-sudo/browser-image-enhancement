import { expect, test, type Page } from '@playwright/test';
import { writeArrayBuffer } from 'geotiff';
import { toBase64 } from './fixtures.js';

/*
 * Band math from the processing dialog: NDVI of a four-band image with its
 * bands guessed, and an expression typed under 詳細設定.
 */

async function open(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

async function choose(page: Page, name: string, bytes: Uint8Array) {
  await page.evaluate((f) => {
    const list = new DataTransfer();
    list.items.add(new File([Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))], f.name));
    const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
    input.files = list.files;
    input.dispatchEvent(new Event('change'));
  }, { name, base64: toBase64(bytes) });
  await expect(page.locator('#images .name', { hasText: name })).toHaveCount(1);
}

/** 32 × 32 px, four 16-bit bands (blue, green, red, near infrared), UTM 54N: red 100, NIR 100 + 10·x. */
function fourBands(): Uint8Array {
  const size = 32;
  const values = new Uint16Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      values.set([50, 80, 100, 100 + 10 * x], i);
    }
  }
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

/** Samples of row 0 of the top image's first band. */
const firstRow = (page: Page) =>
  page.evaluate(async () => {
    const image = window.viewer.images.list()[0];
    const tiff = image.source.getTiffImages()[0][0] as { readRasters(o: object): Promise<ArrayLike<number>[]>; getWidth(): number; getSampleFormat(): number; getBitsPerSample(): number };
    const [band] = await tiff.readRasters({ window: [0, 0, tiff.getWidth(), 1] });
    return { values: Array.from(band), format: tiff.getSampleFormat(), bits: tiff.getBitsPerSample(), name: image.name };
  });

test('makes NDVI of a four-band image, its bands guessed, in vegetation colors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await choose(page, 'field.tif', fourBands());
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#processing').click();
  await page.locator('.processing-dialog').first().getByLabel('処理').selectOption('band-math');
  const dialog = page.locator('.band-math-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('近赤外（NIR）')).toHaveValue('3');
  await expect(dialog.getByLabel('赤（Red）')).toHaveValue('2');
  await expect(dialog.getByLabel('式', { exact: true })).toHaveValue('(B4 - B3) / (B4 + B3)');
  await expect(dialog.locator('.composite-plan')).toContainText('32 × 32 px');
  await dialog.getByRole('button', { name: '実行' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#status')).toContainText('field_ndvi.tif を作成');

  const row = await firstRow(page);
  expect(row.name).toBe('field_ndvi.tif');
  expect([row.format, row.bits]).toEqual([3, 32]);
  // (100 + 10x − 100) / (100 + 10x + 100)
  row.values.forEach((v, x) => expect(v).toBeCloseTo((10 * x) / (200 + 10 * x), 5));
  expect(await page.evaluate(() => Array.isArray(window.viewer.images.list()[0].layer.getColorScale()?.scale))).toBe(true);
  await expect(page.locator('#images .image').first().locator('.color-swatch')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('takes an expression of its own, and says what is wrong with one', async ({ page }) => {
  await open(page);
  await choose(page, 'field.tif', fourBands());
  await page.evaluate(() => void window.viewer.bandMath.open());
  const dialog = page.locator('.band-math-dialog');
  await dialog.locator('summary', { hasText: '詳細設定' }).click();
  const expression = dialog.getByLabel('式', { exact: true });
  await expression.fill('B4 - B9');
  await expect(dialog.getByLabel('指標')).toHaveValue('');
  await expect(dialog.locator('.composite-plan')).toContainText('B9');
  await expect(dialog.getByRole('button', { name: '実行' })).toBeDisabled();
  await expression.fill('if(B4 > 200, 1, 0)');
  await dialog.getByRole('button', { name: '実行' }).click();
  await expect(page.locator('#status')).toContainText('field_calc.tif を作成');
  const row = await firstRow(page);
  row.values.forEach((v, x) => expect(v).toBe(100 + 10 * x > 200 ? 1 : 0));
});
