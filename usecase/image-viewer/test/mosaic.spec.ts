import { expect, test, type Page } from '@playwright/test';
import { fromArrayBuffer, writeArrayBuffer } from 'geotiff';
import { toBase64 } from './fixtures.js';

/*
 * Mosaics from the processing dialog: neighbouring RGB scenes joined into
 * one, the top layer winning where they overlap and the next one showing
 * through its black collar, with or without feathered seams.
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

const ORIGIN = [380000, 3950000];

/** A 3-band 8-bit UTM 54N GeoTIFF, 40 px of 1 m from `origin`, of `rgb` but black from column `collar` on. */
function scene(origin: number[], rgb: number[], collar = 40): Uint8Array {
  const size = 40;
  const values = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) for (let b = 0; b < 3; b++) values[(y * size + x) * 3 + b] = x < collar ? rgb[b] + (y % 3) : 0;
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

async function processing(page: Page, tool: string) {
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#processing').click();
  await page.locator('.processing-dialog').first().getByLabel('処理').selectOption(tool);
}

/** The bytes of a download. */
async function downloaded(page: Page, click: () => Promise<void>): Promise<ArrayBuffer> {
  const download = page.waitForEvent('download');
  await click();
  const chunks: Buffer[] = [];
  for await (const chunk of await (await download).createReadStream()) chunks.push(chunk as Buffer);
  const bytes = Buffer.concat(chunks);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer;
}

test('joins neighbouring scenes into one, the first on top and the next through its black collar, and saves it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  // West (2025): red, black from column 36 on. East (2024): blue, from 30 m east (overlapping 10 columns). East opens last, so it is on top.
  await choose(page, [
    { name: 'west_20250105.tif', bytes: scene(ORIGIN, [200, 40, 40], 36) },
    { name: 'east_20240105.tif', bytes: scene([ORIGIN[0] + 30, ORIGIN[1]], [40, 40, 200]) },
  ]);

  await processing(page, 'mosaic');
  const dialog = page.locator('.mosaic-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.mosaic-list li')).toHaveText([/^east/, /^west/]);
  await expect(dialog.locator('.mosaic-plan')).toContainText('結果は 70 × 40 px、3 バンド（8 bit）');
  await page.screenshot({ path: 'test-results/mosaic-dialog.png' });

  // Two at least. The newest first (dates from the names): west, though under east on the map.
  await dialog.locator('.mosaic-list li').first().getByRole('checkbox').uncheck();
  await expect(dialog.locator('.mosaic-plan')).toContainText('2 枚以上');
  await expect(dialog.getByRole('button', { name: '実行' })).toBeDisabled();
  await dialog.locator('.mosaic-list li').first().getByRole('checkbox').check();
  await dialog.getByLabel('優先順').selectOption('newest');
  await expect(dialog.locator('.mosaic-list li')).toHaveText(['west_20250105.tif2025-01-05', 'east_20240105.tif2024-01-05']);

  await dialog.getByRole('button', { name: '実行' }).click();
  await expect(page.locator('#status')).toContainText('west_20250105_east_20240105_mosaic.tif を作りました（2 枚、70 × 40 px）');
  await expect(page.locator('#images .name').first()).toHaveText('モザイクwest_20250105_east_20240105_mosaic.tif');
  await page.screenshot({ path: 'test-results/mosaic-result.png' });

  await processing(page, 'mosaic');
  const bytes = await downloaded(page, () => dialog.getByRole('button', { name: '選択中の結果を GeoTIFF 保存' }).click());
  const image = await (await fromArrayBuffer(bytes)).getImage();
  expect([image.getWidth(), image.getHeight(), image.getSamplesPerPixel(), image.getBitsPerSample()]).toEqual([70, 40, 3, 8]);
  expect(image.getOrigin().slice(0, 2)).toEqual(ORIGIN);
  expect(image.getGeoKeys()?.ProjectedCSTypeGeoKey).toBe(32654);
  // A middle row (rows cycle +0, +1, +2): row 20 is +2.
  const row = (await image.readRasters({ interleave: true, window: [0, 20, 70, 21] })) as unknown as Uint8Array;
  const at = (x: number) => Array.from(row.subarray(x * 3, x * 3 + 3));
  expect(at(10)).toEqual([202, 42, 42]); // west alone
  expect(at(32)).toEqual([202, 42, 42]); // the overlap: west, first
  expect(at(37)).toEqual([42, 42, 202]); // west's black collar is no data: east shows through
  expect(at(65)).toEqual([42, 42, 202]);

  // Again in the layer order (east first) with feathered seams, leaving the mosaic just made (now the top layer) out.
  await dialog.getByLabel('優先順').selectOption('layers');
  await dialog.locator('.mosaic-list li').first().getByRole('checkbox').uncheck();
  await expect(dialog.locator('.mosaic-list li').getByRole('checkbox', { checked: true })).toHaveCount(2);
  await dialog.getByLabel('境界をぼかしてつなぐ').check();
  await dialog.locator('summary').click();
  await dialog.getByLabel('ぼかす幅').fill('4');
  await dialog.getByLabel('ぼかす幅').dispatchEvent('change');
  await dialog.getByRole('button', { name: '実行' }).click();
  await expect(page.locator('#images .name').first()).toHaveText('モザイクeast_20240105_west_20250105_mosaic.tif');
  await expect(page.locator('#images .image')).toHaveCount(4);
  const feathered = await downloaded(page, async () => {
    await processing(page, 'mosaic');
    await dialog.getByRole('button', { name: '選択中の結果を GeoTIFF 保存' }).click();
  });
  const row2 = (await (await (await fromArrayBuffer(feathered)).getImage()).readRasters({ interleave: true, window: [0, 20, 70, 21] })) as unknown as Uint8Array;
  const at2 = (x: number) => Array.from(row2.subarray(x * 3, x * 3 + 3));
  expect(at2(29)).toEqual([202, 42, 42]);
  // East's first column is a quarter east over west, the next half; 4 px in, east alone.
  expect(at2(30)).toEqual([162, 42, 82]);
  expect(at2(31)).toEqual([122, 42, 122]);
  expect(at2(33)).toEqual([42, 42, 202]);
  expect(errors).toEqual([]);
});
