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

test('colors only the layer it is set on, not the images under it', async ({ page }) => {
  await open(page);
  await choose(page, [
    { name: 'scene_2024.tif', bytes: before() },
    { name: 'scene_2025.tif', bytes: after() },
  ]);
  // Pixels the top layer (scene_2025.tif, red) shows: the same whether the image under it is shown or not.
  const opaque = () =>
    page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          window.viewer.map.once('rendercomplete', () => {
            const canvas = window.viewer.images.list()[0].layer.getOutputCanvas();
            const ctx = document.createElement('canvas').getContext('2d')!;
            ctx.canvas.width = canvas.width;
            ctx.canvas.height = canvas.height;
            ctx.drawImage(canvas, 0, 0);
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let n = 0;
            for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
            resolve(n);
          });
          window.viewer.map.render();
        }),
    );
  await page.evaluate(() => {
    const [top, under] = window.viewer.images.list();
    top.layer.setColorScale({ scale: 'red' });
    under.layer.setVisible(false);
  });
  const alone = await opaque();
  expect(alone).toBeGreaterThan(0);
  await page.evaluate(() => window.viewer.images.list()[1].layer.setVisible(true));
  expect(await opaque()).toBe(alone);
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
  // The canvas takes its CSS blend mode when the layer next draws.
  const state = () =>
    page.evaluate(() =>
      window.viewer.images.list().map((i) => ({ name: i.name, scale: i.layer.getColorScale()?.scale, blend: i.layer.getBlendMode(), css: i.layer.getOutputCanvas().style.mixBlendMode })),
    );
  await expect.poll(state).toEqual([
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

/** The distinct opaque colors the layer of image `index` (top first) shows, as `#rrggbb`. */
const colorsShown = (page: Page, index: number) =>
  page.evaluate(
    (index) =>
      new Promise<string[]>((resolve) => {
        window.viewer.map.once('rendercomplete', () => {
          const canvas = window.viewer.images.list()[index].layer.getOutputCanvas();
          const ctx = document.createElement('canvas').getContext('2d')!;
          ctx.canvas.width = canvas.width;
          ctx.canvas.height = canvas.height;
          ctx.drawImage(canvas, 0, 0);
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          const seen = new Set<string>();
          for (let i = 0; i < data.length; i += 4) if (data[i + 3] === 255) seen.add(`#${[data[i], data[i + 1], data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`);
          resolve([...seen].sort());
        });
        window.viewer.map.render();
      }),
    index,
  );

/** A one-band 8-bit UTM 54N GeoTIFF of land cover codes: 1 on the left, 2 in the middle, 5 on the right. */
function codes(): Uint8Array {
  const size = 30;
  const values = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) values[y * size + x] = x < 10 ? 1 : x < 20 ? 2 : 5;
  return new Uint8Array(
    writeArrayBuffer(values, {
      width: size,
      height: size,
      SamplesPerPixel: 1,
      BitsPerSample: [8],
      SampleFormat: [1],
      PhotometricInterpretation: 1,
      ModelPixelScale: [2, 2, 0],
      ModelTiepoint: [0, 0, 0, ORIGIN[0], ORIGIN[1], 0],
      ProjectedCSTypeGeoKey: 32654,
      GTModelTypeGeoKey: 1,
      GTRasterTypeGeoKey: 1,
    }),
  );
}

test('shows a 16-bit image in classes of its values, with a legend, and saves them', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  // Values 100 to 410 across, in steps of 10.
  await choose(page, [{ name: 'dem.tif', bytes: tiff(32, 2, ORIGIN, (x) => 100 + x * 10) }]);
  await processing(page, 'colorize');
  const dialog = page.locator('.colorize-dialog');
  await dialog.getByLabel('表示方法').selectOption('classes');
  await expect(dialog.getByLabel('カラースケール')).toHaveValue('turbo');
  await dialog.getByLabel('クラス数').fill('4');
  await dialog.getByLabel('クラス数').blur();

  // Four classes of equal width between the smallest and largest value, listed with their share of the image.
  const rows = dialog.locator('.class-legend tbody tr');
  await expect(rows).toHaveCount(4);
  await expect(dialog.getByLabel('クラス 1 の上限')).toHaveValue('177.5');
  await expect(dialog.getByLabel('クラス 4 の上限')).toHaveValue('410');
  await expect(rows.first().locator('.class-share')).toHaveText('25%');
  const classes = () => page.evaluate(() => window.viewer.images.list()[0].layer.getColorScale()?.classes);
  const saved = (await classes())!;
  expect(saved.kind).toBe('range');
  expect(saved.min).toBe(100);
  expect(saved.classes.map((c) => c.value)).toEqual([177.5, 255, 332.5, 410]);

  // The map shows the classes' flat colors only, and their legend.
  const hex = (c: readonly number[]) => `#${c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  const palette = saved.classes.map((c) => hex(c.color));
  await expect.poll(async () => {
    const colors = await colorsShown(page, 0);
    return colors.length >= 3 && colors.every((c) => palette.includes(c));
  }).toBe(true);
  const legend = page.locator('.map-class-legend');
  await expect(legend).toBeVisible();
  await expect(legend.locator('li')).toHaveCount(4);
  await expect(legend.locator('li').first()).toHaveText('100 – 177.5');

  // A bound typed in: the classes are set by hand and named after their new ranges.
  await dialog.getByLabel('クラス 1 の上限').fill('200');
  await dialog.getByLabel('クラス 1 の上限').blur();
  await expect(dialog.getByLabel('分け方')).toHaveValue('manual');
  await expect(legend.locator('li').nth(1)).toHaveText('200 – 255');
  // A color picked for a class.
  await dialog.getByLabel('クラス 2 の色').fill('#00ff00');
  await expect.poll(async () => (await classes())!.classes[1].color.slice(0, 3)).toEqual([0, 255, 0]);

  // Quantiles: classes of about the same area.
  await dialog.getByLabel('分け方').selectOption('quantile');
  await expect.poll(async () => (await classes())?.method).toBe('quantile');
  await expect(rows).toHaveCount(4);

  // Saved in a project, and back when it opens.
  const project = await page.evaluate(() => window.viewer.project.collect().project.layers[0].colorScale);
  expect(project?.classes?.method).toBe('quantile');
  expect(project?.classes?.classes).toHaveLength(4);
  await page.evaluate(() => window.viewer.images.list()[0].layer.setColorScale(null));
  await page.evaluate((scale) => window.viewer.images.list()[0].layer.setColorScale(scale ?? null), project);
  expect(await classes()).toEqual(project?.classes);

  // Back to a smooth scale: no classes, no legend.
  await dialog.getByLabel('表示方法').selectOption('');
  await expect.poll(classes).toBeUndefined();
  await expect(legend).toBeHidden();
  expect(errors).toEqual([]);
});

test('gives each value of a classified image its own color, named in the legend', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await choose(page, [{ name: 'landcover.tif', bytes: codes() }]);
  await page.locator('#images .image').first().getByRole('button', { name: '着色（カラースケール・重ね方）' }).click();
  const dialog = page.locator('.colorize-dialog');
  await dialog.getByLabel('表示方法').selectOption('unique');
  const rows = dialog.locator('.class-legend tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.locator('td:nth-child(2)')).toHaveText(['1', '2', '5']);
  await expect(dialog.getByLabel('分け方')).toBeHidden();
  await dialog.getByLabel('クラス 1 の名前').fill('森林');
  await dialog.getByLabel('クラス 1 の名前').blur();
  await expect(page.locator('.map-class-legend li').first()).toHaveText('森林');

  const scale = await page.evaluate(() => window.viewer.images.list()[0].layer.getColorScale());
  expect(scale?.classes?.kind).toBe('exact');
  const hex = (c: readonly number[]) => `#${c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  const palette = scale!.classes!.classes.map((c) => hex(c.color));
  await expect.poll(async () => {
    const colors = await colorsShown(page, 0);
    return colors.length === 3 && colors.every((c) => palette.includes(c));
  }).toBe(true);
  expect(errors).toEqual([]);
});
