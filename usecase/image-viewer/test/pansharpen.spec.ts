import { expect, test, type Page } from '@playwright/test';
import { fromArrayBuffer, writeArrayBuffer } from 'geotiff';
import { toBase64 } from './fixtures.js';

/*
 * Pan-sharpening from the processing dialog: a 16-bit panchromatic image and
 * a 4-band multispectral one at a quarter of its resolution make a new
 * 4-band layer at the panchromatic resolution, which can be saved.
 */

async function open(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

async function choose(page: Page, files: Array<{ name: string; bytes: Uint8Array }>) {
  await page.evaluate((files) => {
    const list = new DataTransfer();
    for (const f of files) list.items.add(new File([Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))], f.name));
    const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
    input.files = list.files;
    input.dispatchEvent(new Event('change'));
  }, files.map((f) => ({ name: f.name, base64: toBase64(f.bytes) })));
}

const SIZE = 256;
const F = 4;
/** Top-left corner in WGS 84 / UTM zone 54N, 1 m panchromatic pixels. */
const ORIGIN = [380000, 3950000];

/** UTM GeoTIFF of `bands` 16-bit bands. */
function utmTiff(values: Uint16Array, width: number, bands: number, pixel: number): Uint8Array {
  return new Uint8Array(
    writeArrayBuffer(values, {
      width,
      height: width,
      SamplesPerPixel: bands,
      BitsPerSample: new Array(bands).fill(16),
      SampleFormat: new Array(bands).fill(1),
      PhotometricInterpretation: bands >= 3 ? 2 : 1,
      ...(bands > 3 ? { ExtraSamples: new Array(bands - 3).fill(0) } : {}),
      ModelPixelScale: [pixel, pixel, 0],
      ModelTiepoint: [0, 0, 0, ORIGIN[0], ORIGIN[1], 0],
      ProjectedCSTypeGeoKey: 32654,
      GTModelTypeGeoKey: 1,
      GTRasterTypeGeoKey: 1,
    }),
  );
}

/** A bright square on a dark field, edges on odd pixels (inside multispectral pixels). */
const bright = (x: number, y: number) => x >= 97 && x < 159 && y >= 97 && y < 159;

function panTiff(): Uint8Array {
  const values = new Uint16Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) values[y * SIZE + x] = bright(x, y) ? 3000 : 1000;
  return utmTiff(values, SIZE, 1, 1);
}

function msTiff(): Uint8Array {
  const w = SIZE / F;
  const values = new Uint16Array(w * w * 4);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = 0; j < F; j++) for (let i = 0; i < F; i++) s += bright(x * F + i, y * F + j) ? 1 : 0;
      const share = s / (F * F);
      for (let b = 0; b < 4; b++) values[(y * w + x) * 4 + b] = Math.round((800 + 1600 * share) * (1 + b * 0.25));
    }
  }
  return utmTiff(values, w, 4, F);
}

test('pan-sharpens a multispectral image with a panchromatic one and saves the result', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await choose(page, [
    { name: 'scene_pan.tif', bytes: panTiff() },
    { name: 'scene_ms.tif', bytes: msTiff() },
  ]);
  await expect(page.locator('#images .name')).toHaveCount(2);

  // The image tools are in the processing dialog; choosing one opens its own dialog.
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#processing').click();
  await page.locator('.processing-dialog').first().getByLabel('処理').selectOption('pansharpen');
  const dialog = page.locator('.pansharpen-dialog');
  await expect(dialog).toBeVisible();
  // The one-band image is taken as the panchromatic one, the four-band one as the multispectral one.
  await expect(dialog.getByLabel('パンクロ画像')).toHaveValue(await optionValue(page, 'パンクロ画像', 'scene_pan.tif'));
  await expect(dialog.getByLabel('マルチスペクトル画像')).toHaveValue(await optionValue(page, 'マルチスペクトル画像', 'scene_ms.tif'));
  await expect(dialog.locator('.pansharpen-plan')).toContainText('解像度の比 1 : 4.00。結果は 256 × 256 px、4 バンド');

  await dialog.getByRole('button', { name: '実行' }).click();
  await expect(page.locator('#status')).toContainText('scene_ms_pansharpen.tif を作りました（256 × 256 px）');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#images .name').first()).toHaveText('パンシャープンscene_ms_pansharpen.tif');

  // Saved as a 4-band 16-bit GeoTIFF on the panchromatic grid, with the square's edge sharp.
  await page.locator('#images .name').first().click();
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#processing').click();
  await page.locator('.processing-dialog').first().getByLabel('処理').selectOption('pansharpen');
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '選択中の結果を GeoTIFF 保存' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('scene_ms_pansharpen.tif');
  const chunks: Buffer[] = [];
  for await (const chunk of await file.createReadStream()) chunks.push(chunk as Buffer);
  const bytes = Buffer.concat(chunks);
  const image = await (await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))).getImage();
  expect([image.getWidth(), image.getHeight(), image.getSamplesPerPixel(), image.getBitsPerSample()]).toEqual([256, 256, 4, 16]);
  expect(image.getOrigin().slice(0, 2)).toEqual(ORIGIN);
  expect(image.getResolution().slice(0, 2)).toEqual([1, -1]);
  expect(image.getGeoKeys()?.ProjectedCSTypeGeoKey).toBe(32654);
  const data = (await image.readRasters({ interleave: true, window: [90, 128, 105, 129] })) as unknown as Uint16Array;
  for (let b = 0; b < 4; b++) {
    const outside = data[(96 - 90) * 4 + b];
    const inside = data[(97 - 90) * 4 + b];
    // The multispectral image alone has a 4-pixel ramp here; the pan-sharpened one steps between pixels 96 and 97.
    expect(inside - outside).toBeGreaterThan(1000 * (1 + b * 0.25));
    expect(Math.abs(data[(92 - 90) * 4 + b] - outside)).toBeLessThan(150 * (1 + b * 0.25));
  }
  expect(errors).toEqual([]);
});

test('makes a large result at full resolution, in blocks that join without seams', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  // 2400 × 2200 panchromatic pixels: more than one block (2048) each way, and fitted on windows spread over it.
  const W = 2400;
  const H = 2200;
  const truth = (x: number, y: number) => 600 + ((x * 3 + y * 2) % 1600) + ((x >> 4) % 2) * 300;
  const pan = new Uint16Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) pan[y * W + x] = truth(x, y);
  const w = W / F;
  const h = H / F;
  const ms = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = 0; j < F; j++) for (let i = 0; i < F; i++) s += truth(x * F + i, y * F + j);
      for (let b = 0; b < 4; b++) ms[(y * w + x) * 4 + b] = Math.round((s / (F * F)) * (1 + b * 0.25));
    }
  }
  const tiff = (values: Uint16Array, width: number, height: number, bands: number, pixel: number) =>
    new Uint8Array(
      writeArrayBuffer(values, {
        width,
        height,
        SamplesPerPixel: bands,
        BitsPerSample: new Array(bands).fill(16),
        SampleFormat: new Array(bands).fill(1),
        PhotometricInterpretation: bands >= 3 ? 2 : 1,
        ...(bands > 3 ? { ExtraSamples: new Array(bands - 3).fill(0) } : {}),
        ModelPixelScale: [pixel, pixel, 0],
        ModelTiepoint: [0, 0, 0, ORIGIN[0], ORIGIN[1], 0],
        ProjectedCSTypeGeoKey: 32654,
        GTModelTypeGeoKey: 1,
        GTRasterTypeGeoKey: 1,
      }),
    );
  await choose(page, [
    { name: 'big_pan.tif', bytes: tiff(pan, W, H, 1, 1) },
    { name: 'big_ms.tif', bytes: tiff(ms, w, h, 4, F) },
  ]);
  await expect(page.locator('#images .name')).toHaveCount(2, { timeout: 30_000 });

  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#processing').click();
  await page.locator('.processing-dialog').first().getByLabel('処理').selectOption('pansharpen');
  const dialog = page.locator('.pansharpen-dialog');
  await expect(dialog.locator('.pansharpen-plan')).toContainText('結果は 2,400 × 2,200 px、4 バンド');
  await expect(dialog.locator('.pansharpen-plan')).not.toContainText('縮小');
  await dialog.getByRole('button', { name: '実行' }).click();
  await expect(page.locator('#status')).toContainText('big_ms_pansharpen.tif を作りました（2,400 × 2,200 px）', { timeout: 90_000 });
  // It opened like a chosen file: with an RSET made for it.
  await expect(page.locator('#images li').first()).toContainText('RSET');

  // The saved file: full resolution, and smooth across the block edges at x = 2048 and y = 2048.
  await page.locator('#images .name').first().click();
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#processing').click();
  await page.locator('.processing-dialog').first().getByLabel('処理').selectOption('pansharpen');
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '選択中の結果を GeoTIFF 保存' }).click();
  const chunks: Buffer[] = [];
  for await (const chunk of await (await download).createReadStream()) chunks.push(chunk as Buffer);
  const bytes = Buffer.concat(chunks);
  const image = await (await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))).getImage();
  expect([image.getWidth(), image.getHeight(), image.getSamplesPerPixel(), image.getBitsPerSample()]).toEqual([W, H, 4, 16]);
  expect(image.getResolution().slice(0, 2)).toEqual([1, -1]);
  const data = (await image.readRasters({ interleave: true, window: [2040, 2040, 2056, 2056] })) as unknown as Uint16Array;
  // Sharpened: the pan's detail is in every band, close to the truth scaled by the band's brightness, on both sides of the seams.
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      for (let b = 0; b < 4; b++) {
        const expected = truth(2040 + x, 2040 + y) * (1 + b * 0.25);
        expect(Math.abs(data[(y * 16 + x) * 4 + b] - expected)).toBeLessThan(0.08 * expected);
      }
    }
  }
  expect(errors).toEqual([]);
});

/** The value of the option of select `label` whose text starts with `name`. */
async function optionValue(page: Page, label: string, name: string): Promise<string> {
  return page
    .locator('.pansharpen-dialog')
    .getByLabel(label)
    .locator('option', { hasText: name })
    .getAttribute('value')
    .then((v) => v ?? '');
}
