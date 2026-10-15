import { expect, test, type Page } from '@playwright/test';
import { writeArrayBuffer } from 'geotiff';
import { toBase64 } from './fixtures.js';

/*
 * Automatic alignment from the processing dialog: an image whose
 * georeferencing is off by some metres is matched to a reference by its
 * texture, and an aligned copy opens on the reference's grid.
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

const SIZE = 384;
/** Seeded noise, a little smoothed: the texture of a scene, 2 m pixels. */
const scene = (() => {
  let seed = 4242;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const raw = Float64Array.from({ length: SIZE * SIZE }, random);
  const out = new Uint16Array(SIZE * SIZE);
  for (let y = 1; y < SIZE - 1; y++) {
    for (let x = 1; x < SIZE - 1; x++) {
      const v = (raw[y * SIZE + x] * 4 + raw[y * SIZE + x - 1] + raw[y * SIZE + x + 1] + raw[(y - 1) * SIZE + x] + raw[(y + 1) * SIZE + x]) / 8;
      out[y * SIZE + x] = Math.round(1000 + 3000 * v);
    }
  }
  return out;
})();

const ORIGIN = [380000, 3950000];

/** 256 × 256 px of the scene from pixel (`x0`, `y0`), said to start at `origin`. */
function tiff(x0: number, y0: number, origin: number[]): Uint8Array {
  const size = 256;
  const values = new Uint16Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) values[y * size + x] = scene[(y + y0) * SIZE + x + x0];
  return new Uint8Array(
    writeArrayBuffer(values, {
      width: size,
      height: size,
      SamplesPerPixel: 1,
      BitsPerSample: [16],
      SampleFormat: [1],
      PhotometricInterpretation: 1,
      ModelPixelScale: [2, 2, 0],
      ModelTiepoint: [0, 0, 0, origin[0], origin[1], 0],
      ProjectedCSTypeGeoKey: 32654,
      GTModelTypeGeoKey: 1,
      GTRasterTypeGeoKey: 1,
    }),
  );
}

test('finds how far an image is off its reference, and makes an aligned copy', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  // The reference: scene pixels from (40, 40). The other: from (60, 50), truly 40 m east and 20 m south of it,
  // but its georeferencing says 30 m east and 26 m south: 10 m west, 6 m south of the truth.
  await choose(page, [
    { name: 'base.tif', bytes: tiff(40, 40, ORIGIN) },
    { name: 'drone.tif', bytes: tiff(60, 50, [ORIGIN[0] + 30, ORIGIN[1] - 26]) },
  ]);
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#processing').click();
  await page.locator('.processing-dialog').first().getByLabel('処理').selectOption('align');
  const dialog = page.locator('.align-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('基準の画像').locator('option:checked')).toHaveText('base.tif');
  await expect(dialog.getByLabel('合わせる画像').locator('option:checked')).toHaveText('drone.tif');
  await dialog.getByRole('button', { name: '実行' }).click();
  await expect(dialog).toBeHidden();
  // Where a point is → where drone.tif shows it: 10 m west, 6 m south.
  await expect(page.locator('#status')).toContainText(/drone_aligned\.tif を作りました（ずれ 東 -\d+\.\d m・北 -\d\.\d m、照合 \d+\/\d+ か所/);
  const shift = /東 (-?[\d.]+) m・北 (-?[\d.]+) m/.exec((await page.locator('#status').textContent())!)!;
  expect(Math.abs(Number(shift[1]) + 10)).toBeLessThan(0.3);
  expect(Math.abs(Number(shift[2]) + 6)).toBeLessThan(0.3);

  // The aligned copy lies on the reference's grid and shows what the reference shows there.
  const diff = await page.evaluate(async () => {
    const [aligned, , base] = window.viewer.images.list();
    type Tiff = { readRasters(o: object): Promise<ArrayLike<number>[]>; getOrigin(): number[]; getWidth(): number; getHeight(): number };
    const a = aligned.source.getTiffImages()[0][0] as Tiff;
    const b = base.source.getTiffImages()[0][0] as Tiff;
    const ox = Math.round((a.getOrigin()[0] - b.getOrigin()[0]) / 2);
    const oy = Math.round((b.getOrigin()[1] - a.getOrigin()[1]) / 2);
    const [av] = await a.readRasters({ window: [10, 10, 74, 74] });
    const [bv] = await b.readRasters({ window: [10 + ox, 10 + oy, 74 + ox, 74 + oy] });
    let sum = 0;
    for (let i = 0; i < av.length; i++) sum += Math.abs(av[i] - bv[i]);
    return { mean: sum / av.length, ox, oy, name: aligned.name };
  });
  expect(diff.name).toBe('drone_aligned.tif');
  // The texture varies by hundreds from pixel to pixel; aligned, only the resampling is left.
  expect(diff.mean).toBeLessThan(120);
  expect(errors).toEqual([]);
});
