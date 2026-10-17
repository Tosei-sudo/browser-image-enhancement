import { expect, test, type Page } from '@playwright/test';
import { plainGeoTiff } from './fixtures.js';

/*
 * Rasters without a projection: placed by a world file (.pgw, .tfw) and a
 * .prj chosen with them, or from 「投影を設定」 (the ⌖ button of the layer):
 * a CRS and an extent, four corners (rotated), the image's own coordinates;
 * saved in projects and set again when they open.
 */

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  return errors;
}

/** Opens files made in the page: a 200 × 100 PNG named `png` when given, and text and TIFF files. */
async function openFiles(page: Page, files: { png?: string; texts?: Record<string, string>; tiff?: { name: string; bytes: Uint8Array } }): Promise<void> {
  await page.evaluate(
    async ({ png, texts, tiff }) => {
      const list: File[] = [];
      if (png) {
        const canvas = new OffscreenCanvas(200, 100);
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#c03030';
        ctx.fillRect(0, 0, 200, 100);
        ctx.fillStyle = '#30c030';
        ctx.fillRect(0, 0, 100, 50);
        list.push(new File([await canvas.convertToBlob({ type: 'image/png' })], png, { type: 'image/png' }));
      }
      for (const [name, text] of Object.entries(texts ?? {})) list.push(new File([text], name));
      if (tiff) list.push(new File([new Uint8Array(tiff.bytes)], tiff.name, { type: 'image/tiff' }));
      await window.viewer.project.openFiles(list);
    },
    { png: files.png, texts: files.texts, tiff: files.tiff ? { name: files.tiff.name, bytes: Array.from(files.tiff.bytes) as unknown as Uint8Array } : undefined },
  );
}

/** The first image's kind, and its projection and extent (in that projection). */
function placed(page: Page) {
  return page.evaluate(async () => {
    const image = window.viewer.images.list()[0];
    const view = await image.source.getView();
    const projection = image.source.getProjection()!;
    return { kind: image.kind, code: projection.getCode(), extent: view.extent as number[] };
  });
}

const zone9 =
  'PROJCS["JGD_2011_Japan_Zone_9",GEOGCS["GCS_JGD_2011",DATUM["D_JGD_2011",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",139.8333333333333],PARAMETER["Scale_Factor",0.9999],PARAMETER["Latitude_Of_Origin",36.0],UNIT["Meter",1.0]]';

test('a picture with its world file and .prj opens in place', async ({ page }) => {
  const errors = await open(page);
  // 0.5 m pixels near Tokyo Station in JGD2011 zone IX.
  await openFiles(page, { png: 'scan.png', texts: { 'scan.pgw': '0.5\n0\n0\n-0.5\n-5999.75\n-35000.25\n', 'scan.prj': zone9 } });
  await expect(page.locator('#status')).toContainText('scan.png を開きました');
  const got = await placed(page);
  expect(got.kind).toBe('geotiff');
  expect(got.code).toBe('EPSG:6677');
  expect(got.extent.map((v) => Math.round(v))).toEqual([-6000, -35050, -5900, -35000]);
  await expect(page.locator('#info')).toContainText('ワールドファイル（scan.pgw）・JGD2011 平面直角座標系 IX 系（EPSG:6677）');
  // Placed: the row offers no projection to set; the .prj opened no vector layer.
  await expect(page.locator('#images li')).toHaveCount(1);
  await expect(page.locator('#images button[data-action=georef]')).toBeHidden();
  expect(errors).toEqual([]);
});

test('a world file without a CRS asks for one, filled in', async ({ page }) => {
  const errors = await open(page);
  await openFiles(page, { png: 'map.png', texts: { 'map.pgw': '0.001\n0\n0\n-0.001\n139.0005\n35.9995\n' } });
  const dialog = page.locator('dialog.georef-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.georef-world')).toContainText('map.pgw: 左上 139, 36');
  // Longitude and latitude by the look of them.
  await expect(dialog.getByLabel('座標系', { exact: true })).toHaveValue('EPSG:4326');
  await dialog.getByRole('button', { name: '適用' }).click();
  await expect(dialog.locator('.processing-note')).toContainText('で配置しました');
  const got = await placed(page);
  expect(got.kind).toBe('geotiff');
  expect(got.code).toBe('EPSG:4326');
  [139, 35.9, 139.2, 36].forEach((v, i) => expect(got.extent[i]).toBeCloseTo(v, 9));
  expect(errors).toEqual([]);
});

test('a TIFF without georeferencing gets an extent from its ⌖ button, kept in the project', async ({ page }) => {
  const errors = await open(page);
  await openFiles(page, { tiff: { name: 'plain.tif', bytes: plainGeoTiff(300, 200, { geo: 'none' }) } });
  await expect(page.locator('#status')).toContainText('plain.tif には投影の情報がありません');
  let got = await placed(page);
  expect(got.kind).toBe('image');
  await expect(page.locator('#info')).toContainText('なし（レイヤーの ⌖ で設定）');

  await page.locator('#images button[data-action=georef]').click();
  const dialog = page.locator('dialog.georef-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('座標系', { exact: true }).fill('6677');
  await dialog.getByLabel('座標系', { exact: true }).press('Tab');
  await expect(dialog.locator('.georef-crs-note')).toContainText('JGD2011 平面直角座標系 IX 系（EPSG:6677）（単位: m）');
  await dialog.getByLabel('配置', { exact: true }).selectOption('extent');
  await dialog.getByLabel('左', { exact: true }).fill('-6000');
  await dialog.getByLabel('下', { exact: true }).fill('-35200');
  await dialog.getByLabel('右', { exact: true }).fill('-5700');
  await dialog.getByLabel('上', { exact: true }).fill('-35000');
  await dialog.getByRole('button', { name: '適用' }).click();
  await expect(dialog.locator('.processing-note')).toContainText('で配置しました');
  got = await placed(page);
  expect(got.kind).toBe('geotiff');
  expect(got.code).toBe('EPSG:6677');
  expect(got.extent).toEqual([-6000, -35200, -5700, -35000]);
  await expect(page.locator('#images button[data-action=georef]')).toBeHidden();
  await dialog.getByRole('button', { name: '閉じる' }).click();

  // Saved in the project, and set again when it opens.
  const saved = await page.evaluate(() => window.viewer.project.collect().project.layers[0].georef);
  expect(saved).toEqual({ crs: 'EPSG:6677', transform: [-6000, 1, 0, -35000, 0, -1], method: 'extent' });
  await page.evaluate(async () => {
    const { project } = window.viewer;
    await project.open(project.collect().project, 'test.ivproj');
  });
  got = await placed(page);
  expect(got.code).toBe('EPSG:6677');
  expect(got.extent).toEqual([-6000, -35200, -5700, -35000]);

  // 「投影を外す」 goes back to where pictures go.
  await page.evaluate(() => window.viewer.georef.open());
  await dialog.getByRole('button', { name: '投影を外す' }).click();
  await expect(dialog.locator('.processing-note')).toHaveText('投影を外しました');
  expect((await placed(page)).kind).toBe('image');
  expect(errors).toEqual([]);
});

test('coordinates in no CRS are kept, and four corners place a rotated image', async ({ page }) => {
  const errors = await open(page);
  await openFiles(page, { tiff: { name: 'nocrs.tif', bytes: plainGeoTiff(300, 200, { geo: 'no-crs' }) } });
  await expect(page.locator('#status')).toContainText('nocrs.tif には投影の情報がありません');
  await page.locator('#images button[data-action=georef]').click();
  const dialog = page.locator('dialog.georef-dialog');
  // Its own coordinates are offered first.
  await expect(dialog.getByLabel('配置', { exact: true })).toHaveValue('keep');
  await expect(dialog.locator('.georef-own')).toContainText('画像の左上 500000, 4000000、画素の大きさ 10 × 10');
  await dialog.getByLabel('座標系', { exact: true }).fill('EPSG:32654');
  await dialog.getByRole('button', { name: '適用' }).click();
  await expect(dialog.locator('.processing-note')).toContainText('で配置しました');
  let got = await placed(page);
  expect(got.code).toBe('EPSG:32654');
  expect(got.extent).toEqual([500000, 3998000, 503000, 4000000]);

  // Turned 30°: drawn through the corners' affine transform.
  await dialog.getByLabel('配置', { exact: true }).selectOption('corners');
  const c = Math.cos(Math.PI / 6);
  const s = Math.sin(Math.PI / 6);
  const corner = (x: number, y: number) => [500000 + 10 * (x * c - y * s), 4000000 - 10 * (x * s + y * c)];
  for (const [name, [x, y]] of [['左上', [0, 0]], ['右上', [300, 0]], ['右下', [300, 200]], ['左下', [0, 200]]] as const) {
    const [cx, cy] = corner(x, y);
    await dialog.getByLabel(`${name} X`).fill(String(cx));
    await dialog.getByLabel(`${name} Y`).fill(String(cy));
  }
  await dialog.getByRole('button', { name: '適用' }).click();
  await expect(dialog.locator('.processing-note')).toContainText('で配置しました');
  got = await placed(page);
  expect(got.code).toMatch(/^SENSOR:/);
  await dialog.getByRole('button', { name: '閉じる' }).click();
  await expect(page.locator('#info')).toContainText('アフィン変換（回転あり）');
  await expect(page.locator('#info')).toContainText('四隅の座標・WGS 84 UTM 54N（EPSG:32654）');
  expect(errors).toEqual([]);
});
