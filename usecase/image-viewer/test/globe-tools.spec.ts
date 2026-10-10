import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { boxBuilding, dbf, ascii, dted, multipatchShp, satelliteTiff, toBase64 } from './fixtures.js';

/*
 * The 3D view's tools: GeoTIFF DEMs as relief, measuring with a profile,
 * pictures, the viewshed with buildings in the way, 3D Tiles from a folder,
 * and its state in project files.
 */

async function open(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

async function choose(page: Page, files: Array<{ name: string; bytes: Uint8Array }>) {
  const sent = files.map((f) => ({ name: f.name, base64: toBase64(f.bytes) }));
  await page.evaluate((files) => {
    const list = new DataTransfer();
    for (const f of files) list.items.add(new File([Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))], f.name));
    const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
    input.files = list.files;
    input.dispatchEvent(new Event('change'));
  }, sent);
}

/** Resolves when the globe has loaded every tile in view (and stays so for a few seconds). */
async function settled(page: Page, what = '') {
  await page.waitForTimeout(1000);
  let quiet = 0;
  await expect
    .poll(
      async () => {
        const loaded = await page.evaluate(() => {
          const scene = window.viewer.globe.globe()?.widget.scene;
          return !!scene?.globe.tilesLoaded && (document.querySelector('.globe-loading') as HTMLElement).hidden;
        });
        quiet = loaded ? quiet + 1 : 0;
        return quiet >= 3;
      },
      { timeout: 240_000, intervals: [1000], message: `globe tiles loaded ${what}` },
    )
    .toBe(true);
}

/** A hill 1990 m high at (139.5°E, 35.5°N), as in globe.spec.ts. */
const hillHeight = (lon: number, lat: number) => Math.max(0, Math.round(1990 - Math.hypot(lon - 139.5, lat - 35.5) * 4000));

test('a GeoTIFF DEM raises the relief, and distances are measured in 3D with a profile', async ({ page }) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  // One band of heights in WGS 84: 0.002° pixels from (139.2°E, 35.8°N).
  const step = 0.002;
  await choose(page, [{ name: 'hill-dem.tif', bytes: satelliteTiff(300, 300, (x, y) => hillHeight(139.2 + (x + 0.5) * step, 35.8 - (y + 0.5) * step), undefined, { west: 139.2, north: 35.8, step }) }]);
  await expect.poll(() => page.evaluate(() => window.viewer.images.list().length)).toBe(1);
  await page.evaluate(() => window.viewer.images.select(window.viewer.images.list()[0]));
  // The 幾何補正 section offers it as elevation data.
  await page.evaluate(() => ((document.querySelector('[data-fold=geometry]') as HTMLDetailsElement | null)?.setAttribute('open', '')));
  await expect(page.locator('[data-action=use-dem]')).toBeVisible();
  await page.locator('[data-action=use-dem]').click();
  await expect.poll(() => page.evaluate(() => window.viewer.geometry.cells().map((c) => ({ level: c.level, width: c.width })))).toEqual([{ level: 'GeoTIFF', width: 300 }]);
  await expect(page.locator('#geometry')).toContainText('標高データ（GeoTIFF）');

  await page.locator('#globe-toggle').click();
  await expect(page.locator('#globe-section')).toContainText('標高データ: GeoTIFF（1 枚）');
  await page.evaluate(() => window.viewer.globe.globe()!.setCamera({ lon: 139.5, lat: 35.2, height: 20000, heading: 0, pitch: -35 }));
  await settled(page, 'with the GeoTIFF relief');
  expect(await page.evaluate(() => window.viewer.globe.globe()!.hasRelief())).toBe(true);

  // 「距離を測る」 (D) measures on the globe while 3D is open.
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('d');
  await expect(page.locator('#measure-distance')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#globe [name=measure-distance]')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.viewer.globe.globe()!.measureMode())).toBe('distance');
  // Across the hill, from the ground on either side (heights above the ellipsoid: about 37 m of geoid on top).
  await page.evaluate(
    ([a, b]) => {
      const globe = window.viewer.globe.globe()!;
      globe.measure.addPoint({ lon: 139.4, lat: 35.5, height: a + 37 });
      globe.measure.addPoint({ lon: 139.6, lat: 35.5, height: b + 37 });
      globe.measure.finish();
    },
    [hillHeight(139.4, 35.5), hillHeight(139.6, 35.5)],
  );
  await expect(page.locator('.globe-measure-lines')).toContainText('水平距離 18.');
  await expect(page.locator('.globe-measure-lines')).toContainText('見通し: 見えません');
  await expect(page.locator('.globe-profile svg.profile-chart')).toBeVisible();
  await expect(page.locator('.globe-profile .profile-sight.blocked')).toHaveCount(1);
  // The profile's top is the hill's.
  const top = await page.evaluate(() => Math.max(...window.viewer.globe.globe()!.measureResult()!.profile!.ground.map((s) => s.height)));
  expect(top).toBeGreaterThan(1900);
  const csv = page.waitForEvent('download');
  await page.locator('#globe [name=profile-csv]').click();
  expect((await csv).suggestedFilename()).toBe('profile.csv');
  // From high above both, it is seen.
  await page.evaluate(() => {
    const globe = window.viewer.globe.globe()!;
    globe.measure.addPoint({ lon: 139.45, lat: 35.5, height: 3000 });
    globe.measure.addPoint({ lon: 139.55, lat: 35.5, height: 3000 });
    globe.measure.finish();
  });
  await expect(page.locator('.globe-measure-lines')).toContainText('見通し: 始点から終点が見えます');
  await page.evaluate(() => window.viewer.globe.globe()!.setCamera({ lon: 139.5, lat: 35.3, height: 9000, heading: 0, pitch: -20 }));
  await settled(page, 'with the measurement');
  await page.screenshot({ path: 'test-results/globe-measure.png' });

  // Areas, horizontal.
  await page.keyboard.press('a');
  await expect(page.locator('#measure-area')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#measure-distance')).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(() => {
    const globe = window.viewer.globe.globe()!;
    for (const [lon, lat] of [
      [139.45, 35.45],
      [139.55, 35.45],
      [139.55, 35.55],
      [139.45, 35.55],
    ]) globe.measure.addPoint({ lon, lat, height: 1500 });
    globe.measure.finish();
  });
  await expect(page.locator('.globe-measure-lines')).toContainText(/面積 10\d\.\d km²（水平）/);
  await expect(page.locator('.globe-measure-lines')).toContainText('km²（水平）');
  await page.keyboard.press('Escape');
  await expect(page.locator('.globe-measure')).toBeHidden();

  // 「表示範囲を保存」 saves a picture of the 3D view.
  const picture = page.waitForEvent('download');
  // In the ツール menu.
  await page.evaluate(() => document.getElementById('save-view')!.click());
  expect((await picture).suggestedFilename()).toMatch(/^3d-\d{8}-\d{6}\.png$/);
  expect(errors).toEqual([]);
});

test('the viewshed counts buildings and 3D Tiles from a folder, and project files keep the 3D view', async ({ page, request }) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  // Flat ground 100 m below sea level (so the cube of the tileset, standing on the ellipsoid, rises 60 m or so above it).
  await choose(page, [{ name: 'flat.dt2', bytes: dted({ west: 139.74, south: 35.67, spacing: [0.5, 0.5], size: 0.02, level: 'DTED2', elevation: () => -100 }) }]);
  await expect(page.locator('#status')).toContainText('flat.dt2 を標高データ（DTED2）として開きました');
  // A 60 m building west of the observer, which stands between it and the cube.
  const observer = { lon: 139.7488, lat: 35.68 };
  await choose(page, [
    { name: 'block.shp', bytes: multipatchShp([boxBuilding(139.7478, 35.6798, 0.0004, 0.0004, -100, -40)]) },
    { name: 'block.dbf', bytes: dbf([{ name: 'NAME', length: 8 }], [[ascii('block')]]) },
  ]);
  await page.locator('#globe-toggle').click();
  await expect(page.locator('#globe-section')).toContainText('block: 1 件');

  // 3D Tiles from a folder on the computer.
  const folder = join(mkdtempSync(join(tmpdir(), 'tiles-')), 'cube-city');
  mkdirSync(folder);
  for (const name of ['tileset.json', 'cube.glb']) writeFileSync(join(folder, name), await (await request.get(`/tiles/${name}`)).body());
  await page.locator('#globe [name=tiles-files]').setInputFiles(folder);
  await expect(page.locator('#status')).toContainText('3D タイルを追加しました: cube-city');
  await expect(page.locator('.globe-tilesets li')).toContainText('cube-city');
  await page.evaluate(({ lon, lat }) => window.viewer.globe.globe()!.setCamera({ lon, lat: lat - 0.003, height: 400, heading: 0, pitch: -35 }), observer);
  await settled(page, 'with the tiles and the building');
  await page.screenshot({ path: 'test-results/globe-folder-tiles.png' });

  const area = async () => Number(/見える範囲 ([\d.]+) km²/.exec((await page.locator('#status').textContent()) ?? '')?.[1]);
  await page.locator('#globe [name=radius]').fill('0.3');
  await page.locator('#globe [name=obstacles]').uncheck();
  await page.evaluate(({ lon, lat }) => window.viewer.globe.globe()!.runViewshed(lon, lat), observer);
  await expect(page.locator('#status')).toContainText('見える範囲');
  const bare = await area();
  expect(bare).toBeGreaterThan(0.27); // nearly the whole disc (0.283 km²) over flat ground
  await page.locator('#globe [name=obstacles]').check();
  await page.evaluate(({ lon, lat }) => window.viewer.globe.globe()!.runViewshed(lon, lat), observer);
  await expect(page.locator('#status')).toContainText('遮蔽物: マルチパッチ 1 件');
  await expect(page.locator('#status')).toContainText('3D タイル');
  const status = (await page.locator('#status').textContent())!;
  expect(Number(/、([\d,]+) 点が地面より高い/.exec(status)?.[1].replace(/,/g, ''))).toBeGreaterThan(0);
  const blocked = await area();
  // Both shadows: the building's to the west, the cube's to the east.
  expect(blocked).toBeLessThan(bare - 0.01);
  await settled(page, 'with the viewshed');
  await page.screenshot({ path: 'test-results/globe-viewshed-buildings.png' });

  // A project file keeps the 3D view (a folder's tiles are not kept: they need choosing again).
  const kept = await page.evaluate(() => window.viewer.project.collect().project.globe!);
  expect(kept.open).toBe(true);
  expect(kept.tilesets).toEqual([]);
  expect(kept.camera).toEqual(await page.evaluate(() => window.viewer.globe.globe()!.getCamera()));
  await page.locator('#globe-toggle').click();
  await expect(page.locator('#globe-section')).toBeHidden();
  const open3d = await page.evaluate(
    (state) => window.viewer.globe.restore({ ...state, exaggeration: 2, tilesets: [{ url: 'http://localhost:4175/tiles/tileset.json', show: false }] }),
    kept,
  );
  expect(open3d).toBe(true);
  await expect(page.locator('#globe-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.globe-tilesets li')).toHaveCount(1);
  expect(await page.locator('.globe-tilesets li input[type=checkbox]').isChecked()).toBe(false);
  await expect(page.locator('#globe [name=exaggeration]')).toHaveValue('2');
  const camera = await page.evaluate(() => window.viewer.globe.globe()!.getCamera());
  expect(camera.lat).toBeCloseTo(kept.camera.lat, 4);
  expect(camera.height).toBeCloseTo(kept.camera.height, -1);
  expect(errors).toEqual([]);
});

test('Esri multipatch layers stand as blocks, and scene services (I3S) open in 3D', async ({ page }) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  // A multipatch feature service: footprints in 2D, blocks of their height range in 3D.
  await page.getByRole('button', { name: 'サービスを追加' }).click();
  const dialog = page.getByRole('dialog', { name: 'サービスを追加' });
  await dialog.getByRole('textbox', { name: 'サービスの URL' }).fill('http://localhost:4175/svc/arcgis/rest/services/Town/FeatureServer');
  await dialog.getByRole('button', { name: '読み込む' }).click();
  await expect(dialog.locator('.service-layer')).toHaveCount(1);
  await dialog.locator('.service-layer input[type=checkbox]').first().check();
  await dialog.getByRole('button', { name: '追加', exact: true }).click();
  await expect(dialog).toBeHidden();
  const shapes = await page.evaluate(() => {
    const layer = window.viewer.images.layers().find((l) => l.name === '建物');
    if (layer?.type !== 'service') return null;
    return layer.service.vector!.source.getFeatures().map((f) => [f.get('NAME'), f.getGeometry()!.getType()]);
  });
  expect(shapes?.sort()).toEqual([
    ['タワー', 'Polygon'],
    ['ホール', 'Polygon'],
  ]);
  await page.locator('#globe-toggle').click();
  await expect(page.locator('#globe-section')).toContainText('建物: 2 件');

  // A scene service, by URL in the 3D section, lifted from the geoid onto the ellipsoid.
  await page.locator('#globe [name=url]').fill('http://localhost:4175/i3s/SceneServer');
  await page.locator('#globe .globe-tileset button').click();
  await expect(page.locator('#status')).toContainText('シーンサービスを追加しました: i3s');
  await expect(page.locator('.globe-tilesets li')).toContainText('i3s');
  await page.evaluate(() => window.viewer.globe.globe()!.setCamera({ lon: 139.757, lat: 35.677, height: 300, heading: 40, pitch: -20 }));
  await settled(page, 'with the blocks and the scene layer');
  await page.screenshot({ path: 'test-results/globe-esri.png' });
  // The blue cube of the scene layer is drawn, standing about 37 m of geoid above the ellipsoid.
  const blue = await page.evaluate(() => {
    const canvas = window.viewer.globe.globe()!.widget.scene.canvas;
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl'))!;
    const px = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let count = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i + 2] > px[i] + 60 && px[i + 2] > px[i + 1] + 30) count++;
    return count / (canvas.width * canvas.height);
  });
  expect(blue).toBeGreaterThan(0.005);
  const top = await page.evaluate(() => {
    const scene = window.viewer.globe.globe()!.widget.scene;
    return scene.sampleHeight({ longitude: (139.76 * Math.PI) / 180, latitude: (35.68 * Math.PI) / 180, height: 0 } as never);
  });
  expect(top).toBeGreaterThan(70);
  expect(top).toBeLessThan(85);
  expect(errors).toEqual([]);
});
