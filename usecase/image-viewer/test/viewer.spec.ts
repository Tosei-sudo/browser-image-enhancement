import { expect, test, type Page } from '@playwright/test';

/*
 * The image viewer, built (dist/): a local picture through the file chooser,
 * a COG by URL (served with range requests by test/server.mjs), the image
 * list and per-image corrections.
 */

async function open(page: Page, query = '') {
  await page.goto(`/index.html${query}`);
  await page.waitForFunction(() => window.viewer !== undefined);
}

/** Picks a PNG made in the page with the file chooser, as a person would. */
async function choosePng(page: Page, name: string, width = 64, height = 48) {
  await page.evaluate(
    async ([name, w, h]) => {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d')!;
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, '#203040');
      g.addColorStop(1, '#c0a080');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      const file = new File([await canvas.convertToBlob({ type: 'image/png' })], name, { type: 'image/png' });
      const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
      const files = new DataTransfer();
      files.items.add(file);
      input.files = files.files;
      input.dispatchEvent(new Event('change'));
    },
    [name, width, height] as const,
  );
}

const names = (page: Page) => page.locator('#images .name').allTextContents();
const pipelineOf = (page: Page, index: number) => page.evaluate((i) => window.viewer.images.list()[i].source.getPipeline().ops.map((o) => ({ ...o })), index);

async function slide(page: Page, label: string, value: string) {
  await page.evaluate(
    ([label, value]) => {
      const row = [...document.querySelectorAll('.ol-enhance-row')].find((r) => r.firstElementChild?.textContent === label)!;
      const input = row.querySelector('input')!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    },
    [label, value],
  );
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

test('opens a local picture and a COG URL as layers, each with its own correction', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await expect(page.locator('#empty')).toBeVisible();

  // A local picture through the file chooser.
  await choosePng(page, 'photo.png');
  await expect(page.locator('#status')).toContainText('photo.png を開きました');
  await expect(page.locator('#empty')).toBeHidden();
  await expect(page.locator('#info')).toContainText('64 × 48 px');

  // A COG by URL, through the URL form.
  await page.getByRole('button', { name: 'COG の URL を開く' }).click();
  await page.getByRole('textbox', { name: 'COG の URL を開く' }).fill(new URL('/fixture.tif', page.url()).href);
  await page.getByRole('button', { name: '開く', exact: true }).click();
  await expect(page.locator('#status')).toContainText('fixture.tif を開きました');
  expect(await names(page)).toEqual(['fixture.tif', 'photo.png']); // newest on top
  await expect(page.locator('#info')).toContainText('EPSG:4326');
  await expect(page.locator('#info')).toContainText('512 × 256 px');

  // The panel corrects the selected image only, and shows each image's own correction.
  await slide(page, '露出 (EV)', '1');
  expect(await pipelineOf(page, 0)).toEqual([{ op: 'exposure', ev: 1 }]);
  expect(await pipelineOf(page, 1)).toEqual([]);
  await page.locator('#images .name', { hasText: 'photo.png' }).click();
  await expect(page.locator('#info')).toContainText('64 × 48 px');
  const exposure = page.locator('.ol-enhance-row', { hasText: '露出 (EV)' }).locator('input');
  await expect(exposure).toHaveValue('0');
  await slide(page, 'コントラスト', '0.3');
  await page.locator('#images .name', { hasText: 'fixture.tif' }).click();
  await expect(exposure).toHaveValue('1');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  expect(await pipelineOf(page, 0)).toEqual([{ op: 'exposure', ev: 1 }]);
  expect(await pipelineOf(page, 1)).toEqual([{ op: 'contrast', amount: 0.3 }]);

  // Reorder, hide, close.
  await page.locator('#images li').first().getByRole('button', { name: '下へ' }).click();
  expect(await names(page)).toEqual(['photo.png', 'fixture.tif']);
  const z = await page.evaluate(() => window.viewer.images.list().map((i) => i.layer.getZIndex()));
  expect(z).toEqual([2, 1]);
  await page.locator('#images li').first().getByRole('checkbox').uncheck();
  expect(await page.evaluate(() => window.viewer.images.list()[0].layer.getVisible())).toBe(false);
  await page.locator('#images li').first().getByRole('button', { name: '閉じる' }).click();
  expect(await names(page)).toEqual(['fixture.tif']);
  expect(await page.evaluate(() => window.viewer.images.selected()?.name)).toContain('fixture.tif');

  expect(errors).toEqual([]);
});

test('?url= opens a COG at start', async ({ page }) => {
  await open(page, `?url=${encodeURIComponent('http://localhost:4175/fixture.tif')}`);
  await expect(page.locator('#status')).toContainText('fixture.tif を開きました');
  expect(await names(page)).toEqual(['fixture.tif']);
});

test('reports a URL that cannot be read', async ({ page }) => {
  await open(page, `?url=${encodeURIComponent('http://localhost:4175/missing.tif')}`);
  await expect(page.locator('#status')).toContainText('を開けませんでした');
  await expect(page.locator('#empty')).toBeVisible();
});

test('points are added on the selected image, named, and saved as GeoJSON', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page, `?url=${encodeURIComponent('http://localhost:4175/fixture.tif')}`);
  await expect(page.locator('#status')).toContainText('fixture.tif を開きました');
  await expect(page.getByRole('button', { name: 'GeoJSON 保存' })).toBeDisabled();

  // The map is fitted to the image, so its center is on the image.
  const center = async () => {
    const box = (await page.locator('#map').boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  await page.getByRole('button', { name: 'ポイント追加' }).click();
  await expect(page.getByRole('button', { name: 'ポイント追加' })).toHaveAttribute('aria-pressed', 'true');
  let c = await center();
  await page.mouse.click(c.x, c.y);
  const name = page.getByRole('textbox', { name: 'ポイント名称' }).first();
  await expect(name).toBeFocused();
  await name.fill('東京');

  // A click off the image adds nothing.
  const box = (await page.locator('#map').boundingBox())!;
  await page.mouse.click(box.x + 40, box.y + box.height - 10);
  await expect(page.locator('#status')).toContainText('画像（fixture）の上に置いてください');

  // A point on a picture.
  await choosePng(page, 'photo.jpeg.png');
  await expect(page.locator('#status')).toContainText('photo.jpeg.png を開きました');
  c = await center();
  await page.mouse.click(c.x, c.y);
  await expect(page.locator('#points li')).toHaveCount(2);
  await page.getByRole('textbox', { name: 'ポイント名称' }).nth(1).fill('中央');
  await page.keyboard.press('Enter');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'GeoJSON 保存' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('points.geojson');
  const stream = await file.createReadStream();
  let text = '';
  for await (const chunk of stream) text += chunk;
  const geojson = JSON.parse(text);
  expect(geojson.type).toBe('FeatureCollection');
  expect(geojson.features.map((f: { properties: unknown }) => f.properties)).toEqual([
    { image: 'fixture', name: '東京' },
    { image: 'photo.jpeg', name: '中央' },
  ]);
  const [lon, lat] = geojson.features[0].geometry.coordinates;
  expect(lon).toBeCloseTo(139.75, 1);
  expect(lat).toBeCloseTo(35.675, 1);
  const [x, y] = geojson.features[1].geometry.coordinates;
  expect(x).toBeCloseTo(32, -1);
  expect(y).toBeCloseTo(24, -1);

  // Closing an image removes its points; a point can be deleted from the list.
  await page.locator('#images li', { hasText: 'photo.jpeg.png' }).getByRole('button', { name: '閉じる' }).click();
  await expect(page.locator('#points li')).toHaveCount(1);
  await page.getByRole('button', { name: '東京 を削除' }).click();
  await expect(page.locator('#points li')).toHaveCount(0);
  expect(errors).toEqual([]);
});
