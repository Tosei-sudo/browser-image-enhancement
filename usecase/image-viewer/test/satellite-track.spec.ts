import { expect, test, type Page } from '@playwright/test';

/*
 * The 「衛星パス」 panel: several satellites at once, each in its own colour,
 * with their ground track and what they can image, at a moment or over a
 * period, on the map and in the 3D view. Without a catalog in config.json the
 * imaging plan's two samples are the satellites; a pasted TLE adds one.
 */

const line1 = '1 25544U 98067A   26280.50000000  .00016717  00000-0  10270-3 0  9994';
const line2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49815399432717';

async function openPanel(page: Page): Promise<void> {
  await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.locator('#tools-menu .menu-button').click();
  await page.locator('#track-open').click();
  await expect(page.locator('.track-dialog')).toBeVisible();
}

const kinds = (page: Page) =>
  page.evaluate(() => {
    const count: Record<string, number> = {};
    for (const f of window.viewer.satelliteTracks.overlay.getSource()!.getFeatures()) count[f.get('kind')] = (count[f.get('kind')] ?? 0) + 1;
    return count;
  });

test('shows several satellites at a moment, then over a period', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openPanel(page);
  const dialog = page.locator('.track-dialog');
  // The two samples start chosen: both show at once, in two colours.
  await expect(dialog.locator('.service-status')).toContainText('2 機の軌跡と撮像可能範囲');
  await expect(dialog.locator('tbody tr')).toHaveCount(2);
  const colors = await page.evaluate(() => window.viewer.satelliteTracks.tracks().map((t) => t.color));
  expect(new Set(colors).size).toBe(2);
  let count = await kinds(page);
  expect(count.track).toBeGreaterThanOrEqual(2);
  expect(count.reach).toBeGreaterThanOrEqual(2);
  expect(count.satellite).toBe(2);
  // Details stay folded.
  await expect(dialog.locator('select[name=window]')).toBeHidden();

  // A moment: the pass 15 minutes either side of it.
  await dialog.locator('input[name=at]').fill('2026-10-08T10:30');
  await expect.poll(() => page.evaluate(() => window.viewer.satelliteTracks.tracks()[0]?.track.from)).toBe(new Date('2026-10-08T10:15').getTime());
  const zoomed = page.evaluate(() => new Promise<void>((resolve) => window.viewer.map.once('moveend', () => resolve())));
  await dialog.getByRole('button', { name: '範囲へ移動' }).click();
  await zoomed;
  await page.screenshot({ path: 'test-results/satellite-track-at.png' });

  // A pasted TLE adds a third satellite, chosen at once.
  await dialog.locator('summary', { hasText: '詳細' }).click();
  await dialog.locator('textarea[name=tle]').fill(`ISS (ZARYA)\n${line1}\n${line2}`);
  await dialog.locator('textarea[name=tle]').dispatchEvent('change');
  await expect(dialog.locator('tbody tr')).toHaveCount(3);
  await expect(dialog.locator('tbody')).toContainText('ISS (ZARYA)');
  // Unchosen, it goes again.
  await dialog.locator('.track-list label', { hasText: 'ISS' }).locator('input').uncheck();
  await expect(dialog.locator('tbody tr')).toHaveCount(2);

  // A period: the whole day's tracks, the satellites marked at the start.
  await dialog.locator('select[name=mode]').selectOption('range');
  await dialog.locator('input[name=from]').fill('2026-10-08T00:00');
  await dialog.locator('input[name=to]').fill('2026-10-09T00:00');
  await expect.poll(() => page.evaluate(() => window.viewer.satelliteTracks.tracks()[0]?.track.to)).toBe(new Date('2026-10-09T00:00').getTime());
  count = await kinds(page);
  // 14 or so orbits each, cut at the antimeridian.
  expect(count.track).toBeGreaterThan(20);
  expect(count.tick).toBeGreaterThan(20);
  await expect(dialog.locator('.service-status')).toContainText('2026/10/08 00:00 〜 2026/10/09 00:00');
  // Every piece stays within the world.
  const inside = await page.evaluate(() =>
    window.viewer.satelliteTracks
      .overlay.getSource()!
      .getFeatures()
      .every((f) => {
        const [x0, , x1] = f.getGeometry()!.getExtent();
        return x0 >= -20037509 && x1 <= 20037509;
      }),
  );
  expect(inside).toBe(true);
  await page.evaluate(() => window.viewer.map.getView().setZoom(2));
  await page.screenshot({ path: 'test-results/satellite-track-range.png' });

  // Longer than 7 days is cut to 7.
  await dialog.locator('input[name=to]').fill('2026-10-20T00:00');
  await expect(dialog.locator('.service-status')).toContainText('最長 7 日');

  // As a layer: a track and a reach per satellite.
  await dialog.locator('input[name=to]').fill('2026-10-08T06:00');
  await expect(dialog.locator('.service-status')).toContainText('〜 2026/10/08 06:00');
  await dialog.getByRole('button', { name: 'レイヤーとして追加' }).click();
  await expect(page.locator('#images li')).toHaveCount(1);
  await expect(page.locator('#images li')).toContainText('衛星パス');
  expect(errors).toEqual([]);
});

test('in 3D, each satellite has its orbit, its reach on the ground and its model at the moment', async ({ page }) => {
  test.setTimeout(120_000);
  await openPanel(page);
  const dialog = page.locator('.track-dialog');
  await expect(dialog.locator('tbody tr')).toHaveCount(2);
  await page.locator('#globe-toggle').click();
  await expect(page.locator('#globe-section')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.viewer.globe.globe()?.tracks.tracks().length ?? 0), { timeout: 30_000 }).toBe(2);
  const shown = await page.evaluate(() =>
    window.viewer.globe
      .globe()!
      .tracks.tracks()
      .map((t) => ({ orbit: t.orbit.length, reach: t.reach.length, at: !!t.at, height: Math.min(...t.heights) })),
  );
  for (const t of shown) {
    expect(t.orbit).toBeGreaterThan(100);
    expect(t.reach).toBeGreaterThan(5);
    expect(t.at).toBe(true);
    expect(t.height).toBeGreaterThan(600_000);
  }
  // A period: no model, the orbits only.
  await dialog.locator('select[name=mode]').selectOption('range');
  await expect.poll(() => page.evaluate(() => window.viewer.globe.globe()!.tracks.tracks().every((t) => !t.at))).toBe(true);
  await page.evaluate(() => window.viewer.globe.globe()!.widget.scene.render());
  await page.screenshot({ path: 'test-results/satellite-track-globe.png' });
  // Closed: nothing is left in 3D.
  await dialog.locator('.catalog-close').click();
  await expect.poll(() => page.evaluate(() => window.viewer.globe.globe()!.tracks.tracks().length)).toBe(0);
});
