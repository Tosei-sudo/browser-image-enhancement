import { expect, test, type Page } from '@playwright/test';

/* config.json: the base maps and other site settings come from it at start, and a broken file falls back to the defaults. */

async function open(page: Page, config: string | null, query = '') {
  const tiles: string[] = [];
  await page.route(/cyberjapandata\.gsi\.go\.jp|tile\.openstreetmap\.org|tiles\.example\.com/, (route) => {
    tiles.push(route.request().url());
    return route.fulfill({ status: 404, body: '' });
  });
  if (config !== null) await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: config }));
  await page.goto(`/index.html${query}`);
  await page.waitForFunction(() => window.viewer !== undefined);
  return tiles;
}

const baseMapOptions = (page: Page) => page.getByRole('combobox', { name: '背景地図' }).locator('option').allTextContents();

test('the shipped config.json gives the built-in base maps', async ({ page }) => {
  await open(page, null);
  expect(await baseMapOptions(page)).toEqual(['背景なし', '地理院 標準', '地理院 淡色', '地理院 写真', '地理院 ベクトル', 'OpenStreetMap', 'OpenStreetMap（Esri ベクトル）']);
  await expect(page.getByRole('combobox', { name: '背景地図' })).toHaveValue('');
});

test('base maps and the default one come from config.json', async ({ page }) => {
  const config = {
    baseMaps: [{ id: 'mine', label: '自社地図', url: 'https://tiles.example.com/{z}/{x}/{y}.png', attributions: '自社', maxZoom: 20 }],
    defaultBaseMap: 'mine',
  };
  const tiles = await open(page, JSON.stringify(config));
  expect(await baseMapOptions(page)).toEqual(['背景なし', '自社地図']);
  await expect(page.getByRole('combobox', { name: '背景地図' })).toHaveValue('mine');
  await expect.poll(() => tiles.some((t) => t.startsWith('https://tiles.example.com/'))).toBe(true);

  // Choosing none is kept in the link, since the default is not none.
  await page.getByRole('combobox', { name: '背景地図' }).selectOption('');
  expect(new URL(page.url()).searchParams.get('base')).toBe('');
  await page.goto(`/index.html${new URL(page.url()).search}`);
  await page.waitForFunction(() => window.viewer !== undefined);
  await expect(page.getByRole('combobox', { name: '背景地図' })).toHaveValue('');
});

test('a broken config.json falls back to the defaults', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (m) => m.type() === 'warning' && warnings.push(m.text()));
  await open(page, '{ "baseMaps": [ broken');
  expect(await baseMapOptions(page)).toEqual(['背景なし', '地理院 標準', '地理院 淡色', '地理院 写真', '地理院 ベクトル', 'OpenStreetMap', 'OpenStreetMap（Esri ベクトル）']);
  expect(warnings.some((w) => w.includes('config.json'))).toBe(true);
});

test('layers in config.json open at start, bottom first, and a shared link does not open them twice', async ({ page }) => {
  await page.request.get('/svc/reset');
  const geojson = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: '東京駅' }, geometry: { type: 'Point', coordinates: [139.7671, 35.6812] } }] };
  await page.route('**/data/stations.geojson', (route) => route.fulfill({ status: 200, contentType: 'application/geo+json', body: JSON.stringify(geojson) }));
  const config = {
    layers: [
      { type: 'cog', url: '/fixture.tif' },
      { type: 'wfs', url: 'http://localhost:4175/svc/wfs', layer: 'test:stations' },
      { type: 'file', url: './data/stations.geojson' },
      { type: 'wms', url: 'http://localhost:4175/svc/wms' }, // no layer: ignored
    ],
  };
  const warnings: string[] = [];
  page.on('console', (m) => m.type() === 'warning' && warnings.push(m.text()));
  await open(page, JSON.stringify(config));
  // The list shows the top layer first.
  await expect(page.locator('#images .name')).toHaveCount(3);
  const names = await page.locator('#images .name').allTextContents();
  expect(names[0]).toContain('stations');
  expect(names[1]).toContain('駅');
  expect(names[2]).toContain('fixture');
  expect(warnings.some((w) => w.includes('layers[3]'))).toBe(true);

  // The address now lists the WFS layer; opening it again keeps one WFS layer.
  const link = new URL(page.url()).search;
  expect(new URLSearchParams(link).getAll('service')).toHaveLength(1);
  await page.goto(`/index.html${link}`);
  await page.waitForFunction(() => window.viewer !== undefined);
  await expect(page.locator('#images .name')).toHaveCount(3);
});
