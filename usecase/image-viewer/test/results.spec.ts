import { expect, test, type Page } from '@playwright/test';
import { fromArrayBuffer, writeArrayBuffer } from 'geotiff';
import { toBase64 } from './fixtures.js';

/*
 * Processing results kept in the browser: a mosaic is written into the
 * browser's storage as it is made, saved from its row as a COG (overviews,
 * Deflate) or as made, and still there after a reload, to open again or
 * delete from 「処理結果」.
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
const W = 400;
const H = 300;

/** A 3-band 8-bit UTM 54N GeoTIFF of W × H px of 1 m from `origin`: a ramp of `rgb`. */
function scene(origin: number[], rgb: number[]): Uint8Array {
  const values = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let b = 0; b < 3; b++) values[(y * W + x) * 3 + b] = rgb[b] + ((x + y) % 50);
  return new Uint8Array(
    writeArrayBuffer(values, {
      width: W,
      height: H,
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

/** The bytes and name of a download. */
async function downloaded(page: Page, click: () => Promise<void>): Promise<{ name: string; bytes: ArrayBuffer }> {
  const download = page.waitForEvent('download');
  await click();
  const file = await download;
  const chunks: Buffer[] = [];
  for await (const chunk of await file.createReadStream()) chunks.push(chunk as Buffer);
  const bytes = Buffer.concat(chunks);
  return { name: file.suggestedFilename(), bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer };
}

const RESULT = 'east_west_mosaic.tif';

test('a mosaic is kept in the browser, saved from its row as a COG or as made, and opened again after a reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await choose(page, [
    { name: 'west.tif', bytes: scene(ORIGIN, [150, 40, 40]) },
    { name: 'east.tif', bytes: scene([ORIGIN[0] + 200, ORIGIN[1]], [40, 40, 150]) },
  ]);
  // Opened files have no save button.
  await expect(page.locator('#images .image', { hasText: 'west.tif' }).locator('button[data-action=save]')).toBeHidden();

  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#processing').click();
  await page.locator('.processing-dialog').first().getByLabel('処理').selectOption('mosaic');
  const mosaic = page.locator('.mosaic-dialog');
  await mosaic.getByRole('button', { name: '実行' }).click();
  await expect(page.locator('#status')).toContainText(`${RESULT} を作成（2 枚、600 × 300 px）`);
  const row = page.locator('#images .image', { hasText: RESULT });
  const save = row.locator('button[data-action=save]');
  await expect(save).toBeVisible();
  await expect(page.locator('#results-open')).toHaveText('処理結果（1）…');

  // As a COG: overviews down to one tile, Deflate with the predictor, GDAL's COG layout note.
  await save.click();
  const dialog = page.locator('.result-save');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.result-save-what')).toContainText(`「${RESULT}」（モザイク、`);
  await expect(dialog.locator('.result-save-what')).toContainText('ブラウザ内に保存済み');
  await expect(dialog.getByRole('radio', { name: /COG/ })).toBeChecked();
  await page.screenshot({ path: 'test-results/result-save.png' });
  const cog = await downloaded(page, () => dialog.getByRole('button', { name: '保存', exact: true }).click());
  expect(cog.name).toBe(RESULT);
  await expect(dialog).toBeHidden();
  await expect(page.locator('#status')).toContainText(`${RESULT} を保存`);
  expect(new TextDecoder('latin1').decode(new Uint8Array(cog.bytes, 8, 60))).toContain('LAYOUT=COG');
  const tiff = await fromArrayBuffer(cog.bytes);
  expect(await tiff.getImageCount()).toBe(3);
  const full = await tiff.getImage(0);
  expect([full.getWidth(), full.getHeight(), full.getSamplesPerPixel(), full.getTileWidth()]).toEqual([600, 300, 3, 256]);
  expect(full.fileDirectory.getValue('Compression')).toBe(8);
  expect(full.getOrigin().slice(0, 2)).toEqual(ORIGIN);
  expect(full.getGeoKeys()?.ProjectedCSTypeGeoKey).toBe(32654);
  const pixel = (await full.readRasters({ interleave: true, window: [10, 20, 11, 21] })) as unknown as Uint8Array;
  expect(Array.from(pixel)).toEqual([150 + 30, 40 + 30, 40 + 30]);
  expect([(await tiff.getImage(1)).getWidth(), (await tiff.getImage(2)).getWidth()]).toEqual([300, 150]);

  // As made: uncompressed, saved at once.
  await save.click();
  await dialog.getByRole('radio', { name: /^GeoTIFF/ }).check();
  await expect(dialog.locator('.result-save-details')).toBeHidden();
  await dialog.getByLabel('ファイル名').fill('as-made');
  const raw = await downloaded(page, () => dialog.getByRole('button', { name: '保存', exact: true }).click());
  expect(raw.name).toBe('as-made.tif');
  const plain = await (await fromArrayBuffer(raw.bytes)).getImage();
  expect(plain.fileDirectory.getValue('Compression')).toBe(1);
  expect(raw.bytes.byteLength).toBeGreaterThan(cog.bytes.byteLength);

  // After a reload: listed in 「処理結果」, opened again with its save button.
  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);
  await expect(page.locator('#results-open')).toHaveText('処理結果（1）…');
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#results-open').click();
  const list = page.locator('.results-dialog');
  await expect(list.locator('.results-list li')).toHaveCount(1);
  await expect(list.locator('.results-name')).toHaveText(RESULT);
  await expect(list.locator('.results-meta')).toContainText('モザイク・');
  await page.screenshot({ path: 'test-results/results-dialog.png' });
  await list.getByRole('button', { name: `${RESULT} を開く` }).click();
  await expect(page.locator('#images .name').first()).toHaveText(`モザイク${RESULT}`);
  await expect(list.locator('.results-meta')).toContainText('表示中');
  await expect(list.getByRole('button', { name: `${RESULT} を開く` })).toBeDisabled();
  await list.getByRole('button', { name: '閉じる' }).click();
  await expect(page.locator('#images .image', { hasText: RESULT }).locator('button[data-action=save]')).toBeVisible();

  // Deleted: the layer closes with it.
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#results-open').click();
  page.once('dialog', (d) => void d.accept());
  await list.getByRole('button', { name: `${RESULT} を削除` }).click();
  await expect(list.locator('.results-none')).toHaveText('ブラウザに保存された処理結果なし');
  await expect(page.locator('#images .image')).toHaveCount(0);
  await expect(page.locator('#results-open')).toHaveText('処理結果…');
  expect(errors).toEqual([]);
});
