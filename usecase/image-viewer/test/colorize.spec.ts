import { expect, test, type Page } from '@playwright/test';
import { fromArrayBuffer, writeArrayBuffer } from 'geotiff';
import { toBase64 } from './fixtures.js';

/*
 * One-band images of two dates, from the processing dialog: colored in a
 * color scale (red, cyan) and laid over each other, or made into an RGB
 * composite on one grid even though their grids differ.
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

/** A one-band 16-bit UTM 54N GeoTIFF, `size` pixels of `pixel` metres from `origin`. */
function tiff(size: number, pixel: number, origin: number[], value: (x: number, y: number) => number): Uint8Array {
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
      ModelPixelScale: [pixel, pixel, 0],
      ModelTiepoint: [0, 0, 0, origin[0], origin[1], 0],
      ProjectedCSTypeGeoKey: 32654,
      GTModelTypeGeoKey: 1,
      GTRasterTypeGeoKey: 1,
    }),
  );
}

/** Before: 32 px of 2 m, a ramp across. After: 64 px of 1 m, 10 m right of and below it, flat. */
const before = () => tiff(32, 2, ORIGIN, (x, y) => 1000 + x * 20 + (y % 2));
const after = () => tiff(64, 1, [ORIGIN[0] + 10, ORIGIN[1] - 10], (x, y) => 500 + ((x + y) % 7) * 10);

async function processing(page: Page, tool: string) {
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#processing').click();
  await page.locator('.processing-dialog').first().getByLabel('処理').selectOption(tool);
}

/** The middle pixel of what the layer of image `index` (top first) shows, once the map is drawn. */
const shown = (page: Page, index: number) =>
  page.evaluate(
    (index) =>
      new Promise<number[]>((resolve) => {
        window.viewer.map.once('rendercomplete', () => {
          const canvas = window.viewer.images.list()[index].layer.getOutputCanvas();
          const ctx = document.createElement('canvas').getContext('2d')!;
          ctx.canvas.width = canvas.width;
          ctx.canvas.height = canvas.height;
          ctx.drawImage(canvas, 0, 0);
          resolve(Array.from(ctx.getImageData(Math.round(canvas.width / 2), Math.round(canvas.height / 2), 1, 1).data));
        });
        window.viewer.map.render();
      }),
    index,
  );

test('opens the coloring from the layer row, on that image', async ({ page }) => {
  await open(page);
  await choose(page, [
    { name: 'scene_2024.tif', bytes: before() },
    { name: 'scene_2025.tif', bytes: after() },
  ]);
  // The lower row: scene_2024.tif.
  await page.locator('#images .image').nth(1).getByRole('button', { name: '着色（カラースケール・重ね方）' }).click();
  const dialog = page.locator('.colorize-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('画像', { exact: true }).locator('option:checked')).toHaveText('scene_2024.tif');
  await dialog.getByLabel('カラースケール').selectOption('blue');
  expect(await page.evaluate(() => window.viewer.images.list().map((i) => i.layer.getColorScale()?.scale ?? null))).toEqual([null, 'blue']);
  await expect(page.locator('#images .image').nth(1).locator('.color-swatch')).toHaveCount(1);
});

test('colors a one-band image in a scale, and lays two dates over each other in red and cyan', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await choose(page, [
    { name: 'scene_2024.tif', bytes: before() },
    { name: 'scene_2025.tif', bytes: after() },
  ]);

  await processing(page, 'colorize');
  const dialog = page.locator('.colorize-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('画像', { exact: true }).selectOption({ label: 'scene_2025.tif' });
  await dialog.getByLabel('カラースケール').selectOption('red');
  // At once on the map: the gray image is red now (a flat image is stretched to mid-gray or so).
  await expect.poll(async () => {
    const [r, g, b] = await shown(page, 0);
    return r > 0 && g === 0 && b === 0;
  }).toBe(true);
  await expect(page.locator('#images .image').first().locator('.color-swatch')).toHaveCount(1);

  // Two dates: the earlier in red, the later in cyan screened over it.
  await dialog.locator('.colorize-pair summary').click();
  await dialog.getByLabel('前の画像').selectOption({ label: 'scene_2024.tif' });
  await dialog.getByLabel('後の画像').selectOption({ label: 'scene_2025.tif' });
  await dialog.getByRole('button', { name: '赤とシアンで重ねる' }).click();
  await expect(page.locator('#status')).toContainText('scene_2024.tif を赤、scene_2025.tif をシアンで重ねました');
  const state = await page.evaluate(() =>
    window.viewer.images.list().map((i) => ({ name: i.name, scale: i.layer.getColorScale()?.scale, blend: i.layer.getBlendMode(), css: i.layer.getOutputCanvas().style.mixBlendMode })),
  );
  expect(state).toEqual([
    { name: 'scene_2025.tif', scale: 'cyan', blend: 'screen', css: 'screen' },
    { name: 'scene_2024.tif', scale: 'red', blend: 'normal', css: '' },
  ]);
  await expect.poll(async () => {
    const [r, g, b] = await shown(page, 0);
    return r === 0 && g > 0 && g === b;
  }).toBe(true);

  // Saved in a project, and back when it opens.
  const project = await page.evaluate(() => window.viewer.project.collect().project.layers.map((l) => ({ name: l.name, colorScale: l.colorScale, blend: l.blend })));
  expect(project).toEqual([
    { name: 'scene_2025.tif', colorScale: { scale: 'cyan' }, blend: 'screen' },
    { name: 'scene_2024.tif', colorScale: { scale: 'red' }, blend: undefined },
  ]);

  // No coloring any more.
  await dialog.getByLabel('画像', { exact: true }).selectOption({ label: 'scene_2025.tif' });
  await dialog.getByRole('button', { name: '着色をやめる' }).click();
  expect(await page.evaluate(() => [window.viewer.images.list()[0].layer.getColorScale(), window.viewer.images.list()[0].layer.getBlendMode()])).toEqual([null, 'normal']);
  await expect(page.locator('#images .image').first().locator('.color-swatch')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('makes an RGB composite of two dates on different grids, and saves it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await choose(page, [
    { name: 'scene_2024.tif', bytes: before() },
    { name: 'scene_2025.tif', bytes: after() },
  ]);
  await processing(page, 'composite');
  const dialog = page.locator('.composite-dialog');
  await expect(dialog).toBeVisible();
  // The earlier (lower) image in red, the later one in green and blue.
  await expect(dialog.getByLabel('赤（R）').locator('option:checked')).toHaveText('scene_2024.tif');
  await expect(dialog.getByLabel('緑（G）').locator('option:checked')).toHaveText('scene_2025.tif');
  await expect(dialog.getByLabel('青（B）').locator('option:checked')).toHaveText('scene_2025.tif');
  await expect(dialog.locator('.composite-legend')).toContainText('シアン');
  // On the finer image's grid, where both images are.
  await expect(dialog.locator('.composite-plan')).toContainText('結果は 54 × 54 px、3 バンド（16 bit）、scene_2025.tif と同じ格子');

  await dialog.getByRole('button', { name: '実行' }).click();
  await expect(page.locator('#status')).toContainText('scene_2024_scene_2025_rgb.tif を作りました（54 × 54 px）');
  await expect(page.locator('#images .name').first()).toHaveText('RGB 合成scene_2024_scene_2025_rgb.tif');

  await processing(page, 'composite');
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '選択中の結果を GeoTIFF 保存' }).click();
  const file = await download;
  const chunks: Buffer[] = [];
  for await (const chunk of await file.createReadStream()) chunks.push(chunk as Buffer);
  const bytes = Buffer.concat(chunks);
  const image = await (await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))).getImage();
  expect([image.getWidth(), image.getHeight(), image.getSamplesPerPixel(), image.getBitsPerSample()]).toEqual([54, 54, 3, 16]);
  expect(image.getOrigin().slice(0, 2)).toEqual([ORIGIN[0] + 10, ORIGIN[1] - 10]);
  expect(image.getResolution().slice(0, 2)).toEqual([1, -1]);
  expect(image.getGeoKeys()?.ProjectedCSTypeGeoKey).toBe(32654);
  const data = (await image.readRasters({ interleave: true, window: [0, 1, 4, 2] })) as unknown as Uint16Array;
  // Output pixel (0, 1) is 10.5 m right of the earlier image's corner: its pixel 4.75 across (between 1080 and 1100 plus the odd row's 1).
  expect(Array.from(data.subarray(0, 3))).toEqual([1096, 510, 510]);
  expect(data[3 * 2]).toBe(1116);
  expect(errors).toEqual([]);
});
