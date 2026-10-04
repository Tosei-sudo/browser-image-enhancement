import { expect, test, type Download, type Page } from '@playwright/test';

/*
 * The processing tools: results open as temporary layers, are kept in the
 * browser over a reload, can be exported, and are forgotten when closed.
 */

async function open(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

async function choose(page: Page, name: string, text: string) {
  await page.evaluate(
    ([name, text]) => {
      const list = new DataTransfer();
      list.items.add(new File([text], name));
      const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
      input.files = list.files;
      input.dispatchEvent(new Event('change'));
    },
    [name, text],
  );
}

async function textOf(download: Download): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** GPS fixes of two vehicles, out of order. */
const track = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    [139.70, 35.68, 'A', '2024-05-01T10:02:00Z'],
    [139.71, 35.69, 'A', '2024-05-01T10:01:00Z'],
    [139.72, 35.70, 'A', '2024-05-01T10:00:00Z'],
    [139.75, 35.66, 'B', '2024-05-01T10:00:00Z'],
    [139.76, 35.67, 'B', '2024-05-01T10:05:00Z'],
  ].map(([lon, lat, car, time]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { car, time } })),
});

const dialog = (page: Page) => page.getByRole('dialog', { name: 'プロセッシング' });
const layerRows = (page: Page) => page.locator('#images li');

async function runTool(page: Page, tool: string, fill?: () => Promise<void>) {
  await page.getByRole('button', { name: 'プロセッシング' }).click();
  await dialog(page).getByLabel('処理').selectOption({ label: tool });
  await dialog(page).getByLabel('入力レイヤー').selectOption({ label: 'track' });
  await fill?.();
  await dialog(page).getByRole('button', { name: '実行' }).click();
  await expect(dialog(page)).toBeHidden();
}

test('processing results are temporary layers, kept over a reload, exported, and forgotten when closed', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await open(page);
  await choose(page, 'track.geojson', track);
  await expect(page.locator('#status')).toContainText('track を開きました');

  // Points to lines: sorted by time, one per vehicle.
  await runTool(page, 'ポイント→ライン', async () => {
    await dialog(page).getByLabel('並べ替える属性（時刻など）').selectOption('time');
    await dialog(page).getByLabel('ラインを分ける属性').selectOption('car');
  });
  await expect(page.locator('#status')).toContainText('track_ライン を作成しました（2 件');
  await expect(layerRows(page).first()).toContainText('一時');
  const first = await page.evaluate(() => {
    const layer = window.viewer.images.selectedLayer();
    if (layer?.type !== 'service') return null;
    const line = layer.service.vector!.source.getFeatures().find((f) => f.get('car') === 'A')!;
    return { begin: line.get('begin'), points: line.get('points') };
  });
  expect(first).toEqual({ begin: '2024-05-01T10:00:00Z', points: 3 });

  // A geodesic buffer of 1 km around each point, dissolved.
  await runTool(page, '測地線バッファ', async () => {
    await dialog(page).getByLabel('距離').fill('1');
    await dialog(page).getByLabel('単位').selectOption('km');
    await dialog(page).getByText('結果を1つに融合').click();
  });
  await expect(page.locator('#status')).toContainText('track_バッファ を作成しました');

  // Voronoi cells and Thiessen polygons, and a reprojection to JGD2011 zone IX.
  await runTool(page, 'ボロノイ分割');
  await expect(page.locator('#status')).toContainText('track_ボロノイ を作成しました（5 件');
  await runTool(page, 'ティーセンポリゴン');
  await expect(page.locator('#status')).toContainText('track_ティーセン を作成しました（5 件');
  await runTool(page, 'ベクター投影変換', async () => {
    await dialog(page).getByLabel('変換先の座標系').selectOption('EPSG:6677');
  });
  await expect(page.locator('#status')).toContainText('を作成しました（5 件');
  const reprojected = await layerRows(page).first().locator('.name').textContent();

  // Exported in its CRS by default.
  await layerRows(page).first().getByRole('button', { name: /書き出し/ }).click();
  const exportDialog = page.getByRole('dialog', { name: '書き出し' });
  await expect(exportDialog.getByLabel('座標系').locator('option:checked')).toContainText('6677');
  const downloading = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: '書き出す' }).click();
  const geojson = JSON.parse(await textOf(await downloading));
  const [x, y] = geojson.features[0].geometry.coordinates;
  // Zone IX metres (origin 36°N 139°50′E), not degrees.
  expect(Math.abs(x)).toBeGreaterThan(1000);
  expect(Math.abs(y)).toBeGreaterThan(1000);
  expect(geojson.crs.properties.name).toContain('6677');

  // Kept over a reload (the file layer is not).
  await open(page);
  await expect(page.locator('#status')).toContainText('一時レイヤー 5 件を復元しました');
  await expect(layerRows(page)).toHaveCount(5);
  await expect(layerRows(page).first()).toContainText(reprojected!.replace(/^一時/, ''));

  // Closing one forgets it.
  await layerRows(page).first().getByRole('button', { name: '閉じる' }).click();
  await expect(layerRows(page)).toHaveCount(4);
  await open(page);
  await expect(page.locator('#status')).toContainText('一時レイヤー 4 件を復元しました');

  // An edit is saved in the browser.
  await layerRows(page).first().getByRole('button', { name: '編集' }).click();
  await page.locator('.attributes tbody tr[data-index]').first().getByRole('textbox', { name: 'car' }).fill('C');
  await page.locator('.attributes tbody tr[data-index]').first().getByRole('textbox', { name: 'car' }).press('Enter');
  await page.locator('button[data-tool=save]').click();
  await expect(page.locator('#status')).toContainText('ブラウザに保存しました');
  await open(page);
  await expect(page.locator('#status')).toContainText('復元しました');
  await expect(page.locator('.attributes tbody tr[data-index]').first()).toContainText('C');
  expect(errors).toEqual([]);
});

test('a CSV opens as a table, and points are made from its X / Y columns', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await choose(page, 'stations.csv', '﻿名前,経度,緯度,乗降客数\n東京,139.767125,35.681236,"462,589"\n大阪,135.4959,34.7024,\n不明,,,0\n');
  await expect(page.locator('#status')).toContainText('stations.csv を開きました（3 行');
  await expect(layerRows(page).first()).toContainText('CSV');
  // A table only: no export, its rows in the attribute table.
  await expect(layerRows(page).first().getByRole('button', { name: /書き出し/ })).toHaveCount(0);
  await expect(page.locator('.attributes tbody tr[data-index]')).toHaveCount(3);
  await expect(page.locator('.attributes tbody tr[data-index]').first()).toContainText('東京');

  // With the CSV selected, the dialog opens on the XY tool with the columns guessed.
  await page.getByRole('button', { name: 'プロセッシング' }).click();
  await expect(dialog(page).getByLabel('処理')).toHaveValue('xy');
  await expect(dialog(page).getByLabel('X（経度・東西）の列')).toHaveValue('経度');
  await expect(dialog(page).getByLabel('Y（緯度・南北）の列')).toHaveValue('緯度');
  await dialog(page).getByRole('button', { name: '実行' }).click();
  await expect(page.locator('#status')).toContainText('stations_ポイント を作成しました（2 件');
  await expect(page.locator('#status')).toContainText('数値でない行 1 件');
  const points = await page.evaluate(() => {
    const layer = window.viewer.images.selectedLayer();
    return layer?.type === 'service' ? layer.service.vector!.source.getFeatures().map((f) => [f.get('名前'), f.get('乗降客数'), f.getGeometry()?.getType()]) : null;
  });
  expect(points).toEqual([
    ['東京', '462,589', 'Point'],
    ['大阪', null, 'Point'],
  ]);
  expect(errors).toEqual([]);
});
