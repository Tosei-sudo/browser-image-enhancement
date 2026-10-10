import { expect, test, type Page } from '@playwright/test';

/*
 * The timeline: a vector layer's date attribute and an image's date (from
 * its file name) on one axis; the window filters the map, the attribute
 * table and the images; a WMS layer with a time dimension is drawn at the
 * window's end; closing shows everything again.
 */

const base = 'http://localhost:4175';

async function open(page: Page, query = '') {
  await page.request.get(`${base}/svc/reset`);
  await page.route(/cyberjapandata\.gsi\.go\.jp|tile\.openstreetmap\.org/, (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto(`/index.html${query}`);
  await page.waitForFunction(() => window.viewer !== undefined);
}

async function choose(page: Page, name: string, text: string) {
  await page.evaluate(
    ([name, text]) => {
      const list = new DataTransfer();
      list.items.add(new File([text], name));
      const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
      input.files = list.files;
      input.dispatchEvent(new Event('change'));
    },
    [name, text],
  );
}

/** Opens a small PNG made in the page under `name`. */
async function choosePicture(page: Page, name: string) {
  await page.evaluate(async (name) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    canvas.getContext('2d')!.fillRect(0, 0, 16, 16);
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));
    const list = new DataTransfer();
    list.items.add(new File([blob], name, { type: 'image/png' }));
    const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
    input.files = list.files;
    input.dispatchEvent(new Event('change'));
  }, name);
}

const observations = JSON.stringify({
  type: 'FeatureCollection',
  features: ['2024-01-10', '2024-02-10', '2024-03-10', '2024-04-10'].map((observed, i) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [139.7 + i * 0.01, 35.68] },
    properties: { name: `地点${i + 1}`, observed },
  })),
});

const rows = (page: Page) => page.locator('.attributes tbody tr[data-index]');
const timeline = (page: Page) => page.locator('#timeline');

for (const query of ['', '?vectorgl=always']) {
  test(`the window filters features, the table and images${query ? ' (vector layer on the GPU)' : ''}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await open(page, query);
    await choosePicture(page, 'scene_20240215.png');
    await expect(page.locator('#status')).toContainText('scene_20240215.png を開きました');
    await choose(page, 'observations.geojson', observations);
    await expect(page.locator('#status')).toContainText('observations を開きました');
    await expect(rows(page)).toHaveCount(4);

    // T opens it over everything: nothing is hidden yet.
    await page.locator('#map').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('t');
    await expect(timeline(page)).toBeVisible();
    await expect(timeline(page).locator('.timeline-count')).toHaveText('表示 4 / 4 件');
    await expect(timeline(page).locator('canvas')).toBeVisible();

    // A month: January.
    await timeline(page).getByLabel('期間の幅').selectOption('month');
    await expect(timeline(page).locator('.timeline-label')).toHaveText('2024-01');
    await expect(timeline(page).locator('.timeline-count')).toHaveText('表示 1 / 4 件');
    await expect(rows(page)).toHaveCount(1);
    await expect(page.locator('.table-note, .attributes').first()).toBeVisible();
    const image = () => page.evaluate(() => window.viewer.images.list()[0].layer.getVisible());
    await expect.poll(image).toBe(false);
    // Its check box stays on: only the timeline hides it.
    await expect(page.locator('#images li.time-out input[type=checkbox]')).toBeChecked();

    // February: the image is back.
    await timeline(page).getByRole('button', { name: '次の期間' }).click();
    await expect(timeline(page).locator('.timeline-label')).toHaveText('2024-02');
    await expect(rows(page)).toHaveCount(1);
    await expect.poll(image).toBe(true);
    await expect(page.locator('#images li.time-out')).toHaveCount(0);

    // 累積: from the beginning.
    await timeline(page).getByText('設定').click();
    await timeline(page).getByLabel('累積').check();
    await expect(timeline(page).locator('.timeline-count')).toHaveText('表示 2 / 4 件');

    // The arrow keys on the chart step the window.
    await timeline(page).locator('canvas').focus();
    await page.keyboard.press('ArrowRight');
    await expect(timeline(page).locator('.timeline-count')).toHaveText('表示 3 / 4 件');

    // The layer's settings: the attribute found, and a way to leave the layer alone.
    await expect(timeline(page).getByLabel('開始の属性')).toHaveValue('observed');
    await expect(timeline(page).getByLabel('scene_20240215.png の撮影日時')).toHaveValue('2024-02-15T00:00');
    await expect(timeline(page).locator('.timeline-layers')).toContainText('ファイル名');
    await timeline(page).getByLabel('observations を時間で絞り込む').uncheck();
    await expect(rows(page)).toHaveCount(4);
    await timeline(page).getByLabel('observations を時間で絞り込む').check();
    await expect(rows(page)).toHaveCount(3);

    // Closing shows everything again.
    await timeline(page).getByRole('button', { name: 'タイムラインを閉じる' }).click();
    await expect(timeline(page)).toBeHidden();
    await expect(rows(page)).toHaveCount(4);
    await expect.poll(image).toBe(true);
    // Every feature is drawn again.
    const drawn = await page.evaluate(() => {
      const layer = window.viewer.images.layers().find((l) => l.name === 'observations')!;
      if (layer.type !== 'service') return 0;
      return layer.service.vector!.source.getFeatures().filter((f) => layer.service.style!.inTime(f)).length;
    });
    expect(drawn).toBe(4);
    expect(errors).toEqual([]);
  });
}

test('a WMS layer with a time dimension is drawn at the end of the window', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await page.getByRole('button', { name: 'サービスを追加' }).click();
  const dialog = page.getByRole('dialog', { name: 'サービスを追加' });
  await dialog.getByRole('textbox', { name: 'サービスの URL' }).fill(`${base}/svc/wmstime`);
  await dialog.getByRole('button', { name: '読み込む' }).click();
  await dialog.locator('.service-layer input[type=checkbox]').first().check();
  await dialog.getByRole('button', { name: '追加', exact: true }).click();
  await expect(page.locator('#info')).toContainText('2024-01-01 〜 2024-12-01（12 時点）');
  const times = async () => (await (await page.request.get(`${base}/svc/wms-times`)).json()) as Array<string | null>;
  // Closed: the server's default.
  await expect.poll(async () => (await times()).length).toBeGreaterThan(0);
  expect(await times()).not.toContain('2024-03-01');

  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#timeline-open').click();
  await expect(timeline(page).locator('.timeline-layers')).toContainText('WMS の時間（12 時点）');
  // March 20 (UTC): the March map.
  await page.evaluate(() => window.viewer.timeline.setWindow(Date.UTC(2024, 2, 1), Date.UTC(2024, 2, 20)));
  await expect.poll(async () => (await times()).includes('2024-03-01')).toBe(true);
  const current = () => page.evaluate(() => (window.viewer.images.layers()[0] as { service: { time: { current(): string | null } } }).service.time.current());
  expect(await current()).toBe('2024-03-01');
  await timeline(page).getByRole('button', { name: 'タイムラインを閉じる' }).click();
  await expect.poll(current).toBeNull();
  expect(errors).toEqual([]);
});
