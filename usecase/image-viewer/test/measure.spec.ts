import { expect, test, type Page } from '@playwright/test';
import { geodesicArea, geodesicLength } from '../src/geodesic.js';

/*
 * The measure tool: geodesic distance and area on the map, pixels on an
 * ordinary picture.
 */

async function open(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

/** Clicks at offsets (px) from the map's center, ending with a double click; returns the [lon, lat] clicked. */
async function draw(page: Page, offsets: [number, number][]): Promise<[number, number][]> {
  const box = (await page.locator('#map').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  for (const [i, [dx, dy]] of offsets.entries()) {
    if (i === offsets.length - 1) await page.mouse.dblclick(cx + dx, cy + dy);
    else await page.mouse.click(cx + dx, cy + dy);
    await page.waitForTimeout(350); // not taken for a double click
  }
  return page.evaluate(
    ([offsets, w, h]) => {
      const { map } = window.viewer;
      return offsets.map(([dx, dy]) => {
        const c = map.getCoordinateFromPixel([w / 2 + dx, h / 2 + dy]);
        const x = (c[0] / 6378137) * (180 / Math.PI);
        const y = (2 * Math.atan(Math.exp(c[1] / 6378137)) - Math.PI / 2) * (180 / Math.PI);
        return [x, y] as [number, number];
      });
    },
    [offsets, box.width, box.height] as const,
  );
}

test('measures geodesic distance and area on the map', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await page.evaluate(() => {
    const view = window.viewer.map.getView();
    view.setCenter([15_558_000, 4_257_000]); // around Tokyo
    view.setZoom(9);
  });
  const clear = page.getByRole('button', { name: '計測を消去' });
  await expect(clear).toBeDisabled();

  // Distance: three clicks, the last a double click.
  await page.getByRole('button', { name: '距離を測る' }).click();
  await expect(page.getByRole('button', { name: '距離を測る' })).toHaveAttribute('aria-pressed', 'true');
  const path = await draw(page, [[-200, 0], [100, -50], [200, 120]]);
  await expect(page.locator('#status')).toContainText(/距離: [\d.,]+ km/);
  const [distance] = await page.evaluate(() => window.viewer.measure.list());
  expect(distance.mode).toBe('distance');
  expect(distance.unit).toBe('geodesic');
  expect(distance.length).toBeCloseTo(geodesicLength(path), 0);
  await expect(clear).toBeEnabled();

  // Area: switching modes keeps the earlier measurement.
  await page.getByRole('button', { name: '面積を測る' }).click();
  await expect(page.getByRole('button', { name: '距離を測る' })).toHaveAttribute('aria-pressed', 'false');
  const ring = await draw(page, [[-150, -100], [150, -100], [150, 100], [-150, 100]]);
  await expect(page.locator('#status')).toContainText(/面積: [\d.,]+ km²（周長 [\d.,]+ km）/);
  const list = await page.evaluate(() => window.viewer.measure.list());
  expect(list).toHaveLength(2);
  const expected = geodesicArea(ring);
  expect(list[1].area / expected.area).toBeCloseTo(1, 6);
  expect(list[1].length).toBeCloseTo(expected.perimeter, 0);

  // A click while measuring does not add a point; points mode turns measuring off.
  await page.getByRole('button', { name: 'ポイント追加' }).click();
  await expect(page.getByRole('button', { name: '面積を測る' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: '距離を測る' }).click();
  await expect(page.getByRole('button', { name: 'ポイント追加' })).toHaveAttribute('aria-pressed', 'false');

  // Esc drops the measurement being drawn; clearing removes the rest.
  const box = (await page.locator('#map').boundingBox())!;
  await page.mouse.click(box.x + 100, box.y + 100);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => window.viewer.measure.list().length)).toBe(2);
  await clear.click();
  expect(await page.evaluate(() => window.viewer.measure.list().length)).toBe(0);
  await expect(clear).toBeDisabled();
  expect(errors).toEqual([]);
});

test('measures in pixels on an ordinary picture', async ({ page }) => {
  await open(page);
  await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(400, 300);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 400, 300);
    const file = new File([await canvas.convertToBlob({ type: 'image/png' })], 'photo.png', { type: 'image/png' });
    const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
    const files = new DataTransfer();
    files.items.add(file);
    input.files = files.files;
    input.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('#status')).toContainText('photo.png を開きました');
  await page.waitForTimeout(500); // the view settles on the picture

  await page.getByRole('button', { name: '距離を測る' }).click();
  await draw(page, [[-50, 0], [50, 0]]);
  await expect(page.locator('#status')).toContainText(/距離: [\d.,]+ px/);
  const resolution = await page.evaluate(() => window.viewer.map.getView().getResolution()!);
  const [m] = await page.evaluate(() => window.viewer.measure.list());
  expect(m.unit).toBe('pixel');
  expect(m.length).toBeCloseTo(100 * resolution, 0);
});
