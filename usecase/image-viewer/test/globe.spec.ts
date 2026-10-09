import { expect, test, type Page } from '@playwright/test';
import { boxBuilding, dbf, ascii, dted, multipatchShp, toBase64 } from './fixtures.js';

/*
 * The 3D view: CesiumJS on the WGS 84 ellipsoid with the 2D layers draped
 * over DEM relief, multipatches as solids, and the viewshed.
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

const hill = () => dted({ west: 139, south: 35, spacing: [30, 30], level: 'DTED0', elevation: (lon, lat) => Math.max(0, Math.round(1990 - Math.hypot(lon - 139.5, lat - 35.5) * 4000)) });

test('the 3D view drapes the 2D layers over the DEM relief', async ({ page }) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await open(page);
  await choose(page, [{ name: 'hill.dt0', bytes: hill() }]);
  await expect(page.locator('#status')).toContainText('hill.dt0 を標高データ（DTED0）として開きました');
  await page.evaluate(() => window.viewer.images.zoomTo(window.viewer.images.list()[0]));
  await page.waitForTimeout(500);
  await page.locator('#globe-toggle').click();
  await expect(page.locator('#globe-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#globe-section')).toBeVisible();
  await expect(page.locator('#globe-section')).toContainText('標高データ: DTED0（1 枚）');
  await settled(page);
  await page.screenshot({ path: 'test-results/globe-top.png' });
  // Tilt to see the hill side on.
  await page.evaluate(() => window.viewer.globe.globe()!.setCamera({ lon: 139.5, lat: 35.25, height: 3000, heading: 0, pitch: -6 }));
  await settled(page);
  await page.screenshot({ path: 'test-results/globe-tilt.png' });
  expect(errors).toEqual([]);
});

/** Opens the hill DEM and the 3D view, looking at `place`. */
async function openGlobe(page: Page) {
  await open(page);
  await choose(page, [{ name: 'hill.dt0', bytes: hill() }]);
  await expect(page.locator('#status')).toContainText('hill.dt0 を標高データ（DTED0）として開きました');
  await page.locator('#globe-toggle').click();
  await expect(page.locator('#globe-section')).toBeVisible();
}

test('multipatch buildings stand on the relief and are picked like features', async ({ page }) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openGlobe(page);
  // Two buildings on the hill's flank, heights above mean sea level (the ground there is about 1000 m).
  const d = 0.0004;
  const ground = (lon: number, lat: number) => Math.max(0, Math.round(1990 - Math.hypot(lon - 139.5, lat - 35.5) * 4000));
  const shapes = [
    boxBuilding(139.5, 35.25, d, d, ground(139.5, 35.25), ground(139.5, 35.25) + 120),
    boxBuilding(139.502, 35.25, d, d * 2, ground(139.502, 35.25), ground(139.502, 35.25) + 60),
  ];
  await choose(page, [
    { name: 'buildings.shp', bytes: multipatchShp(shapes) },
    { name: 'buildings.dbf', bytes: dbf([{ name: 'NAME', length: 8 }], [[ascii('tower')], [ascii('hall')]]) },
  ]);
  await expect(page.locator('#globe-section')).toContainText('buildings: 2 件');
  await page.evaluate(() => window.viewer.globe.globe()!.setCamera({ lon: 139.501, lat: 35.2455, height: 1500, heading: 0, pitch: -30 }));
  await settled(page, 'with the buildings');
  await page.screenshot({ path: 'test-results/globe-buildings.png' });
  // A click on the tower selects it in the attribute table.
  const tower = await page.evaluate(() => {
    const globe = window.viewer.globe.globe()!;
    const canvas = globe.widget.scene.canvas;
    // Scan the middle row for the first pixel that picks a shape.
    for (let x = 0; x < canvas.clientWidth; x += 4) {
      for (let y = Math.round(canvas.clientHeight * 0.3); y < canvas.clientHeight * 0.7; y += 8) {
        const picked = globe.widget.scene.pick({ x, y } as never) as { id?: { feature?: { get(k: string): string } } } | undefined;
        if (picked?.id?.feature?.get('NAME') === 'tower') return [x, y];
      }
    }
    return null;
  });
  expect(tower).not.toBeNull();
  const box = (await page.locator('.globe canvas').boundingBox())!;
  await page.mouse.click(box.x + tower![0], box.y + tower![1]);
  await expect.poll(() => page.evaluate(() => window.viewer.selection.list().map((f) => f.get('NAME')))).toEqual(['tower']);
  await expect(page.locator('#table')).toContainText('tower');
  expect(errors).toEqual([]);
});

test('the viewshed from a clicked point shows on the globe and on the 2D map', async ({ page }) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openGlobe(page);
  await page.evaluate(() => window.viewer.globe.globe()!.setCamera({ lon: 139.5, lat: 35.2, height: 30000, heading: 0, pitch: -50 }));
  await settled(page, 'before the viewshed');
  await page.locator('#globe [name=radius]').fill('15');
  await page.locator('#globe [name=pick]').click();
  await expect(page.locator('#globe [name=pick]')).toHaveAttribute('aria-pressed', 'true');
  const box = (await page.locator('.globe canvas').boundingBox())!;
  const at = (await page.evaluate(([x, y]) => window.viewer.globe.globe()!.lonLatAt(x, y), [box.width / 2, box.height / 2]))!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('#status')).toContainText('見える範囲', { timeout: 120_000 });
  await expect(page.locator('#status')).toContainText(`観測点 ${at[1].toFixed(5)}, ${at[0].toFixed(5)}`);
  await expect(page.locator('#globe [name=pick]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#globe [name=clear]')).toBeEnabled();
  // The result is a layer of the 2D map, so it is draped in 3D and stays in 2D.
  expect(await page.evaluate(() => window.viewer.map.getLayers().getArray().some((l) => l.get('viewshed')))).toBe(true);
  await settled(page, 'with the viewshed');
  await page.screenshot({ path: 'test-results/globe-viewshed.png' });
  await page.locator('#globe-toggle').click();
  await expect(page.locator('#globe-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#globe-section')).toBeHidden();
  // Back in 2D where the camera looked, with the result.
  const center = await page.evaluate(() => window.viewer.map.getView().getCenter()!);
  expect(Math.abs(center[0] - (at[0] * Math.PI * 6378137) / 180)).toBeLessThan(2000);
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/viewshed-2d.png' });
  await page.locator('#globe-toggle').click();
  await page.locator('#globe [name=clear]').click();
  expect(await page.evaluate(() => window.viewer.map.getLayers().getArray().some((l) => l.get('viewshed')))).toBe(false);
  expect(errors).toEqual([]);
});

test('3D Tiles open by URL, and the 2D-only tools wait in 3D', async ({ page }) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await page.locator('#globe-toggle').click();
  await expect(page.locator('#globe-section')).toBeVisible();
  await expect(page.locator('#measure-distance')).toBeDisabled();
  await expect(page.locator('#save-view')).toBeDisabled();
  await page.locator('#globe [name=url]').fill('http://localhost:4175/tiles/tileset.json');
  await page.locator('#globe .globe-tileset button').click();
  await expect(page.locator('#status')).toContainText('3D タイルを追加しました');
  await expect(page.locator('.globe-tilesets li')).toHaveCount(1);
  await page.evaluate(() => window.viewer.globe.globe()!.setCamera({ lon: 139.75, lat: 35.678, height: 150, heading: 0, pitch: -30 }));
  await settled(page);
  await page.screenshot({ path: 'test-results/globe-tiles.png' });
  // The cube is drawn: red pixels in the view.
  const red = await page.evaluate(() => {
    const canvas = window.viewer.globe.globe()!.widget.scene.canvas;
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl'))!;
    const px = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let count = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > px[i + 1] + 30 && px[i] > px[i + 2] + 30) count++;
    return count / (canvas.width * canvas.height);
  });
  expect(red).toBeGreaterThan(0.02);
  await page.locator('.globe-tilesets li button[aria-label$=を閉じる]').click();
  await expect(page.locator('.globe-tilesets li')).toHaveCount(0);
  await page.locator('#globe-toggle').click();
  await expect(page.locator('#measure-distance')).toBeEnabled();
  expect(errors).toEqual([]);
});
