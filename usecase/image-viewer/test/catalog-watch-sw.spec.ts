import { expect, test } from '@playwright/test';
import { catalog, image, layerUrl, serveCatalog } from './catalog-watch-fixtures.js';

/*
 * The installed app's Periodic Background Sync: the service worker alone
 * checks the catalog watches and keeps what it finds for the windows.
 */

// Lets context.route answer the service worker's requests too (Chromium).
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
// Full Chromium (new headless): the headless shell's renderer crashes on setAppBadge in a service worker.
test.use({ serviceWorkers: 'allow', channel: 'chromium' });

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
        areas: [],
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
