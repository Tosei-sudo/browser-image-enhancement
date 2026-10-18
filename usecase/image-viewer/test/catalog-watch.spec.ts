import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/*
 * Watches of the image catalog: a watch made from the catalog panel's
 * conditions notes the images already there, and an image added later
 * shows in 「通知」 with its count, opens from there, and the installed app's
 * Periodic Background Sync finds new images with the service worker alone.
 */

// Lets context.route answer the service worker's requests too (Chromium).
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const layerUrl = 'http://localhost:4175/svc/watch/FeatureServer/0';
const catalog = {
  label: '監視カタログ',
  url: layerUrl,
  fields: { id: 'IMG_ID', acquired: 'ACQ_TIME', registered: 'REG_TIME', sensor: 'SENSOR', angle: 'OFF_NADIR', source: 'COG_URL' },
};
const ring = (x0: number, y0: number, x1: number, y1: number) => [[[x0, y0], [x0, y1], [x1, y1], [x1, y0], [x0, y0]]];
const image = (id: string, objectId: number, sensor = 'S1') => ({
  attributes: { OBJECTID: objectId, IMG_ID: id, ACQ_TIME: Date.UTC(2026, 9, objectId), REG_TIME: Date.now(), SENSOR: sensor, OFF_NADIR: 10, COG_URL: 'http://localhost:4175/fixture.tif' },
  geometry: { rings: ring(139.6, 35.6, 139.9, 35.75) },
});

/** Serves the stand-in catalog (page or service worker); returns the `where` of each query. */
async function serveCatalog(target: Page | BrowserContext, list: ReturnType<typeof image>[]): Promise<string[]> {
  const queries: string[] = [];
  await target.route(`${layerUrl}**`, async (route) => {
    const request = route.request();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (!request.url().includes('/query')) {
      return json({
        fields: [
          { name: 'OBJECTID', type: 'esriFieldTypeOID' },
          { name: 'IMG_ID', type: 'esriFieldTypeString' },
          { name: 'ACQ_TIME', type: 'esriFieldTypeDate' },
          { name: 'REG_TIME', type: 'esriFieldTypeDate' },
          { name: 'SENSOR', type: 'esriFieldTypeString' },
        ],
        advancedQueryCapabilities: { supportsPagination: true, supportsOrderBy: true },
      });
    }
    const form = new URLSearchParams(request.postData() ?? '');
    if (form.get('returnDistinctValues') === 'true') return json({ features: [{ attributes: { SENSOR: 'S1' } }, { attributes: { SENSOR: 'S2' } }] });
    const where = form.get('where') ?? '';
    const sensor = /SENSOR = '([^']*)'/.exec(where)?.[1];
    const found = list.filter((f) => !sensor || f.attributes.SENSOR === sensor);
    if (form.get('returnCountOnly') === 'true') return json({ count: found.length });
    queries.push(where);
    return json({ objectIdFieldName: 'OBJECTID', geometryType: 'esriGeometryPolygon', spatialReference: { wkid: 4326 }, features: found });
  });
  return queries;
}

test('a watch made in the catalog panel notifies a new image, which opens from 「通知」', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const list = [image('OLD-1', 1), image('OLD-2', 2, 'S2')];
  await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ imageCatalogs: [catalog] }) }));
  const queries = await serveCatalog(page, list);
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  const bell = page.locator('#watch-open');
  await expect(bell).toBeVisible();
  await expect(bell.locator('.watch-count')).toBeHidden();

  // The catalog panel's sensor becomes the watch's condition.
  await page.locator('#catalog-open').click();
  const panel = page.locator('.catalog-dialog');
  await expect(panel.locator('tbody tr')).toHaveCount(2);
  await panel.locator('select[name=sensor]').selectOption('S1');
  await panel.locator('button[value=watch]').click();
  const create = page.locator('.watch-create');
  await expect(create).toBeVisible();
  await expect(create.locator('.watch-conditions')).toContainText('センサー S1');
  await create.locator('input[name=name]').fill('東京湾 S1');
  await create.getByLabel('指定しない').check();
  await create.locator('button[value=ok]').click();
  await expect(create).toBeHidden();
  // The first check only notes what is there.
  await expect.poll(() => page.evaluate(() => window.viewer.watch.watches()[0]?.lastChecked ?? null)).not.toBeNull();
  expect(queries.at(-1)).toMatch(/^SENSOR = 'S1' AND REG_TIME >= TIMESTAMP '/);
  await expect(bell.locator('.watch-count')).toBeHidden();

  // A new image of S1 (and one of S2, which the watch does not want) comes in.
  list.push(image('NEW-3', 3), image('NEW-4', 4, 'S2'));
  await bell.click();
  const center = page.locator('.watch-dialog');
  await center.locator('button[value=check]').click();
  await expect(center.locator('.watch-notice')).toHaveCount(1);
  await expect(center.locator('.watch-notice.unread')).toContainText('NEW-3');
  await expect(center.locator('.watch-notice')).toContainText('東京湾 S1');
  await expect(bell.locator('.watch-count')).toHaveText('1');

  // Checking again finds nothing more.
  await center.locator('button[value=check]').click();
  await expect(center.locator('.service-status')).toHaveText('新着はありません');
  await expect(center.locator('.watch-notice')).toHaveCount(1);

  // Opening it loads the COG and reads the notice.
  await center.locator('.watch-notice button', { hasText: '開く' }).click();
  await expect(page.locator('#images li')).toHaveCount(1);
  await expect(center.locator('.watch-notice.unread')).toHaveCount(0);
  await expect(bell.locator('.watch-count')).toBeHidden();

  // The watches list, and deleting one with its notices.
  await center.locator('.watch-more summary').click();
  await expect(center.locator('.watch-more summary')).toHaveText('監視条件（1）');
  await expect(center.locator('.watch-watch')).toContainText('東京湾 S1');
  await expect(center.locator('.watch-background')).toContainText('10 分ごと');
  await center.locator('.watch-watch button', { hasText: '削除' }).click();
  await expect(center.locator('.watch-watch')).toHaveCount(0);
  await expect(center.locator('.watch-notice')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the map menu watches a point', async ({ page }) => {
  await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ imageCatalogs: [catalog] }) }));
  const queries = await serveCatalog(page, [image('OLD-1', 1)]);
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.locator('#map').click({ button: 'right', position: { x: 300, y: 300 } });
  await page.locator('.coordinate-menu').getByRole('menuitem', { name: 'この地点の新着画像を監視…' }).click();
  const create = page.locator('.watch-create');
  await expect(create.locator('.watch-point')).toBeVisible();
  await expect(create.locator('.watch-point input')).toBeChecked();
  await create.locator('button[value=ok]').click();
  await expect.poll(() => page.evaluate(() => window.viewer.watch.watches()[0]?.area?.kind ?? null)).toBe('point');
  await expect.poll(() => queries.length).toBeGreaterThan(0);
});

test.describe('installed app', () => {
  test.use({ serviceWorkers: 'allow' });

  test('Periodic Background Sync checks the watches in the service worker', async ({ page, context }) => {
    const list = [image('OLD-1', 1)];
    await serveCatalog(context, list);
    await page.goto('/index.html');
    await page.waitForFunction(() => window.viewer !== undefined);
    await page.evaluate(() => navigator.serviceWorker.ready);
    // A watch already checked once, so the page leaves it to its next interval.
    await page.evaluate(
      async ({ catalog, url }) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('image-viewer-catalog-watch', 1);
          request.onupgradeneeded = () => {
            request.result.createObjectStore('watches', { keyPath: 'id' });
            request.result.createObjectStore('notices', { keyPath: 'id' });
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const now = Date.now();
        const tx = db.transaction('watches', 'readwrite');
        tx.objectStore('watches').put({
          id: 'sw',
          name: 'バックグラウンド',
          catalog: { ...catalog, url, labels: {}, columns: [], maxResults: 500, angleKind: 'offNadir', orbitHeight: 600, fields: { ...catalog.fields, source: [catalog.fields.source] } },
          types: { REG_TIME: 'esriFieldTypeDate' },
          conditions: { sensor: '', maxAngle: null, azimuthFrom: null, azimuthTo: null, where: '' },
          area: null,
          enabled: true,
          created: now,
          lastChecked: now,
          lastTried: now,
          seen: ['OLD-1'],
        });
        await new Promise((resolve) => (tx.oncomplete = resolve));
        db.close();
      },
      { catalog, url: layerUrl },
    );
    list.push(image('BG-2', 2));

    const cdp = await context.newCDPSession(page);
    const registrationId = new Promise<string>((resolve) =>
      cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
        const r = registrations.find((x: { isDeleted: boolean }) => !x.isDeleted);
        if (r) resolve(r.registrationId);
      }),
    );
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.dispatchPeriodicSyncEvent', { origin: 'http://localhost:4175', registrationId: await registrationId, tag: 'catalog-watch' });

    // The worker kept the notice, and the open window hears of it.
    await expect.poll(() => page.evaluate(() => window.viewer.watch.notices().map((n) => n.imageId)), { timeout: 15_000 }).toEqual(['BG-2']);
    await expect(page.locator('#watch-open')).toBeHidden(); // no catalog in this config.json
  });
});
