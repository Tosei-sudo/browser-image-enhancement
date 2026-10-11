import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Feature from 'ol/Feature.js';
import Polygon from 'ol/geom/Polygon.js';
import { fromLonLat } from 'ol/proj.js';
import { writeShapefile, zipFiles } from '../src/vector-write.js';

/*
 * Shapefiles too large for memory (`?shpstream=always` streams every one):
 * read a piece at a time into the browser, they show only what the view
 * holds, simplified when zoomed out, and features keep their object while
 * they stay in view, so the selection and the table follow them.
 */

/** A grid of `n` × `n` round polygons of `points` points around Tokyo, each named, written as files. */
function circles(n: number, points: number): string[] {
  const features: Feature[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const [cx, cy] = fromLonLat([139.5 + i * 0.01, 35.5 + j * 0.01]);
      const ring = Array.from({ length: points + 1 }, (_, k) => {
        const a = (-2 * Math.PI * k) / points;
        return [cx + 400 * Math.cos(a), cy + 400 * Math.sin(a)];
      });
      const f = new Feature(new Polygon([ring]));
      f.setProperties({ name: `円${i}-${j}`, row: i });
      features.push(f);
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'shp-'));
  const fields = [
    { name: 'name', alias: 'name', type: 'string' as const, editable: true, nullable: true },
    { name: 'row', alias: 'row', type: 'integer' as const, editable: true, nullable: true },
  ];
  return writeShapefile('circles', features, fields).map((f) => {
    const path = join(dir, f.name);
    writeFileSync(path, f.bytes);
    return path;
  });
}

async function open(page: Page) {
  await page.goto('/index.html?shpstream=always');
  await page.waitForFunction(() => window.viewer !== undefined);
}

/** Points of the features the layer holds now. */
const loadedPoints = (page: Page) =>
  page.evaluate(() => {
    const layer = window.viewer.images.layers()[0];
    if (layer.type !== 'service') return -1;
    return layer.service.vector!.source.getFeatures().reduce((n, f) => n + (f.getGeometry() as unknown as { getFlatCoordinates(): number[] }).getFlatCoordinates().length / 2, 0);
  });

const featureCount = (page: Page) =>
  page.evaluate(() => {
    const layer = window.viewer.images.layers()[0];
    return layer.type === 'service' ? layer.service.vector!.source.getFeatures().length : -1;
  });

test('a large Shapefile is read into the browser and shown a view at a time', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await page.setInputFiles('#open input[type=file]', circles(30, 400));
  await expect(page.locator('#status')).toContainText('circles を開きました（900 件。大容量のため');
  await expect(page.locator('#info')).toContainText('大容量・読み取り専用');
  await expect(page.locator('#info')).toContainText('360,900');
  // Read-only: no edit button.
  await expect(page.locator('#images li').first().locator('[data-action=edit]')).toHaveCount(0);

  // Fitted to the layer, every circle is there, but with far fewer points.
  await expect.poll(() => featureCount(page)).toBe(900);
  await expect.poll(() => loadedPoints(page)).toBeLessThan(100_000);
  await expect(page.locator('.table-count')).toContainText('全 900 件');
  await expect(page.locator('.table-count')).toContainText('表示範囲の地物のみ');
  await expect(page.locator('.attributes tbody tr[data-index]').first()).toContainText('円');

  // Zoomed in on one circle: only the circles near it, with every point.
  const center = await page.evaluate(() => {
    const layer = window.viewer.images.layers()[0];
    if (layer.type !== 'service') throw new Error('no layer');
    const f = layer.service.vector!.source.getFeatures().find((f) => f.get('name') === '円10-10')!;
    const [minX, minY, maxX, maxY] = f.getGeometry()!.getExtent();
    window.viewer.selection.set([f]);
    const view = window.viewer.map.getView();
    view.setCenter([(minX + maxX) / 2, (minY + maxY) / 2]);
    view.setResolution(0.02);
    return [(minX + maxX) / 2, (minY + maxY) / 2];
  });
  await expect.poll(() => featureCount(page)).toBeLessThan(30);
  const full = () =>
    page.evaluate(() => {
      const layer = window.viewer.images.layers()[0];
      if (layer.type !== 'service') return -1;
      const f = layer.service.vector!.source.getFeatures().find((f) => f.get('name') === '円10-10');
      return f ? (f.getGeometry() as unknown as { getFlatCoordinates(): number[] }).getFlatCoordinates().length / 2 : -1;
    });
  await expect.poll(full).toBeGreaterThan(300);
  // The selected feature is the one on the map (the same object), and stays so when the map moves a little.
  const same = () =>
    page.evaluate(() => {
      const layer = window.viewer.images.layers()[0];
      if (layer.type !== 'service') return false;
      const selected = window.viewer.selection.list()[0];
      return layer.service.vector!.source.getFeatures().includes(selected);
    });
  expect(await same()).toBe(true);
  await page.evaluate(([x, y]) => window.viewer.map.getView().setCenter([x + 300, y]), center);
  await page.waitForTimeout(500);
  expect(await same()).toBe(true);
  await expect(page.locator('.table-count')).toContainText('選択 1 件');

  // Closing the layer deletes the browser's copy.
  await page.evaluate(() => window.viewer.images.remove(window.viewer.images.layers()[0]));
  await expect
    .poll(() => page.evaluate(async () => (await indexedDB.databases()).filter((d) => d.name?.startsWith('image-viewer-shp-')).length))
    .toBe(0);
  expect(errors).toEqual([]);
});

test('a large Shapefile in a .zip is streamed from the .zip, without unpacking it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  const files = circles(5, 50).map((path) => ({ name: path.split('/').pop()!, bytes: readFileSync(path) }));
  const zipPath = join(mkdtempSync(join(tmpdir(), 'shpzip-')), 'circles.zip');
  writeFileSync(zipPath, zipFiles(files));
  await page.setInputFiles('#open input[type=file]', zipPath);
  await expect(page.locator('#status')).toContainText('circles を開きました（25 件。大容量のため');
  await expect.poll(() => featureCount(page)).toBe(25);
  await expect(page.locator('.attributes tbody tr[data-index]').first()).toContainText('円');
  expect(errors).toEqual([]);
});
