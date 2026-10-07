import { expect, test } from '@playwright/test';

/*
 * The viewer as an installable app: the manifest (with .ivproj files handled
 * by the app), and the service worker that keeps the site for offline use.
 */

test.use({ serviceWorkers: 'allow' });

test('the manifest makes the site an app that opens project files', async ({ page, request }) => {
  await page.goto('/index.html');
  const href = await page.locator('link[rel=manifest]').getAttribute('href');
  const manifest = await (await request.get(new URL(href!, page.url()).href)).json();
  expect(manifest).toMatchObject({ display: 'standalone', start_url: './', scope: './' });
  expect(manifest.file_handlers[0].accept).toEqual({ 'application/x-image-viewer-project+json': ['.ivproj'] });
  for (const icon of manifest.icons) {
    const response = await request.get(new URL(icon.src, page.url()).href);
    expect(response.ok(), icon.src).toBe(true);
  }
  expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
});

test('the service worker keeps the site, so it opens offline', async ({ page, context }) => {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  // Installed with every file of the build cached.
  const cached = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const keys = await caches.keys();
    const cache = await caches.open(keys.find((k) => k.startsWith('image-viewer-'))!);
    return { scope: registration.scope, files: (await cache.keys()).map((r) => new URL(r.url).pathname) };
  });
  expect(cached.scope).toBe(new URL('/', page.url()).href);
  expect(cached.files).toEqual(expect.arrayContaining(['/index.html', '/config.json', '/manifest.webmanifest']));
  expect(cached.files.some((f) => /^\/assets\/index-.*\.js$/.test(f))).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await expect(page.getByRole('button', { name: 'プロジェクト' })).toBeVisible();
  await context.setOffline(false);
});
