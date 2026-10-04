import { expect, test, type Download, type Page } from '@playwright/test';
import Point from 'ol/geom/Point.js';
import { ascii, dbf, gpkg, shp, tokyoSjis } from './fixtures.js';
import { encodeGeometry, readGeoPackage, rows as sqlRows } from '../src/geopackage.js';
import { readVectorFiles } from '../src/vector-files.js';

/*
 * Editing layers read from files: GeoPackage, Shapefile and GeoJSON. "Save"
 * writes the file again, over the original when it was picked with a handle,
 * else as a download.
 */

async function open(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

async function choose(page: Page, files: Array<{ name: string; bytes: Uint8Array | string }>) {
  const sent = files.map((f) => ({ name: f.name, bytes: typeof f.bytes === 'string' ? f.bytes : Array.from(f.bytes) }));
  await page.evaluate((files) => {
    const list = new DataTransfer();
    for (const f of files) list.items.add(new File([typeof f.bytes === 'string' ? f.bytes : new Uint8Array(f.bytes)], f.name));
    const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
    input.files = list.files;
    input.dispatchEvent(new Event('change'));
  }, sent);
}

async function pixelOf(page: Page, lon: number, lat: number) {
  await page.waitForFunction(() => !window.viewer.map.getView().getAnimating());
  const [x, y] = await page.evaluate(([lon, lat]) => {
    const c = [(lon * 20037508.342789244) / 180, Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * 6378137];
    return window.viewer.map.getPixelFromCoordinate(c);
  }, [lon, lat]);
  const box = (await page.locator('#map').boundingBox())!;
  return { x: box.x + x, y: box.y + y };
}

async function bytesOf(download: Download): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

const rows = (page: Page) => page.locator('.attributes tbody tr[data-index]');

test('a GeoPackage is edited (attributes, a new point, a deletion) and saved with its other columns and spatial index', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await open(page);
  const wgs84 = { id: 4326, organization: 'EPSG', code: 4326, definition: 'undefined' };
  await choose(page, [
    {
      name: 'stations.gpkg',
      bytes: await gpkg('stations', wgs84, 'POINT', [
        [encodeGeometry(new Point([139.7, 35.7]), 4326), '東京', 100, '2024-05-01'],
        [encodeGeometry(new Point([135.5, 34.7]), 4326), '大阪', 20, null],
        [encodeGeometry(new Point([130.4, 33.6]), 4326), '博多', 5, null],
      ]),
    },
  ]);
  await expect(page.locator('#status')).toContainText('stations を開きました');
  await page.locator('#images li').getByRole('button', { name: '編集' }).click();
  await expect(page.getByRole('toolbar', { name: '編集' })).toBeVisible();
  // The table's type: no choice of what to draw.
  await expect(page.locator('.edit-kind')).toBeHidden();
  // The feature id stays read-only.
  await expect(rows(page).first().locator('td:not(.check)').nth(0).locator('input')).toHaveCount(0);

  await rows(page).first().getByRole('textbox', { name: 'NAME' }).fill('東京駅');
  await rows(page).first().getByRole('textbox', { name: 'NAME' }).press('Enter');
  await rows(page).nth(2).locator('td:not(.check)').first().click();
  await page.getByRole('button', { name: '削除' }).click();
  await expect(rows(page)).toHaveCount(2);

  await page.getByRole('button', { name: '追加', exact: true }).click();
  const at = await pixelOf(page, 136.9, 35.2);
  await page.mouse.click(at.x, at.y);
  await expect(rows(page)).toHaveCount(1);
  await rows(page).first().getByRole('textbox', { name: 'NAME' }).fill('名古屋');
  await rows(page).first().getByRole('textbox', { name: 'NAME' }).press('Enter');
  await page.getByRole('button', { name: '追加', exact: true }).click();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存 (3)' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('stations.gpkg');
  await expect(page.locator('#status')).toContainText('3 件の変更を保存しました（ファイルをダウンロードしました）');
  // The new row has its id now.
  await page.getByRole('button', { name: '全件' }).click();
  await expect(rows(page)).toHaveCount(3);

  const [layer] = await readGeoPackage(await bytesOf(file), 'stations');
  expect(layer.features.map((f) => [f.getId(), f.get('NAME'), f.get('POP')])).toEqual([
    [1, '東京駅', 100],
    [2, '大阪', 20],
    [4, '名古屋', null],
  ]);
  const [x] = (layer.features[2].getGeometry() as Point).getCoordinates();
  expect(x).toBeCloseTo((136.9 * 20037508.342789244) / 180, -3);
  // The BLOB column nobody edited, and the spatial index kept right by its triggers.
  expect(layer.features[0].get('PIC')).toEqual(new Uint8Array([1, 2]));
  expect(sqlRows(layer.gpkg!.db, 'SELECT id FROM rtree_stations_geom ORDER BY id')).toEqual([{ id: 1 }, { id: 2 }, { id: 4 }]);
  expect(errors).toEqual([]);
});

test('a Shapefile chosen as separate files is saved as a .zip, attributes in UTF-8', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await open(page);
  await choose(page, [
    { name: 'sites.shp', bytes: shp([[139.7, 35.7], [135.5, 34.7]]) },
    { name: 'sites.dbf', bytes: dbf([{ name: 'NAME', length: 10 }, { name: 'POP', type: 'N', length: 8 }], [[tokyoSjis, ascii('100')], [ascii('Osaka'), ascii('20')]]) },
  ]);
  await expect(page.locator('#info')).toContainText('UTF-8（.cpg 付き）');
  await page.locator('#images li').getByRole('button', { name: '編集' }).click();
  await rows(page).nth(1).getByRole('textbox', { name: 'NAME' }).fill('大阪');
  await rows(page).nth(1).getByRole('textbox', { name: 'NAME' }).press('Enter');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存 (1)' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('sites.zip');
  const [layer] = await readVectorFiles([{ name: 'sites.zip', bytes: await bytesOf(file) }]);
  expect(layer.encoding).toBe('utf-8');
  expect(layer.features.map((f) => [f.get('NAME'), f.get('POP')])).toEqual([
    ['東京', 100],
    ['大阪', 20],
  ]);
  expect(errors).toEqual([]);
});

test('a GeoJSON picked with a handle is saved over the original file; any geometry type can be drawn', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.addInitScript(() => {
    (window as unknown as { showOpenFilePicker: () => Promise<FileSystemFileHandle[]> }).showOpenFilePicker = async () => {
      const root = await navigator.storage.getDirectory();
      return [await root.getFileHandle('roads.geojson')];
    };
  });
  await open(page);
  const geojson = JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[139, 35], [140, 36]] }, properties: { route: '国道1号', lanes: 4 } }],
  });
  await page.evaluate(async (text) => {
    const root = await navigator.storage.getDirectory();
    const writable = await (await root.getFileHandle('roads.geojson', { create: true })).createWritable();
    await writable.write(text);
    await writable.close();
  }, geojson);
  await page.locator('#open .ol-load-image button').first().click();
  await expect(page.locator('#status')).toContainText('roads を開きました');
  await page.locator('#images li').getByRole('button', { name: '編集' }).click();
  // GeoJSON holds any geometry: the toolbar asks which.
  await expect(page.locator('.edit-kind')).toBeVisible();
  await page.locator('.edit-kind').selectOption('Point');
  await page.getByRole('button', { name: '追加', exact: true }).click();
  const at = await pixelOf(page, 139.5, 35.5);
  await page.mouse.click(at.x, at.y);
  await rows(page).first().getByRole('textbox', { name: 'route' }).fill('起点');
  await rows(page).first().getByRole('textbox', { name: 'route' }).press('Enter');
  await page.getByRole('button', { name: '保存 (1)' }).click();
  await expect(page.locator('#status')).toContainText('元のファイルに上書きしました');
  const saved = await page.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('roads.geojson')).getFile()).text());
  const json = JSON.parse(saved);
  expect(json.features.map((f: { geometry: { type: string }; properties: { route: string } }) => [f.geometry.type, f.properties.route])).toEqual([
    ['LineString', '国道1号'],
    ['Point', '起点'],
  ]);
  expect(json.features[1].geometry.coordinates[0]).toBeCloseTo(139.5, 3);
  expect(errors).toEqual([]);
});
