import { expect, test, type Page } from '@playwright/test';
import { fromArrayBuffer } from 'geotiff';
import { dted, rpcModel, satelliteTiff, toBase64 } from './fixtures.js';

/*
 * Geometric correction: DTED files open as elevation data, a satellite image
 * with an RPC model is orthorectified onto them, and the result can be moved
 * by hand and saved.
 */

async function open(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

/** Chooses files with the file chooser; bytes go to the page as base64 (DTED files are megabytes). */
async function choose(page: Page, files: Array<{ name: string; bytes: Uint8Array | string }>) {
  const sent = files.map((f) => (typeof f.bytes === 'string' ? { name: f.name, text: f.bytes } : { name: f.name, base64: toBase64(f.bytes) }));
  await page.evaluate((files) => {
    const list = new DataTransfer();
    for (const f of files) list.items.add(new File([f.text ?? Uint8Array.from(atob(f.base64!), (c) => c.charCodeAt(0))], f.name));
    const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
    input.files = list.files;
    input.dispatchEvent(new Event('change'));
  }, sent);
}

const names = (page: Page) => page.locator('#images .name').allTextContents();
const LON = 139.75;
const LAT = 35.65;
/** The bright spot of the scene, on a 1500 m plateau. */
const TARGET: [number, number] = [139.76, 35.64];

/** A 1000 × 1000 scene, dark with a bright spot where the satellite sees TARGET on the plateau (geoid there about 37 m). */
function scene(): Uint8Array {
  const model = rpcModel(LON, LAT);
  // Where TARGET is in the image, from the model with the height above the ellipsoid (the same equations as rpcModel).
  const h = 1500 + 37;
  const L = (TARGET[0] - model.lonOff) / model.lonScale;
  const P = (TARGET[1] - model.latOff) / model.latScale;
  const H = (h - model.heightOff) / model.heightScale;
  const s = Math.round(model.sampOff + model.sampScale * (L + 0.1 * H));
  const l = Math.round(model.lineOff + model.lineScale * (-P - 0.2 * H));
  return satelliteTiff(1000, 1000, (x, y) => (Math.abs(x - s) <= 2 && Math.abs(y - l) <= 2 ? 4000 : 300 + ((x >> 5) + (y >> 5)) % 2 * 200), model);
}

const plateau = () => dted({ west: 139, south: 35, spacing: [30, 30], level: 'DTED0', elevation: () => 1500 });

test('DTED level 0 to 2 open as elevation data', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await choose(page, [{ name: 'n35_e139.dt1', bytes: dted({ west: 139, south: 35, spacing: [3, 3], elevation: (lon, lat) => Math.round((lon - 139) * 2000 + (lat - 35) * 500) }) }]);
  await expect(page.locator('#status')).toContainText('n35_e139.dt1 を標高データ（DTED1）として開きました。標高 0〜2500 m');
  expect(await names(page)).toEqual(['DEMn35_e139.dt1']);
  await expect(page.locator('#info')).toContainText('DTED1（3″ 間隔）');
  await expect(page.locator('#info')).toContainText('0〜2500 m');
  await expect(page.locator('#info')).toContainText('EPSG:4326');
  await expect(page.locator('#geometry')).toContainText('標高データ: DTED1（1 枚）');
  // Placed on its cell.
  const extent = await page.evaluate(async () => (await window.viewer.images.list()[0].source.getView()).extent!);
  expect(extent[0]).toBeCloseTo(139 - 1.5 / 3600, 6);
  expect(extent[3]).toBeCloseTo(36 + 1.5 / 3600, 6);

  await choose(page, [{ name: 'e140/n35.dt0', bytes: dted({ west: 140, south: 35, spacing: [30, 30], elevation: () => 10 }) }]);
  await expect(page.locator('#status')).toContainText('標高データ（DTED0）として開きました');
  await expect(page.locator('#geometry')).toContainText('標高データ: DTED1、DTED0（2 枚）');
  // Closing a DEM stops using it.
  await page.locator('#images li').first().locator('[data-action=remove]').click();
  await expect(page.locator('#geometry')).toContainText('標高データ: DTED1（1 枚）');
  expect(errors).toEqual([]);
});

test('a DEM shows contour lines when asked, at the interval chosen', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  // A hill 1990 m high in the middle of the cell.
  const hill = dted({ west: 139, south: 35, spacing: [30, 30], level: 'DTED0', elevation: (lon, lat) => Math.max(0, Math.round(1990 - Math.hypot(lon - 139.5, lat - 35.5) * 4000)) });
  await choose(page, [{ name: 'hill.dt0', bytes: hill }]);
  await expect(page.locator('#status')).toContainText('hill.dt0 を標高データ（DTED0）として開きました');
  await page.evaluate(() => window.viewer.images.zoomTo(window.viewer.images.list()[0]));
  const levels = () =>
    page.evaluate(() => {
      const layer = window.viewer.map.getAllLayers().find((l) => l.get('contours'));
      const source = layer?.getSource() as { getFeatures(): Array<{ get(k: string): number }> } | undefined;
      return source ? [...new Set(source.getFeatures().map((f) => f.get('level')))].sort((a, b) => a - b) : null;
    });
  // Off at first.
  const check = page.locator('#geometry [data-action=contours]');
  await expect(check).not.toBeChecked();
  expect(await levels()).toBeNull();

  await check.check();
  const interval = page.locator('#geometry select[aria-label=等高線の間隔]');
  await expect(interval.locator('option:checked')).toHaveText('自動（100 m）');
  await expect.poll(levels).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900]);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/contours.png' });

  await interval.selectOption('500');
  await expect.poll(levels).toEqual([500, 1000, 1500]);

  // Hidden with the DEM, and gone when it closes.
  await page.locator('#images li').first().locator('input[type=checkbox]').uncheck();
  expect(await page.evaluate(() => window.viewer.map.getAllLayers().find((l) => l.get('contours'))!.getVisible())).toBe(false);
  await page.locator('#images li').first().locator('[data-action=remove]').click();
  expect(await levels()).toBeNull();
  expect(errors).toEqual([]);
});

test('a satellite image is orthorectified onto the DEM, moved by hand and saved', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await choose(page, [{ name: 'plateau.dt0', bytes: plateau() }]);
  await expect(page.locator('#status')).toContainText('標高データ（DTED0）として開きました');

  // A level-1 image: no georeferencing, placed by its RPC model.
  await choose(page, [{ name: 'scene.tif', bytes: scene() }]);
  await expect.poll(() => names(page)).toEqual(['RPCscene.tif', 'DEMplateau.dt0']);
  await expect(page.locator('#info')).toContainText('RPC');
  await expect(page.locator('#geometry')).toContainText('標高データ 1 枚の地形でオルソ補正します');
  const placed = await page.evaluate(async () => (await window.viewer.images.list()[0].source.getView()).extent!);
  expect(placed[0]).toBeCloseTo(139.7, 1);
  expect(placed[3]).toBeCloseTo(35.7, 1);

  await page.locator('#geometry [data-action=ortho]').click();
  await expect(page.locator('#status')).toContainText('scene_ortho.tif を作りました', { timeout: 30_000 });
  expect(await names(page)).toEqual(['オルソscene_ortho.tif', 'RPCscene.tif', 'DEMplateau.dt0']);
  await expect(page.locator('#info')).toContainText('scene.tif から');
  await expect(page.locator('#info')).toContainText('EPSG:3857');

  // The bright spot is where it is on the ground, within a pixel or so (about 11 m).
  const spot = await page.evaluate(() => {
    const { raster, geoTransform } = window.viewer.geometry.orthoOf(window.viewer.images.selected()!)!.result;
    // Center of the bright pixels.
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let i = 0; i < raster.data.length; i++) {
      if (raster.data[i] < 2000) continue;
      sx += i % raster.width;
      sy += Math.floor(i / raster.width);
      n++;
    }
    const x = geoTransform[0] + (sx / n + 0.5) * geoTransform[1];
    const y = geoTransform[3] + (sy / n + 0.5) * geoTransform[5];
    return [(x / 6378137) * (180 / Math.PI), (Math.atan(Math.exp(y / 6378137)) * 360) / Math.PI - 90];
  });
  expect(Math.abs(spot[0] - TARGET[0]) * 90_000).toBeLessThan(12);
  expect(Math.abs(spot[1] - TARGET[1]) * 111_000).toBeLessThan(12);

  // Move it: arrow keys (one screen pixel, Shift: ten) and dragging, while the map stays put.
  await page.locator('#geometry [data-action=shift]').click();
  await expect(page.locator('#geometry [data-action=shift]')).toHaveAttribute('aria-pressed', 'true');
  const resolution = await page.evaluate(() => window.viewer.map.getView().getResolution()!);
  const center = await page.evaluate(() => window.viewer.map.getView().getCenter()!);
  await page.locator('#map').click({ position: { x: 5, y: 5 } }); // focus the page, not a field
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('ArrowUp');
  /** How far the layer is from where it was made, in map units. */
  const offset = () =>
    page.evaluate(async () => {
      const image = window.viewer.images.selected()!;
      const now = (await image.source.getView()).extent!;
      const made = window.viewer.geometry.orthoOf(image)!.result.extent;
      return [now[0] - made[0], now[1] - made[1]];
    });
  let [dx, dy] = await offset();
  expect(dx).toBeCloseTo(10 * resolution, 6);
  expect(dy).toBeCloseTo(resolution, 6);

  const box = (await page.locator('#map').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 10, { steps: 4 });
  await page.mouse.up();
  [dx, dy] = await offset();
  expect(dx).toBeCloseTo(30 * resolution, 6);
  expect(dy).toBeCloseTo(-9 * resolution, 6);
  expect(await page.evaluate(() => window.viewer.map.getView().getCenter()!)).toEqual(center);
  // Shown in metres on the ground: Web Mercator units shrink by cos(latitude).
  const [east, north] = await page.evaluate(() => window.viewer.geometry.shiftMetres());
  expect(east / dx).toBeCloseTo(Math.cos((LAT * Math.PI) / 180), 2);
  expect(north / dy).toBeCloseTo(Math.cos((LAT * Math.PI) / 180), 2);
  await expect(page.locator('#geometry')).toContainText(`東 +${east.toFixed(1)} m、北 −${Math.abs(north).toFixed(1)} m`);
  const made = await page.evaluate(() => window.viewer.geometry.orthoOf(window.viewer.images.selected()!)!.result.extent);

  // Saved with the move.
  const download = page.waitForEvent('download');
  await page.locator('#geometry [data-action=save-ortho]').click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('scene_ortho.tif');
  const bytes = await (await import('node:fs/promises')).readFile((await file.path())!);
  const saved = await (await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))).getImage();
  expect(saved.getBitsPerSample()).toBe(16);
  expect(saved.getOrigin()[0] - made[0]).toBeCloseTo(dx, 3);
  expect(saved.getOrigin()[1] - made[3]).toBeCloseTo(dy, 3);

  // Back where it was made.
  await page.locator('#geometry [data-action=reset-shift]').click();
  expect(await page.evaluate(() => window.viewer.geometry.shiftMetres())).toEqual([0, 0]);
  await page.keyboard.press('Escape');
  await expect(page.locator('#geometry [data-action=shift]')).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test('an RPB file opened with the image gives its RPC model', async ({ page }) => {
  await open(page);
  const model = rpcModel(LON, LAT);
  const list = (c: number[]) => `(${c.join(', ')})`;
  const rpb = `BEGIN_GROUP = IMAGE
  lineOffset = ${model.lineOff};
  sampOffset = ${model.sampOff};
  latOffset = ${model.latOff};
  longOffset = ${model.lonOff};
  heightOffset = ${model.heightOff};
  lineScale = ${model.lineScale};
  sampScale = ${model.sampScale};
  latScale = ${model.latScale};
  longScale = ${model.lonScale};
  heightScale = ${model.heightScale};
  lineNumCoef = ${list(model.lineNum)};
  lineDenCoef = ${list(model.lineDen)};
  sampNumCoef = ${list(model.sampNum)};
  sampDenCoef = ${list(model.sampDen)};
END_GROUP = IMAGE
END;`;
  await choose(page, [
    { name: 'P001.TIF', bytes: satelliteTiff(1000, 1000, (x, y) => (x + y) % 4000) },
    { name: 'P001.RPB', bytes: rpb },
  ]);
  await expect.poll(() => names(page)).toEqual(['RPCP001.TIF']);
  await expect(page.locator('#geometry')).toContainText('この範囲の標高データ（DTED）がありません');
  await page.locator('#geometry [data-action=ortho]').click();
  await expect(page.locator('#status')).toContainText('P001_ortho.tif を作りました（標高データがないため RPC の基準高 500 m で補正）', { timeout: 30_000 });
});
