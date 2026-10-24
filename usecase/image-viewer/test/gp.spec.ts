import { expect, test, type Page } from '@playwright/test';

/*
 * 「サーバ処理」 against the stand-ins in test/gp-services.mjs: a synchronous
 * GP task sent a layer's features, an asynchronous one followed as a job (with
 * a token, messages and cancelling), and an OGC API – Processes job sent a
 * shape drawn on the map. Feature results open as temporary layers.
 */

const GP = 'http://localhost:4175/svc/gp/arcgis/rest/services/Tools/GPServer';
const OGC = 'http://localhost:4175/svc/gp/ogc/';

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

const points = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    [139.70, 35.68, '新宿'],
    [139.77, 35.68, '東京'],
  ].map(([lon, lat, name]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { name } })),
});

const dialog = (page: Page) => page.getByRole('dialog', { name: 'サーバ処理' });
const layerRows = (page: Page) => page.locator('#images li');

async function openDialog(page: Page) {
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.getByRole('button', { name: 'サーバ処理…' }).click();
  await expect(dialog(page)).toBeVisible();
}

test('runs GP tasks (sync and as jobs) and OGC processes, opening their results as layers', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await choose(page, 'stations.geojson', points);
  await expect(page.locator('#status')).toContainText('stations を表示');

  // The GPServer: its tasks, the first one's form.
  await openDialog(page);
  const d = dialog(page);
  await d.getByLabel('処理サービスの URL').fill(GP);
  await d.getByRole('button', { name: '読み込み' }).click();
  await expect(d.getByRole('status')).toContainText('「バッファ」: 入力 3 件（うち任意 1 件は「詳細」）');
  await expect(d.getByLabel('処理', { exact: true }).locator('option')).toHaveText(['バッファ（Buffer）', 'Slow']);
  await expect(d.getByLabel('距離', { exact: true })).toHaveValue('100');
  // The optional one is folded under 「詳細」.
  await expect(d.getByLabel('形', { exact: true })).toBeHidden();
  await d.locator('summary', { hasText: '詳細' }).click();
  await expect(d.getByLabel('形', { exact: true })).toHaveValue('square');

  // Synchronous: the layer's points sent, squares back as a temporary layer.
  await d.getByLabel('入力', { exact: true }).selectOption({ label: 'stations' });
  await d.getByLabel('距離', { exact: true }).fill('1');
  await d.getByLabel('距離の単位').selectOption('esriKilometers');
  await d.getByRole('button', { name: '実行' }).click();
  await expect(d.getByRole('status')).toContainText('「バッファ」を実行（1 件をレイヤーに追加）');
  const results = d.getByLabel('処理の結果');
  await expect(results).toContainText('件数: 2');
  await expect(results).toContainText('一時レイヤー「バッファ バッファ結果」（2 件）');
  await expect(results).toContainText('メッセージ（1 件）');
  await expect(layerRows(page).first()).toContainText('バッファ バッファ結果');
  const squares = await page.evaluate(() => {
    const layer = window.viewer.images.layers().find((l) => l.type === 'service' && l.service.title === 'バッファ バッファ結果');
    if (layer?.type !== 'service') return null;
    const f = layer.service.vector!.source.getFeatures().find((x) => x.get('name') === '東京')!;
    const [minX, , maxX] = f.getGeometry()!.getExtent();
    return { width: maxX - minX, dist: f.get('BUFF_DIST'), fields: layer.service.vector!.fields.map((x) => x.alias) };
  });
  expect(squares).toEqual({ width: 2000, dist: 1000, fields: ['名前', 'BUFF_DIST'] });

  // Asynchronous, secured: refused without the token, then a job with its messages.
  await d.getByLabel('処理', { exact: true }).selectOption({ label: 'Slow' });
  await expect(d.getByRole('status')).toContainText('「時間のかかる処理」（ジョブで実行）');
  await d.getByRole('button', { name: '実行' }).click();
  await expect(d.getByRole('status')).toContainText('「名前」を入力');
  await d.getByLabel('名前', { exact: true }).fill('皇居');
  await d.getByRole('button', { name: '実行' }).click();
  await expect(d.getByRole('status')).toContainText('このサービスにはトークンが必要');
  await d.getByLabel('トークン', { exact: true }).fill('secret');
  await d.getByRole('button', { name: '実行' }).click();
  await expect(d.getByRole('status')).toContainText(/ジョブ (待機中|実行中)/);
  await expect(d.getByRole('button', { name: '取り消し' })).toBeVisible();
  await expect(d.getByRole('status')).toContainText('「時間のかかる処理」を実行', { timeout: 15_000 });
  await expect(results).toContainText('一時レイヤー「時間のかかる処理 地点」（1 件）');
  await expect(results.getByRole('link', { name: 'https://example.com/report.pdf' })).toHaveAttribute('rel', 'noopener noreferrer');
  // Reprojected from the result's WGS 84.
  const placed = await page.evaluate(() => {
    const layer = window.viewer.images.layers().find((l) => l.type === 'service' && l.service.title === '時間のかかる処理 地点');
    if (layer?.type !== 'service') return null;
    const f = layer.service.vector!.source.getFeatures()[0];
    const [x, y] = (f.getGeometry() as unknown as { getCoordinates(): number[] }).getCoordinates();
    return { x: Math.round(x), y: Math.round(y), name: f.get('NAME') };
  });
  // 139.76°E 35.68°N in Web Mercator.
  expect(placed).toEqual({ x: 15558012, y: 4256679, name: '皇居' });

  // A job that does not end, cancelled.
  await d.getByLabel('秒数', { exact: true }).fill('999');
  await d.getByRole('button', { name: '実行' }).click();
  await expect(d.getByRole('status')).toContainText('ジョブ');
  await d.getByRole('button', { name: '取り消し' }).click();
  await expect(d.getByRole('status')).toHaveText('取り消し');
  await expect(d.getByRole('button', { name: '取り消し' })).toBeHidden();

  // OGC API – Processes from its landing page: a polygon drawn on the map, run as a job.
  await d.getByLabel('処理サービスの URL').fill(OGC);
  await d.getByLabel('トークン', { exact: true }).fill('');
  await d.getByRole('button', { name: '読み込み' }).click();
  await expect(d.getByRole('status')).toContainText('「重心」（ジョブで実行）: 入力 2 件');
  await d.getByRole('button', { name: '地図に作図' }).click();
  await expect(d).toBeHidden();
  await expect(page.locator('#status')).toContainText('「図形」のポリゴンを地図に作図');
  const box = (await page.locator('#map').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.click(cx - 60, cy - 40);
  await page.mouse.click(cx + 60, cy - 40);
  await page.mouse.click(cx + 60, cy + 40);
  await page.mouse.dblclick(cx - 60, cy + 40);
  await expect(d).toBeVisible();
  await expect(d.getByLabel('図形', { exact: true }).locator('option:checked')).toHaveText('地図に描いた図形（1 個）');
  await d.getByLabel('ラベル', { exact: true }).selectOption('B');
  await d.getByRole('button', { name: '実行' }).click();
  await expect(d.getByRole('status')).toContainText('「重心」を実行（1 件をレイヤーに追加）', { timeout: 15_000 });
  await expect(results).toContainText('頂点数: 4');
  await expect(results).toContainText('一時レイヤー「重心 重心点」（1 件）');
  const centroid = await page.evaluate(() => {
    const layer = window.viewer.images.layers().find((l) => l.type === 'service' && l.service.title === '重心 重心点');
    if (layer?.type !== 'service') return null;
    const f = layer.service.vector!.source.getFeatures()[0];
    const center = window.viewer.map.getView().getCenter()!;
    const [x, y] = (f.getGeometry() as unknown as { getCoordinates(): number[] }).getCoordinates();
    const resolution = window.viewer.map.getView().getResolution()!;
    return { label: f.get('label'), dx: Math.abs(x - center[0]) / resolution, dy: Math.abs(y - center[1]) / resolution };
  });
  // The middle of the square drawn around the map's centre.
  expect(centroid?.label).toBe('B');
  expect(centroid!.dx).toBeLessThan(15);
  expect(centroid!.dy).toBeLessThan(15);
  expect(errors).toEqual([]);
});
