import { expect, test, type Page } from '@playwright/test';
import { geodesicArea, geodesicInverse } from '../src/geodesic.js';
import type { LonLat } from '../src/coordinates.js';

/*
 * Drawing help while editing: typed coordinates (latitude/longitude and
 * plane rectangular X/Y), lengths and bearings, rectangles and circles from
 * numbers, duplicating, moving and turning by numbers, parallel lines,
 * splitting and merging, undo and redo.
 */

async function open(page: Page, features: unknown[] = []) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  const text = JSON.stringify({ type: 'FeatureCollection', features });
  await page.evaluate((text) => {
    const list = new DataTransfer();
    list.items.add(new File([text], 'plan.geojson'));
    const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
    input.files = list.files;
    input.dispatchEvent(new Event('change'));
  }, text);
  await expect(page.locator('#status')).toContainText('plan を開きました');
  await page.locator('#images li').getByRole('button', { name: '編集' }).click();
  await expect(page.getByRole('toolbar', { name: '編集' })).toBeVisible();
}

/** The edited layer's features: geometry type and coordinates in longitude and latitude. */
async function shapes(page: Page): Promise<Array<{ type: string; coordinates: unknown; name?: string }>> {
  return page.evaluate(() =>
    window.viewer.editor
      .session()!
      .source.getFeatures()
      .map((f) => {
        const g = f.getGeometry()!.clone().transform('EPSG:3857', 'EPSG:4326') as unknown as { getType(): string; getCoordinates(): unknown };
        return { type: g.getType(), coordinates: g.getCoordinates(), name: f.get('name') };
      }),
  );
}

async function pixelOf(page: Page, lon: number, lat: number) {
  await page.waitForFunction(() => !window.viewer.map.getView().getAnimating());
  const [x, y] = await page.evaluate(([lon, lat]) => {
    const c = [(lon * 20037508.342789244) / 180, Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * 6378137];
    window.viewer.map.renderSync();
    return window.viewer.map.getPixelFromCoordinate(c);
  }, [lon, lat]);
  const box = (await page.locator('#map').boundingBox())!;
  return { x: box.x + x, y: box.y + y };
}

async function more(page: Page, item: string) {
  await page.getByRole('button', { name: 'その他 ▾' }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: item }).or(page.getByRole('menu').getByRole('menuitemcheckbox', { name: item })).click();
}

const panel = (page: Page) => page.locator('.edit-panel');

test('a line is drawn from a typed start, then lengths and bearings; undo and redo take it back and put it again', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await page.locator('.edit-kind').selectOption('LineString');
  await more(page, '数値入力');
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toContainText('数値入力: 線');
  await panel(page).getByRole('textbox', { name: '頂点（緯度経度・MGRS・UTM）' }).fill('35.681200, 139.767100');
  await panel(page).getByRole('textbox', { name: '頂点（緯度経度・MGRS・UTM）' }).press('Enter');
  await panel(page).getByRole('textbox', { name: '長さ' }).fill('1000');
  await panel(page).getByRole('textbox', { name: '方位' }).fill('90');
  await panel(page).getByRole('button', { name: 'つなぐ' }).click();
  await expect(panel(page).locator('.edit-readout')).toContainText('2 点');
  await panel(page).getByRole('textbox', { name: '長さ' }).fill('500');
  await panel(page).getByRole('textbox', { name: '方位' }).fill('0');
  await panel(page).getByRole('textbox', { name: '方位' }).press('Enter');
  await panel(page).getByRole('button', { name: '確定' }).click();

  const [line] = await shapes(page);
  expect(line.type).toBe('LineString');
  const [a, b, c] = line.coordinates as LonLat[];
  expect(line.coordinates).toHaveLength(3);
  expect(a[0]).toBeCloseTo(139.7671, 6);
  expect(a[1]).toBeCloseTo(35.6812, 6);
  expect(geodesicInverse(a, b).distance).toBeCloseTo(1000, 3);
  expect(geodesicInverse(a, b).bearing).toBeCloseTo(90, 4);
  expect(geodesicInverse(b, c).distance).toBeCloseTo(500, 3);
  expect(geodesicInverse(b, c).bearing).toBeCloseTo(0, 4);

  // Undo and redo, by the keys (not typed into a field). The panel puts the focus back in its first field
  // on a timer after 確定, so leave the fields after that timer has run.
  await expect(page.getByRole('button', { name: '元に戻す' })).toBeEnabled();
  await page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await shapes(page)).length).toBe(0);
  await page.keyboard.press('Control+y');
  await expect.poll(async () => (await shapes(page)).length).toBe(1);
  await page.getByRole('button', { name: '元に戻す' }).click();
  await page.getByRole('button', { name: 'やり直し' }).click();
  await expect.poll(async () => (await shapes(page)).length).toBe(1);
  expect(errors).toEqual([]);
});

test('a rectangle from a corner in plane rectangular X/Y and its sides, and a circle from its centre and radius', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await page.locator('.edit-kind').selectOption('Rectangle');
  await more(page, '数値入力');
  await panel(page).getByRole('combobox', { name: '角の座標系' }).selectOption('EPSG:6677');
  // Surveyors' order: X is north, Y east (zone IX's origin is 36°N 139°50′E).
  await panel(page).getByRole('textbox', { name: 'X（北）' }).fill('0, 0');
  await expect(panel(page).getByRole('textbox', { name: 'Y（東）' })).toHaveValue('0');
  await panel(page).getByRole('textbox', { name: '幅' }).fill('200');
  await panel(page).getByRole('textbox', { name: '高さ' }).fill('100');
  await panel(page).getByRole('button', { name: '作成' }).click();
  const [rect] = await shapes(page);
  expect(rect.type).toBe('Polygon');
  const ring = (rect.coordinates as LonLat[][])[0];
  expect(ring[0][0]).toBeCloseTo(139 + 50 / 60, 6);
  expect(ring[0][1]).toBeCloseTo(36, 6);
  expect(geodesicArea(ring.slice(0, -1)).area).toBeCloseTo(20_000, -1);

  await page.locator('.edit-kind').selectOption('Circle');
  await expect(panel(page)).toContainText('数値入力: 円');
  await panel(page).getByRole('combobox', { name: '中心の座標系' }).selectOption('auto');
  await panel(page).getByRole('textbox', { name: '中心（緯度経度・MGRS・UTM）' }).fill('35.0, 139.0');
  await panel(page).getByRole('textbox', { name: '半径' }).fill('300');
  await panel(page).getByRole('textbox', { name: '半径' }).press('Enter');
  const all = await shapes(page);
  expect(all).toHaveLength(2);
  const circle = (all[1].coordinates as LonLat[][])[0];
  for (const p of circle) expect(geodesicInverse([139, 35], p).distance).toBeCloseTo(300, 3);
  expect(geodesicArea(circle.slice(0, -1)).area).toBeCloseTo(Math.PI * 300 * 300, -3);
  expect(errors).toEqual([]);
});

test('a rectangle drawn with the mouse, and the corner clicked goes into the number panel', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.viewer.map.getView().fit([15_472_000, 4_163_000, 15_584_000, 4_300_000]));
  await page.locator('.edit-kind').selectOption('Rectangle');
  await more(page, '数値入力');
  const a = await pixelOf(page, 139.2, 35.2);
  const b = await pixelOf(page, 139.8, 35.6);
  await page.mouse.click(a.x, a.y);
  // The corner clicked is in the panel, for typing the sides instead.
  await expect(panel(page).getByRole('textbox', { name: '角（緯度経度・MGRS・UTM）' })).toHaveValue(/^35\.2\d*, 139\.2\d*$/);
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.click(b.x, b.y);
  const [rect] = await shapes(page);
  expect(rect.type).toBe('Polygon');
  expect((rect.coordinates as LonLat[][])[0]).toHaveLength(5);
});

test('selected features are duplicated, moved and turned by numbers, offset, split and merged', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await open(page, [
    {
      type: 'Feature',
      properties: { name: '区画' },
      geometry: { type: 'Polygon', coordinates: [[[139.0, 35.0], [139.01, 35.0], [139.01, 35.01], [139.0, 35.01], [139.0, 35.0]]] },
    },
  ]);
  const select = () => page.evaluate(() => window.viewer.selection.set(window.viewer.editor.session()!.source.getFeatures().slice(0, 1)));
  await select();

  // Duplicate: a copy with the attributes, selected.
  await more(page, '複製');
  let all = await shapes(page);
  expect(all).toHaveLength(2);
  expect(all[1].name).toBe('区画');
  expect(all[1].coordinates).toEqual(all[0].coordinates);

  // Move the copy 100 m east and 50 m north.
  await more(page, '移動…');
  await panel(page).getByRole('textbox', { name: '東へ' }).fill('100');
  await panel(page).getByRole('textbox', { name: '北へ' }).fill('50');
  await panel(page).getByRole('button', { name: 'ずらす' }).click();
  all = await shapes(page);
  const from = (all[0].coordinates as LonLat[][])[0][0];
  const to = (all[1].coordinates as LonLat[][])[0][0];
  const moved = geodesicInverse(from, to);
  expect(moved.distance).toBeCloseTo(Math.hypot(100, 50), -1);
  // To a coordinate: its middle lands there.
  await panel(page).getByRole('textbox', { name: '移動先（緯度経度・MGRS・UTM）' }).fill('35.1, 139.1');
  await panel(page).getByRole('button', { name: '中心をここへ' }).click();
  all = await shapes(page);
  const ring = (all[1].coordinates as LonLat[][])[0];
  expect((Math.min(...ring.map((p) => p[0])) + Math.max(...ring.map((p) => p[0]))) / 2).toBeCloseTo(139.1, 6);

  // Turn it 45° clockwise: the area stays.
  const beforeTurn = all[1].coordinates;
  await panel(page).getByRole('button', { name: '閉じる' }).click();
  await more(page, '回転…');
  await panel(page).getByRole('textbox', { name: '角度' }).fill('45');
  await panel(page).getByRole('button', { name: '回転' }).click();
  all = await shapes(page);
  const area = (c: unknown) => geodesicArea((c as LonLat[][])[0].slice(0, -1)).area;
  expect(area(all[1].coordinates) / area(beforeTurn)).toBeCloseTo(1, 3);
  expect((all[1].coordinates as LonLat[][])[0][0]).not.toEqual(ring[0]);
  // Undo takes the turn back, redo puts it again.
  await page.getByRole('button', { name: '元に戻す' }).click();
  expect((await shapes(page))[1].coordinates).toEqual(beforeTurn);
  await page.getByRole('button', { name: 'やり直し' }).click();
  expect((await shapes(page))[1].coordinates).toEqual(all[1].coordinates);

  // A parallel polygon 20 m outside the first.
  await select();
  await panel(page).getByRole('button', { name: '閉じる' }).click();
  await more(page, '平行線…');
  await panel(page).getByRole('textbox', { name: '距離' }).fill('20');
  await panel(page).getByRole('button', { name: '作成' }).click();
  all = await shapes(page);
  expect(all).toHaveLength(3);
  expect(area(all[2].coordinates)).toBeGreaterThan(area(all[0].coordinates));

  // Split the first along a line drawn across it, then merge the pieces back.
  await select();
  await page.evaluate(() => {
    const m = (lon: number, lat: number) => [(lon * 20037508.342789244) / 180, Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * 6378137];
    window.viewer.map.getView().fit([...m(138.99, 34.98), ...m(139.02, 35.03)]);
  });
  await more(page, '分割');
  const p = await pixelOf(page, 139.005, 34.99);
  const q = await pixelOf(page, 139.005, 35.02);
  await page.mouse.click(p.x, p.y);
  await page.mouse.dblclick(q.x, q.y);
  await expect(page.locator('#status')).toContainText('2 つに分割しました');
  expect(await shapes(page)).toHaveLength(4);
  // The pieces are selected, both with the attributes.
  const pieces = await page.evaluate(() =>
    window.viewer.selection.list().map((f) => ({
      name: f.get('name') as string,
      ring: (f.getGeometry()!.clone().transform('EPSG:3857', 'EPSG:4326') as unknown as { getCoordinates(): LonLat[][] }).getCoordinates(),
    })),
  );
  expect(pieces.map((p) => p.name)).toEqual(['区画', '区画']);
  const square = [[[139.0, 35.0], [139.01, 35.0], [139.01, 35.01], [139.0, 35.01], [139.0, 35.0]]];
  expect(area(pieces[0].ring) + area(pieces[1].ring)).toBeCloseTo(area(square), -1);
  expect(area(pieces[0].ring)).toBeCloseTo(area(square) / 2, -3);
  // The pieces are still selected: merged back into one polygon.
  await more(page, '結合');
  await expect(page.locator('#status')).toContainText('2 件を 1 つに結合しました');
  expect(await shapes(page)).toHaveLength(3);
  const merged = await page.evaluate(() => {
    const [f] = window.viewer.selection.list();
    const g = f.getGeometry()!.clone().transform('EPSG:3857', 'EPSG:4326') as unknown as { getType(): string; getCoordinates(): LonLat[][] };
    return { type: g.getType(), ring: g.getCoordinates() };
  });
  expect(merged.type).toBe('Polygon');
  expect(area(merged.ring)).toBeCloseTo(area(square), -1);
  expect(errors).toEqual([]);
});
