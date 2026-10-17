import { expect, test } from '@playwright/test';

/*
 * Shapes in a link: `?geom=` (lat/lon, MGRS, WKT), `?polygon=`… open as one
 * temporary layer zoomed to, leave the address (a reload restores the layer
 * once), and a feature's row menu copies a link that shows it again.
 */

const rows = (page: import('@playwright/test').Page) => page.locator('.attributes tbody tr[data-index]');

test('a link with a point, an MGRS point and a WKT polygon opens them as a labeled temporary layer', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const query = new URLSearchParams([
    ['geom', '35.6812, 139.7671'],
    ['label', '東京駅'],
    ['geom', '54SUE8843349290'],
    ['label', ''],
    ['geom', 'POLYGON((139.70 35.65, 139.80 35.65, 139.80 35.72, 139.70 35.65))'],
    ['label', '<img src=x onerror=alert(1)>区域'],
    ['name', '現場'],
    ['color', '#e6194b'],
    ['service', 'unknown'],
  ]);
  await page.goto(`/index.html?${query}`);
  await page.waitForFunction(() => window.viewer !== undefined);
  await expect(page.locator('#status')).toContainText('リンクの図形 3 個を一時レイヤー「現場」に追加しました');
  await expect(page.locator('#images li')).toContainText('現場');
  // The shapes left the address; the rest stays.
  await expect.poll(() => new URL(page.url()).search).not.toContain('geom');
  expect(new URL(page.url()).searchParams.get('name')).toBeNull();
  // Zoomed to the shapes (around Tokyo).
  await page.waitForFunction(() => !window.viewer.map.getView().getAnimating());
  const center = await page.evaluate(() => [(window.viewer.map.getView().getCenter()![0] / 20037508.34) * 180]);
  expect(center[0]).toBeGreaterThan(139);
  expect(center[0]).toBeLessThan(141);
  // Labels are text, nothing of the link runs; the layer's style shows them.
  const style = await page.evaluate(() => {
    const layer = window.viewer.images.layers().find((l) => l.type === 'service' && l.service.title === '現場');
    return layer?.type === 'service' ? layer.service.style!.get() : null;
  });
  expect(style?.label.field).toBe('label');
  expect(style?.symbol.stroke).toBe('#e6194b');
  await page.locator('#images li', { hasText: '現場' }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).nth(2)).toContainText('<img src=x onerror=alert(1)>区域');

  // The row menu copies a link showing the feature again.
  await rows(page).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '図形のリンクをコピー' }).click();
  await expect(page.locator('#status')).toContainText('リンクをコピーしました');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(new URL(link).searchParams.get('geom')).toMatch(/^POINT\(139\.7671 35\.6812\)$/);
  expect(new URL(link).searchParams.get('label')).toBe('東京駅');

  // A reload restores the layer once (the address has no shapes any more).
  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);
  await expect(page.locator('#status')).toContainText('復元しました');
  await expect(page.locator('#images li', { hasText: '現場' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a link of shapes that cannot be read says why and adds nothing', async ({ page }) => {
  await page.goto(`/index.html?${new URLSearchParams([['geom', 'POINT(1 2);alert(1)'], ['polygon', '35,139']])}`);
  await page.waitForFunction(() => window.viewer !== undefined);
  await expect(page.locator('#status')).toContainText('リンクの図形を表示できませんでした');
  await expect(page.locator('#status')).toContainText('WKT として読めません');
  await expect(page.locator('#status')).toContainText('3 点以上');
  await expect(page.locator('#images li', { hasText: 'リンクの図形' })).toHaveCount(0);
});

test('the installed app handles web+imageviewer: links', async ({ page, request }) => {
  await page.goto('/index.html');
  const href = await page.locator('link[rel=manifest]').getAttribute('href');
  const manifest = await (await request.get(new URL(href!, page.url()).href)).json();
  expect(manifest.protocol_handlers).toEqual([{ protocol: 'web+imageviewer', url: './?link=%s' }]);
  expect(manifest.launch_handler.client_mode[0]).toBe('focus-existing');
  // What the browser opens for `web+imageviewer:geom=…`.
  await page.goto(`/index.html?link=${encodeURIComponent('web+imageviewer:geom=35.68,139.76&label=駅&url=https://example.invalid/x.tif')}`);
  await page.waitForFunction(() => window.viewer !== undefined);
  await expect(page.locator('#status')).toContainText('リンクの図形 1 個を一時レイヤー');
  await expect.poll(() => new URL(page.url()).search).toBe('');
  // A point alone is shown with its surroundings (zoom 14), not as close as the map goes.
  await page.waitForFunction(() => !window.viewer.map.getView().getAnimating());
  expect(await page.evaluate(() => window.viewer.map.getView().getZoom())).toBeCloseTo(14, 1);
});
