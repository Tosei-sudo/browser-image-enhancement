import { expect, test, type Page } from '@playwright/test';

/*
 * Signing in (src/auth.ts, src/auth-menu.ts): an ArcGIS portal's OAuth sign-in
 * in a popup (the stand-in portal of test/auth-services.mjs), its token used
 * for a federated server's secured layer and renewed once when the server
 * refuses it; and config.json's authRules adding a header to COG reads and
 * base map tiles.
 */

const base = 'http://localhost:4175';

async function open(page: Page, config: object, query = '') {
  await page.request.get('/auth-test/reset');
  await page.route(/cyberjapandata\.gsi\.go\.jp|tile\.openstreetmap\.org/, (route) => route.fulfill({ status: 404, body: '' }));
  await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config) }));
  await page.goto(`/index.html${query}`);
  await page.waitForFunction(() => window.viewer !== undefined);
}

async function addService(page: Page, url: string) {
  await page.getByRole('button', { name: 'サービスを追加' }).click();
  const dialog = page.getByRole('dialog', { name: 'サービスを追加' });
  await dialog.getByRole('textbox', { name: 'サービスの URL' }).fill(url);
  await dialog.getByRole('button', { name: '読み込む' }).click();
  await expect(dialog.locator('.service-layer')).toHaveCount(1);
  await dialog.getByRole('button', { name: '追加', exact: true }).click();
  await expect(dialog).toBeHidden();
}

const log = async (page: Page) => (await (await page.request.get('/auth-test/log')).json()) as { tokenRequests: string[]; featureTokens: string[]; secureHeaders: string[] };

test('signing in to an ArcGIS portal in a popup gives its token to the federated servers', async ({ page }) => {
  await open(page, { arcgisPortals: [{ label: 'テストポータル', url: `${base}/portal`, clientId: 'viewer-app' }] });
  const menu = page.locator('#signin-menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('button', { name: 'サインイン', exact: true }).click();
  const popup = page.waitForEvent('popup');
  await menu.getByRole('button', { name: 'テストポータル にサインイン' }).click();
  await popup;
  await expect(menu.locator('.menu-button')).toHaveText('taro');
  await expect(page.locator('#status')).toContainText('テストポータル に 山田 太郎（taro） でサインインしました');
  expect((await log(page)).tokenRequests).toEqual(['authorization_code']);

  // The secured layer of the federated server opens with no token typed.
  await addService(page, `${base}/fedserver/rest/services/Sites/FeatureServer/0`);
  await expect(page.locator('.table-count')).toContainText('全 2 件');
  expect((await log(page)).featureTokens).not.toContain('none');
  // The token stays out of the address.
  expect(page.url()).not.toContain('tok-');

  await menu.locator('.menu-button').click();
  await expect(menu.locator('.signin-user')).toHaveText('山田 太郎（taro）');
  await page.keyboard.press('Escape');

  // A reload keeps the sign-in (this tab); a token the server no longer takes is renewed once and the request sent again.
  await page.request.get('/auth-test/expire');
  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);
  await expect(menu.locator('.menu-button')).toHaveText('taro');
  await addService(page, `${base}/fedserver/rest/services/Sites/FeatureServer/0`);
  await expect(page.locator('.table-count')).toContainText('全 2 件');
  expect((await log(page)).tokenRequests).toEqual(['authorization_code', 'refresh_token']);

  // Signing out forgets the tokens.
  await menu.locator('.menu-button').click();
  await menu.getByRole('button', { name: 'サインアウト' }).click();
  await expect(menu.locator('.menu-button')).toHaveText('サインイン');
  expect(await page.evaluate(() => sessionStorage.getItem('image-viewer.arcgis-sessions'))).toBeNull();
});

test('the sign-in menu stays hidden without portals in config.json', async ({ page }) => {
  await open(page, {});
  await expect(page.locator('#signin-menu')).toBeHidden();
});

test('authRules add their header to COG reads and base map tiles, and to nothing else', async ({ page }) => {
  const otherHeaders: Array<string | undefined> = [];
  page.on('request', (r) => {
    if (r.url().startsWith(`${base}/fixture16.tif`)) otherHeaders.push(r.headers()['x-api-key']);
  });
  await open(
    page,
    {
      authRules: [{ prefix: `${base}/secure/`, headers: { 'x-api-key': 'secret-key' } }],
      baseMaps: [{ id: 'secure', label: '保護タイル', url: `${base}/secure/tiles/{z}/{x}/{y}.png` }],
      defaultBaseMap: 'secure',
    },
    `?url=${encodeURIComponent(`${base}/secure/fixture.tif`)}&url=${encodeURIComponent(`${base}/fixture16.tif`)}`,
  );
  // Both open, the secured one under its URL as given.
  await expect.poll(() => page.evaluate(() => window.viewer.images.layers().map((l) => (l.type === 'image' ? l.name : '')).sort())).toEqual([`${base}/fixture16.tif`, `${base}/secure/fixture.tif`]);
  await expect.poll(async () => (await log(page)).secureHeaders.some((h) => h === 'tile:secret-key')).toBe(true);
  const headers = (await log(page)).secureHeaders;
  expect(headers).toContain('cog:secret-key');
  expect(headers.filter((h) => h.endsWith(':none'))).toEqual([]);
  expect(otherHeaders.length).toBeGreaterThan(0);
  expect(otherHeaders.every((h) => h === undefined)).toBe(true);
});
