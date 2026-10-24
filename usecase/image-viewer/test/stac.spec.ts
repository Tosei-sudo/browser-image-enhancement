import { expect, test, type Page } from '@playwright/test';

/*
 * The STAC search panel against a stand-in STAC API (page.route) whose items
 * point to the test server's COGs: search by the view, dates and cloud cover,
 * page through `next`, open the true color asset, open band assets as an RGB
 * composite, and read a static catalog by URL.
 */

const api = 'http://localhost:4175/stac-api';
const config = { stacCatalogs: [{ label: 'テスト STAC', url: api, collections: ['sentinel-2-l2a', 'landsat-c2-l2'], token: 'secret' }] };
const tif = 'image/tiff; application=geotiff; profile=cloud-optimized';
// A 1×1 gray PNG as the thumbnails.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==', 'base64');

const ring = (x0: number, y0: number, x1: number, y1: number) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
const item = (id: string, day: number, cloud: number, assets: Record<string, unknown>, collection = 'sentinel-2-l2a') => ({
  type: 'Feature',
  stac_version: '1.0.0',
  id,
  collection,
  bbox: [139.6, 35.6, 139.9, 35.75],
  geometry: { type: 'Polygon', coordinates: ring(139.6 + day * 0.002, 35.6, 139.9, 35.75) },
  properties: { datetime: `2026-09-${String(day).padStart(2, '0')}T01:30:00Z`, 'eo:cloud_cover': cloud, platform: 'sentinel-2b' },
  links: [],
  assets: { thumbnail: { href: `https://thumbs.example.com/${id}.png`, type: 'image/png', roles: ['thumbnail'] }, ...assets },
});
const visualItem = item('S2_VISUAL', 20, 2.5, { visual: { href: 'http://localhost:4175/fixture.tif', type: tif, roles: ['visual'], title: 'True color image' } });
const band = (name: string, common: string) => ({ href: `http://localhost:4175/fixture16.tif?band=${name}`, type: tif, roles: ['data'], 'eo:bands': [{ name, common_name: common }] });
const bandsItem = item('S2_BANDS', 12, 8, { B04: band('B04', 'red'), B03: band('B03', 'green'), B02: band('B02', 'blue'), B08: band('B08', 'nir') });
const landsat = item('LC09_OLD', 3, 40, { red: { href: 's3://usgs-landsat/red.tif', type: tif } }, 'landsat-c2-l2');

/** Serves config.json and the stand-in API; returns the bodies of the searches and the headers they came with. */
async function serveStac(page: Page, settings: object = config): Promise<{ bodies: Array<Record<string, unknown>>; auth: string[]; thumbAuth: string[] }> {
  const seen = { bodies: [] as Array<Record<string, unknown>>, auth: [] as string[], thumbAuth: [] as string[] };
  await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(settings) }));
  await page.route('https://thumbs.example.com/**', (route) => {
    seen.thumbAuth.push(route.request().headers().authorization ?? '');
    return route.fulfill({ status: 200, contentType: 'image/png', body: png });
  });
  await page.route(`${api}/**`, async (route) => {
    const request = route.request();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/geo+json', body: JSON.stringify(body) });
    if (!request.url().endsWith('/search')) return route.fulfill({ status: 404, body: '{}' });
    const body = request.postDataJSON() as Record<string, unknown>;
    seen.bodies.push(body);
    seen.auth.push(request.headers().authorization ?? '');
    const max = (body.query as { 'eo:cloud_cover'?: { lte: number } } | undefined)?.['eo:cloud_cover']?.lte ?? 100;
    const all = [visualItem, bandsItem, landsat].filter((f) => f.properties['eo:cloud_cover'] <= max);
    // Two per page; the next page by a token merged into the body.
    const page = Number(body.page ?? 1);
    const features = all.slice((page - 1) * 2, page * 2);
    const next = page * 2 < all.length ? [{ rel: 'next', href: `${api}/search`, method: 'POST', body: { page: page + 1 }, merge: true }] : [];
    return json({ type: 'FeatureCollection', features, numberMatched: all.length, links: next });
  });
  return seen;
}

async function openPanel(page: Page) {
  await page.locator('#tools-menu .menu-button').click();
  await page.locator('#stac-open').click();
  return page.locator('.stac-dialog');
}

test('Earth Search by default; "stacCatalogs": [] hides the panel', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  expect(await page.evaluate(() => window.viewer.config.stacCatalogs.map((c) => c.url))).toEqual(['https://earth-search.aws.element84.com/v1']);
  await page.locator('#tools-menu .menu-button').click();
  await expect(page.locator('#stac-open')).toBeVisible();

  await serveStac(page, { stacCatalogs: [] });
  await page.reload();
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.locator('#tools-menu .menu-button').click();
  await expect(page.locator('#stac-open')).toBeHidden();
  await expect(page.locator('#tools-panel .menu-heading', { hasText: 'データ検索' })).toBeHidden();
});

test('searches, pages, and opens true color and band assets', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const seen = await serveStac(page);
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.evaluate(() => window.viewer.map.getView().fit(window.viewer.map.getView().getProjection().getCode() === 'EPSG:3857' ? [15540000, 4245000, 15575000, 4265000] : [139.6, 35.6, 139.9, 35.75]));

  const dialog = await openPanel(page);
  const rows = dialog.locator('tbody tr');
  // Opening searches the view at once, newest first, two to a page.
  await expect(rows).toHaveCount(2);
  await expect(rows.locator('td:nth-child(5)')).toHaveText(['S2_VISUAL', 'S2_BANDS']);
  await expect(dialog.locator('.service-status')).toContainText('3 件中 2 件');
  const first = seen.bodies[0];
  expect(first.collections).toEqual(['sentinel-2-l2a', 'landsat-c2-l2']);
  expect(first.sortby).toEqual([{ field: 'properties.datetime', direction: 'desc' }]);
  expect((first.bbox as number[]).length).toBe(4);
  expect(seen.auth[0]).toBe('Bearer secret');
  // Thumbnails are plain pictures, without the catalog's token.
  await expect(rows.first().locator('img')).toHaveJSProperty('naturalWidth', 1);
  expect(seen.thumbAuth.every((a) => a === '')).toBe(true);

  // The next page joins the list.
  await dialog.locator('.stac-more').click();
  await expect(rows).toHaveCount(3);
  expect(seen.bodies.at(-1)).toMatchObject({ page: 2, collections: ['sentinel-2-l2a', 'landsat-c2-l2'] });
  await expect(dialog.locator('.stac-more')).toBeHidden();
  // The Landsat scene's only asset is on s3://: it cannot be opened.
  await expect(rows.nth(2)).toHaveClass(/stac-none/);
  expect(await page.evaluate(() => window.viewer.stac.footprints.getSource()!.getFeatures().length)).toBe(3);

  // Dates and cloud cover narrow the search.
  await dialog.locator('input[name=from]').fill('2026-09-01');
  await dialog.locator('input[name=maxCloud]').fill('10');
  await dialog.locator('button.catalog-search').click();
  await expect(rows).toHaveCount(2);
  expect(seen.bodies.at(-1)).toMatchObject({ datetime: '2026-09-01T00:00:00Z/..', query: { 'eo:cloud_cover': { lte: 10 } } });
  await rows.nth(1).click();

  // The true color asset opens by default, with the item's attributes.
  await rows.filter({ hasText: 'S2_VISUAL' }).dblclick();
  await expect(page.locator('#images li')).toHaveCount(1);
  await page.locator('#images li .name').first().click();
  await expect(page.locator('#info')).toContainText('S2_VISUAL');
  await expect(page.locator('#info')).toContainText('テスト STAC');
  await expect(page.locator('#info')).toContainText('2.5 %');

  // Band assets: red, green and blue open as layers and go into the RGB composite, ready to run.
  await rows.filter({ hasText: 'S2_BANDS' }).click();
  const asset = dialog.locator('select[name=asset]');
  await expect(asset.locator('option:checked')).toHaveText('RGB 合成（B04・B03・B02）');
  await expect(asset.locator('option')).toContainText(['RGB 合成（B04・B03・B02）', 'フォールスカラー（B08・B04・B03）', 'B04（red）']);
  await dialog.locator('button[value=open]').click();
  const composite = page.locator('.composite-dialog');
  await expect(composite).toBeVisible();
  await expect(page.locator('#images li')).toHaveCount(4);
  await expect(page.locator('#images .badge')).toContainText(['blue', 'green', 'red']);
  for (const [label, name] of [['赤（R）', 'B04'], ['緑（G）', 'B03'], ['青（B）', 'B02']]) await expect(composite.getByLabel(label).locator('option:checked')).toContainText(`band=${name}`);
  await composite.getByRole('button', { name: '実行' }).click();
  await expect(page.locator('#images li')).toHaveCount(5);
  await expect(page.locator('#images .name').first()).toContainText('RGB 合成');

  // Bands chosen by hand.
  await rows.filter({ hasText: 'S2_BANDS' }).click();
  await asset.selectOption('custom');
  const bands = dialog.locator('.stac-bands select');
  await expect(bands).toHaveCount(3);
  await expect(bands.first().locator('option:checked')).toHaveText('B04（red）');
  await bands.first().selectOption('asset:B08');
  await dialog.locator('button[value=open]').click();
  await expect(composite).toBeVisible();
  await expect(composite.getByLabel('赤（R）').locator('option:checked')).toContainText('band=B08');
  expect(errors).toEqual([]);
});

test('reads a static catalog by URL', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await serveStac(page);
  const docs: Record<string, unknown> = {
    'catalog.json': { type: 'Catalog', stac_version: '1.0.0', id: 'root', links: [{ rel: 'child', href: './s2/collection.json' }] },
    's2/collection.json': { type: 'Collection', stac_version: '1.0.0', id: 's2', links: [{ rel: 'item', href: './a/item.json' }, { rel: 'item', href: './b/item.json' }] },
    's2/a/item.json': { ...visualItem, id: 'STATIC_A', assets: { visual: { href: '../../../fixture.tif', type: tif, roles: ['visual'] } } },
    's2/b/item.json': { ...bandsItem, id: 'STATIC_B' },
  };
  await page.route('http://localhost:4175/static/**', (route) => {
    const doc = docs[new URL(route.request().url()).pathname.replace('/static/', '')];
    return doc ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(doc) }) : route.fulfill({ status: 404, body: '' });
  });
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  const dialog = await openPanel(page);
  await dialog.locator('summary').click();
  await dialog.locator('input[name=staticUrl]').fill('http://localhost:4175/static/catalog.json');
  await dialog.getByRole('button', { name: '読み込み', exact: true }).click();
  const rows = dialog.locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.locator('td:nth-child(5)')).toHaveText(['STATIC_A', 'STATIC_B']);
  await expect(dialog.locator('.service-status')).toContainText('静的カタログから 2 件');
  // Its relative asset href is read against the item's URL.
  await rows.first().dblclick();
  await expect(page.locator('#images li')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('Planetary Computer: assets are signed on each request, never in the layer name', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const blob = 'https://pcacct.blob.core.windows.net/scenes/fixture.tif';
  const signed = { ...visualItem, id: 'PC_SCENE', assets: { visual: { href: blob, type: tif, roles: ['visual'] } } };
  const tokenAsks: string[] = [];
  const unsigned: string[] = [];
  await serveStac(page, { stacCatalogs: [{ label: 'PC', url: api, collections: ['sentinel-2-l2a'], sign: 'planetary-computer' }] });
  await page.route(`${api}/search`, (route) => route.fulfill({ status: 200, contentType: 'application/geo+json', body: JSON.stringify({ type: 'FeatureCollection', features: [signed], links: [] }) }));
  await page.route('https://planetarycomputer.microsoft.com/api/sas/v1/token/**', (route) => {
    tokenAsks.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ token: 'st=1&sig=secret%3D', 'msft:expiry': '2099-01-01T00:00:00Z' }) });
  });
  await page.route('https://pcacct.blob.core.windows.net/**', async (route) => {
    if (!route.request().url().includes('sig=secret')) {
      unsigned.push(route.request().url());
      return route.fulfill({ status: 403, headers: { 'access-control-allow-origin': '*' }, body: '' });
    }
    const response = await route.fetch({ url: 'http://localhost:4175/fixture.tif' });
    return route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range' } });
  });
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  const dialog = await openPanel(page);
  await dialog.locator('tbody tr').first().dblclick();
  await expect(page.locator('#images li')).toHaveCount(1);
  expect(tokenAsks).toEqual(['https://planetarycomputer.microsoft.com/api/sas/v1/token/pcacct/scenes']);
  expect(unsigned).toEqual([]);
  // The layer keeps the unsigned URL (what a project saves), the token is nowhere in the page's address.
  expect(await page.evaluate(() => window.viewer.images.list().map((i) => i.name))).toEqual([blob]);
  expect(page.url()).not.toContain('secret');
  expect(errors).toEqual([]);
  // Tiles may still be loading.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
