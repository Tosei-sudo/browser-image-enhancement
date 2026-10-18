import { expect, test } from '@playwright/test';

/*
 * The installed app as a share target: the manifest's share_target, and the
 * service worker taking the shared form (files and text) and sending the page
 * to ?share=<id>, which opens the files and reads the text as if pasted.
 */

test.use({ serviceWorkers: 'allow' });

test('the manifest takes shared files and text', async ({ page, request }) => {
  await page.goto('/index.html');
  const href = await page.locator('link[rel=manifest]').getAttribute('href');
  const manifest = await (await request.get(new URL(href!, page.url()).href)).json();
  expect(manifest.share_target).toMatchObject({ action: './share-target', method: 'POST', enctype: 'multipart/form-data', params: { text: 'text', url: 'url' } });
  expect(manifest.share_target.params.files[0].accept).toEqual(expect.arrayContaining(['.tif', '.kml', '.kmz', '.gpx', '.geojson', '.zip', '.shp', '.ivproj', 'image/*']));
});

test('a shared GeoJSON file and WKT text open through the service worker', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.evaluate(() => navigator.serviceWorker.ready);
  // Controlled by the worker (clients.claim, or after a reload).
  if (!(await page.evaluate(() => navigator.serviceWorker.controller !== null))) await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

  // What the operating system's share sheet sends: a multipart POST to the share_target's action.
  await page.evaluate(() => {
    const form = document.createElement('form');
    form.method = 'post';
    form.action = './share-target';
    form.enctype = 'multipart/form-data';
    const input = document.createElement('input');
    input.type = 'file';
    input.name = 'files';
    input.multiple = true;
    const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'a' }, geometry: { type: 'Point', coordinates: [139.7, 35.6] } }] };
    const files = new DataTransfer();
    files.items.add(new File([JSON.stringify(fc)], '共有.geojson', { type: 'application/geo+json' }));
    input.files = files.files;
    const text = document.createElement('input');
    text.name = 'text';
    text.value = 'LINESTRING(139.70 35.60, 139.80 35.70)';
    form.append(input, text);
    document.body.append(form);
    form.submit();
  });
  await page.waitForURL(/[?&]share=/);
  await page.waitForFunction(() => window.viewer !== undefined);
  await expect(page.locator('#images li', { hasText: '共有' })).toHaveCount(1);
  await expect(page.locator('#images li', { hasText: '貼り付け' })).toHaveCount(1);
  await expect(page.locator('#status')).toContainText('WKTとして読み、図形 1 個');
  // The id leaves the address, and the share is gone from the cache (taken once).
  await expect.poll(() => new URL(page.url()).searchParams.has('share')).toBe(false);
  const left = await page.evaluate(async () => (await (await caches.open('iv-share')).keys()).length);
  expect(left).toBe(0);
  // The site's own cache is still there.
  expect(await page.evaluate(async () => (await caches.keys()).some((k) => k.startsWith('image-viewer-')))).toBe(true);
  expect(errors).toEqual([]);
});
