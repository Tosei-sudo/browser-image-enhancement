import { expect, test, type Page } from '@playwright/test';

/* Place names and addresses in the jump field: places found while typing, Enter goes to one. */

async function open(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

const center = (page: Page) =>
  page.evaluate(() => {
    const view = window.viewer.map.getView();
    const [x, y] = view.getCenter()!;
    // Web Mercator back to degrees.
    return [(x / 6378137) * (180 / Math.PI), (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * (180 / Math.PI)];
  });

test('lists places found by name and goes to the one chosen', async ({ page }) => {
  const asked: string[] = [];
  await page.route('https://msearch.gsi.go.jp/**', (route) => {
    asked.push(new URL(route.request().url()).searchParams.get('q') ?? '');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify([
        { geometry: { coordinates: [138.727363, 35.360626], type: 'Point' }, type: 'Feature', properties: { title: '富士山' } },
        { geometry: { coordinates: [138.6, 35.2], type: 'Point' }, type: 'Feature', properties: { title: '富士宮市' } },
      ]),
    });
  });
  await open(page);
  const field = page.getByRole('combobox', { name: '座標・地名へ移動' });
  await expect(field).toHaveAttribute('placeholder', /地名/);
  await field.fill('富士');
  const list = page.getByRole('listbox', { name: '見つかった場所' });
  await expect(list.getByRole('option')).toHaveCount(2);
  await expect(list.getByRole('option').first()).toContainText('富士山');
  await expect(list.getByRole('option').first()).toContainText('地理院');
  expect(asked).toEqual(['富士']);

  await field.press('ArrowDown');
  await field.press('ArrowDown');
  await expect(list.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
  await field.press('Enter');
  await expect(list).toBeHidden();
  await expect(page.locator('#status')).toContainText('移動しました: 富士宮市（地理院）');
  await expect.poll(async () => (await center(page))[0], { timeout: 3000 }).toBeCloseTo(138.6, 3);

  // A coordinate is still read as one, without asking.
  await field.fill('35.68, 139.76');
  await page.waitForTimeout(500);
  await expect(list).toBeHidden();
  await field.press('Enter');
  await expect(page.locator('#status')).toContainText('移動しました: 35.68');
  expect(asked).toEqual(['富士']);

  // Enter without waiting for the list takes the first place.
  await field.fill('富士山');
  await field.press('Enter');
  await expect(page.locator('#status')).toContainText('移動しました: 富士山（地理院）');
});

test('"geocoders": [] reads coordinates only and asks no one', async ({ page }) => {
  let asked = 0;
  await page.route('https://msearch.gsi.go.jp/**', (route) => {
    asked++;
    return route.abort();
  });
  await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ geocoders: [] }) }));
  await open(page);
  const field = page.getByRole('textbox', { name: '座標へ移動' });
  await expect(field).toHaveAttribute('placeholder', '緯度経度・MGRS・UTM');
  await field.fill('富士山');
  await field.press('Enter');
  await expect(page.locator('#status')).toContainText('座標として読めませんでした');
  expect(asked).toBe(0);
});
