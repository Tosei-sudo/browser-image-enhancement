import { expect, test, type Page } from '@playwright/test';
import { writeArrayBuffer } from 'geotiff';
import { toBase64 } from './fixtures.js';

/*
 * The spectral graph: every band's value at points clicked on the map, and
 * the mean over a dragged box, for a four-band image.
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
  await expect(page.locator('#images .name', { hasText: name })).toHaveCount(1);
}

/** 32 × 32 px, four 16-bit bands, UTM 54N: 50, 80, 100 and 100 + 10·x (x the column). */
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

const series = (page: Page) =>
  page.evaluate(() =>
    window.viewer.spectral.getSeries().map((s) => ({ label: s.label, means: s.bands.map((b) => b.mean), min: s.bands.map((b) => b.min), max: s.bands.map((b) => b.max) })),
  );

test('shows every band at clicked points, overlaid, and the mean over a dragged box', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await choose(page, 'field.tif', fourBands());
  await page.getByRole('button', { name: 'スペクトル' }).click();
  const panel = page.locator('#spectral');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: 'CSV 保存' })).toBeDisabled();

  const map = page.locator('#map');
  const box = (await map.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.click(cx - 40, cy);
  await expect.poll(async () => (await series(page)).length).toBe(1);
  // Clicks are told from double clicks after a moment: wait before the next one.
  await page.waitForTimeout(400);
  await page.mouse.click(cx + 40, cy + 10);
  await expect.poll(async () => (await series(page)).length).toBe(2);
  const [left, right] = await series(page);
  for (const s of [left, right]) {
    const col = Number(/列 (\d+)/.exec(s.label)![1]);
    expect(s.means).toEqual([50, 80, 100, 100 + 10 * col]);
  }
  expect(right.means[3]).toBeGreaterThan(left.means[3]);
  await expect(panel.locator('.spectral-chart path.spectral-line')).toHaveCount(2);
  await expect(panel.locator('.spectral-legend li')).toHaveCount(2);

  // The CSV: a row per band.
  const download = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'CSV 保存' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('field_spectrum.csv');

  // A box over the whole image: the mean of 100 + 10·x over x = 0…31, and its range.
  await panel.getByRole('button', { name: '消去' }).click();
  await panel.getByLabel('取り方').selectOption('box');
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(cx, cy, { steps: 5 });
  await page.mouse.move(box.x + box.width - 5, box.y + box.height - 5, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await series(page)).length).toBe(1);
  const [area] = await series(page);
  expect(area.label).toContain('32 × 32 画素');
  expect(area.means).toEqual([50, 80, 100, 255]);
  expect(area.min[3]).toBe(100);
  expect(area.max[3]).toBe(410);
  expect(errors).toEqual([]);
});
