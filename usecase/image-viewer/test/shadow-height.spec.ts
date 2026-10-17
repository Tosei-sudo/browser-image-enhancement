import { expect, test, type Page } from '@playwright/test';
import { satelliteTiff, toBase64 } from './fixtures.js';
import { geodesicLength } from '../src/geodesic.js';

/*
 * 影から高さを測る: the foot and the tip of a shadow, with the Sun computed
 * from when the image was taken (here its file name) or typed by hand.
 */

async function open(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

async function choose(page: Page, name: string, bytes: Uint8Array) {
  await page.evaluate(
    ([name, base64]) => {
      const list = new DataTransfer();
      list.items.add(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], name));
      const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
      input.files = list.files;
      input.dispatchEvent(new Event('change'));
    },
    [name, toBase64(bytes)] as const,
  );
}

/** Clicks at an offset (px) from the map's center (below the panel at the top of the map). */
async function clickAt(page: Page, dx: number, dy: number) {
  const box = (await page.locator('#map').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
  await page.waitForTimeout(300); // a single click, not a double one
}

/** Bearing from a to b (degrees clockwise from north), on a sphere. */
function bearing([lon1, lat1]: number[], [lon2, lat2]: number[]): number {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}

test('measures a height from a shadow with the Sun of the time the image was taken, or typed', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  // Tokyo, taken on a June morning (the time is in the file name).
  await choose(page, 'WV3_20240621T090000_P001.tif', satelliteTiff(600, 600, (x, y) => 300 + ((x >> 4) + (y >> 4)) % 2 * 300, undefined, { west: 139.7, north: 35.7, step: 0.00005 }));
  await expect(page.locator('#status')).toContainText('を開きました');
  await page.evaluate(() => window.viewer.map.getView().setZoom(18));

  await page.getByRole('button', { name: 'ツール' }).click();
  await page.getByRole('button', { name: '影から高さ' }).click();
  const panel = page.getByRole('group', { name: '影から高さを測る' });
  await expect(panel).toBeVisible();
  await expect(panel.locator('.shadow-origin')).toContainText('ファイル名');
  const elevation = Number(await panel.getByLabel('太陽高度（度）').inputValue());
  const azimuth = Number(await panel.getByLabel('太陽の方位（度、北から時計回り）').inputValue());
  expect(elevation).toBeGreaterThan(0);
  expect(elevation).toBeLessThan(90);

  // The foot, then a click off to the side: the tip snaps onto the way shadows fall.
  await clickAt(page, 0, 60);
  await expect(page.locator('#status')).toContainText('影の先端をクリック');
  await clickAt(page, 60, 100);
  await expect(page.locator('#status')).toContainText(/高さ [\d.]+ m（影 [\d.]+ m、太陽高度/);
  const [first] = await page.evaluate(() => window.viewer.shadowHeight.list());
  expect(first.unit).toBe('m');
  expect(first.shadow).toBeCloseTo(geodesicLength([first.foot, first.tip] as [number, number][]), 3);
  expect(first.height).toBeCloseTo(first.shadow * Math.tan((first.sunElevation * Math.PI) / 180), 3);
  expect(first.sunElevation).toBeCloseTo(elevation, 1);
  const off = Math.abs(bearing(first.foot, first.tip) - ((azimuth + 180) % 360));
  expect(Math.min(off, 360 - off)).toBeLessThan(1);
  await expect(panel.getByRole('list', { name: '測った高さ' }).locator('li')).toHaveCount(1);

  // Typed by hand: 45° makes the height the shadow's length; without snapping the tip is where clicked.
  await panel.getByLabel('太陽高度（度）').fill('45');
  await panel.getByLabel('太陽高度（度）').press('Enter');
  await panel.getByLabel('太陽高度（度）').blur();
  await expect(panel.locator('.shadow-origin')).toHaveText('手入力');
  await panel.getByLabel('影の向きに合わせる').uncheck();
  await clickAt(page, -50, 40);
  await clickAt(page, -50, 120);
  const second = (await page.evaluate(() => window.viewer.shadowHeight.list()))[1];
  expect(second.sunElevation).toBe(45);
  expect(second.height).toBeCloseTo(second.shadow, 3);
  expect(Math.abs(bearing(second.foot, second.tip) - 180)).toBeLessThan(1);

  // Esc drops a foot; 消去 removes everything; 終了 closes the panel.
  await clickAt(page, 10, 70);
  await page.keyboard.press('Escape');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: '消去' }).click();
  expect(await page.evaluate(() => window.viewer.shadowHeight.list().length)).toBe(0);
  await panel.getByRole('button', { name: '終了' }).click();
  await expect(panel).toBeHidden();
  await expect(page.locator('#shadow-height')).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test('asks for the Sun when nothing says where it was, and computes it from a typed time', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const view = window.viewer.map.getView();
    view.setCenter([15_558_000, 4_257_000]);
    view.setZoom(17);
  });
  await page.keyboard.press('h');
  const panel = page.getByRole('group', { name: '影から高さを測る' });
  await expect(panel.locator('.shadow-origin')).toContainText('太陽高度が分かりません');
  await clickAt(page, 0, 60);
  await expect(page.locator('#status')).toContainText('太陽高度が分かりません');
  expect(await page.evaluate(() => window.viewer.shadowHeight.list().length)).toBe(0);

  await panel.getByText('撮影日時から計算').click();
  await panel.getByLabel('撮影日時（UTC）').fill('2024-06-21T03:00');
  await panel.getByLabel('撮影日時（UTC）').blur();
  await expect(panel.locator('.shadow-origin')).toContainText('2024-06-21 03:00:00 UTC（手入力）と位置から計算');
  const elevation = Number(await panel.getByLabel('太陽高度（度）').inputValue());
  expect(elevation).toBeGreaterThan(76);
  expect(elevation).toBeLessThan(79);
});
