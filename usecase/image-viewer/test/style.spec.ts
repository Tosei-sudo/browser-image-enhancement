import { expect, test, type Page } from '@playwright/test';
import { iter } from 'but-unzip';

/*
 * Symbols and labels of vector layers: the style dialog changes the map as
 * it is edited, OK keeps the style (it is there again when the file is
 * opened again), Cancel goes back.
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

const square = (x: number, y: number, d = 0.01) => [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]];
const landuse = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: square(139.7, 35.68) }, properties: { name: '中央公園', use: '公園' } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: square(139.71, 35.68) }, properties: { name: '駅前', use: '商業' } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: square(139.7, 35.69) }, properties: { name: '北町', use: '住宅' } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: square(139.71, 35.69) }, properties: { name: '東町', use: '住宅' } },
  ],
});

/** The style of the layer on top, and what its style function draws for its first feature. */
const drawn = (page: Page) =>
  page.evaluate(() => {
    const service = (window.viewer.images.layers()[0] as { service: import('../src/services/index.js').ServiceLayer }).service;
    const layer = service.layer as import('ol/layer/Vector.js').default;
    const feature = service.vector!.source.getFeatures().find((f) => f.get('name') === '駅前')!;
    const out = (layer.getStyleFunction()!(feature, 1) ?? []) as import('ol/style/Style.js').default | import('ol/style/Style.js').default[];
    const styles = Array.isArray(out) ? out : [out];
    return {
      spec: service.style!.get(),
      fill: styles[0]?.getFill()?.getColor(),
      label: styles[1]?.getText()?.getText(),
    };
  });

test('a vector layer is colored by an attribute and labelled, and keeps its style when opened again', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await choose(page, 'landuse.geojson', landuse);
  await expect(page.locator('#status')).toContainText('landuse を開きました');

  await page.locator('#images li').first().getByRole('button', { name: 'スタイル・ラベル' }).click();
  const dialog = page.getByRole('dialog', { name: 'スタイル: landuse' });
  await expect(dialog).toBeVisible();
  // Files have no style of their own to go back to.
  await expect(dialog.locator('option[value=own]')).toBeHidden();
  await dialog.getByLabel('表示方法').selectOption('categorized');
  await dialog.getByLabel('色分けする属性').selectOption('use');
  await expect(dialog.locator('.style-category')).toHaveCount(4); // 3 values and 「その他」
  await expect(dialog.locator('.style-category').filter({ hasText: '住宅' })).toContainText('2');
  await dialog.getByLabel('商業 の色').fill('#ff8800');
  await dialog.getByLabel('ラベルにする属性').selectOption('name');
  await dialog.getByLabel('文字の大きさ').fill('16');
  // The map follows before OK.
  await expect.poll(async () => (await drawn(page)).label).toBe('駅前');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();

  let now = await drawn(page);
  expect(now.spec.mode).toBe('categorized');
  expect(now.fill).toEqual([255, 136, 0, 0.25]);
  expect(now.spec.label).toMatchObject({ field: 'name', size: 16 });

  // Cancel goes back to the style kept.
  await page.locator('#images li').first().getByRole('button', { name: 'スタイル・ラベル' }).click();
  await dialog.getByLabel('表示方法').selectOption('single');
  await dialog.getByLabel('ラベルにする属性').selectOption('');
  expect((await drawn(page)).label).toBeUndefined();
  await dialog.getByRole('button', { name: 'キャンセル' }).click();
  now = await drawn(page);
  expect(now.spec.mode).toBe('categorized');
  expect(now.label).toBe('駅前');

  // The same file, opened again after a reload, looks the same.
  await open(page);
  await choose(page, 'landuse.geojson', landuse);
  await expect(page.locator('#status')).toContainText('landuse を開きました');
  now = await drawn(page);
  expect(now.spec.mode).toBe('categorized');
  expect(now.fill).toEqual([255, 136, 0, 0.25]);
  expect(now.label).toBe('駅前');

  // 初期設定に戻す: one symbol again, no labels.
  await page.locator('#images li').first().getByRole('button', { name: 'スタイル・ラベル' }).click();
  await dialog.getByRole('button', { name: '初期設定に戻す' }).click();
  await dialog.getByRole('button', { name: 'OK' }).click();
  now = await drawn(page);
  expect(now.spec.mode).toBe('single');
  expect(now.label).toBeUndefined();
  expect(errors).toEqual([]);
});

/** Chooses files given as bytes (base64), as if picked in the file chooser. */
async function chooseFiles(page: Page, files: Array<{ name: string; bytes: Uint8Array }>) {
  await page.evaluate(
    (files) => {
      const list = new DataTransfer();
      for (const f of files) list.items.add(new File([Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))], f.name));
      const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
      input.files = list.files;
      input.dispatchEvent(new Event('change'));
    },
    files.map((f) => ({ name: f.name, data: Buffer.from(f.bytes).toString('base64') })),
  );
}

async function downloaded(download: import('@playwright/test').Download): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

const towns = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    [139.7, 35.68, '大手町', 120],
    [139.71, 35.68, '丸の内', 80],
    [139.7, 35.69, '神田', 30],
    [139.71, 35.69, '九段', 10],
    [139.72, 35.69, '番町', null],
  ].map(([x, y, name, pop]) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: square(x as number, y as number) }, properties: { name, pop } })),
});

/** The style of the layer on top, its scale range, and the fill of each named feature. */
const graduated = (page: Page) =>
  page.evaluate(() => {
    const service = (window.viewer.images.layers()[0] as { service: import('../src/services/index.js').ServiceLayer }).service;
    const layer = service.layer as import('ol/layer/Vector.js').default;
    const fills: Record<string, unknown> = {};
    for (const f of service.vector!.source.getFeatures()) {
      const out = layer.getStyleFunction()!(f, 1);
      const s = Array.isArray(out) ? out[0] : out;
      fills[f.get('name') as string] = s ? s.getFill()?.getColor() : null;
    }
    return { spec: service.style!.get(), maxResolution: layer.getMaxResolution(), fills };
  });

test('a layer is colored in ranges of a number, shown only at some scales, and keeps its style in the files it is written to', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await choose(page, 'towns.geojson', towns);
  await expect(page.locator('#status')).toContainText('towns を開きました');

  const row = page.locator('#images li').first();
  await row.getByRole('button', { name: 'スタイル・ラベル' }).click();
  const dialog = page.getByRole('dialog', { name: 'スタイル: towns' });
  await dialog.getByLabel('表示方法').selectOption('graduated');
  // Only number attributes are offered.
  await expect(dialog.getByLabel('段階に分ける属性').locator('option')).toHaveText(['pop']);
  await dialog.getByLabel('分け方').selectOption('equal');
  await dialog.getByLabel('段階の数').fill('2');
  const ranges = dialog.locator('.style-classes .style-category');
  await expect(ranges).toHaveCount(3); // 2 ranges and 「値なし・範囲外」
  await expect(ranges.nth(0)).toContainText('10 –');
  await expect(ranges.nth(2)).toContainText('値なし・範囲外');
  await expect(ranges.nth(2).locator('.style-count')).toHaveText('1');
  // The bound between the ranges can be moved.
  await dialog.getByLabel('1 段目の上限').fill('50');
  await dialog.getByLabel('1 段目の上限').dispatchEvent('change');
  await expect(ranges.nth(0).locator('.style-count')).toHaveText('2');
  // Scales are folded away until wanted.
  await expect(dialog.getByLabel('縮小したら隠す縮尺')).toBeHidden();
  await dialog.getByText('縮尺で表示を切り替える').scrollIntoViewIfNeeded();
  await dialog.getByText('縮尺で表示を切り替える').click();
  await expect(dialog.locator('.style-now')).toContainText('いまの縮尺はおよそ 1 :');
  await dialog.getByLabel('縮小したら隠す縮尺').fill('200000');
  await dialog.getByRole('button', { name: 'OK' }).click();

  let now = await graduated(page);
  expect(now.spec.mode).toBe('graduated');
  expect(now.spec.classes.map((c) => [c.min, c.max])).toEqual([
    [10, 50],
    [50, 120],
  ]);
  expect(now.fills['九段']).toEqual(now.fills['神田']);
  expect(now.fills['大手町']).not.toEqual(now.fills['神田']);
  expect(now.spec.minScale).toBe(200000);
  // 1:200,000 at 35.7°N: 56 m on the ground per pixel, 69 m of Web Mercator.
  expect(now.maxResolution).toBeCloseTo(69, 0);
  // Zoomed out beyond it, the layer is dimmed in the list.
  await page.evaluate(() => window.viewer.map.getView().setResolution(500));
  await expect(row).toHaveClass(/out-of-scale/);
  await page.evaluate(() => window.viewer.map.getView().setResolution(10));
  await expect(row).not.toHaveClass(/out-of-scale/);

  // Written to a GeoPackage with its style, and read back from it (nothing kept in the browser).
  await row.getByRole('button', { name: '書き出し' }).click();
  const exportDialog = page.getByRole('dialog', { name: '書き出し' });
  await exportDialog.getByLabel('形式').selectOption('geopackage');
  await expect(exportDialog.getByText('スタイルも保存する')).toBeVisible();
  let downloading = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: '書き出す' }).click();
  const gpkg = await downloaded(await downloading);

  await row.getByRole('button', { name: '書き出し' }).click();
  await exportDialog.getByLabel('形式').selectOption('shapefile');
  downloading = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: '書き出す' }).click();
  const zip = await downloaded(await downloading);

  await page.evaluate(() => localStorage.clear());
  await open(page);
  await chooseFiles(page, [{ name: 'copy.gpkg', bytes: gpkg }]);
  await expect(page.locator('#status')).toContainText('copy を開きました');
  now = await graduated(page);
  expect(now.spec.mode).toBe('graduated');
  expect(now.spec.field).toBe('pop');
  expect(now.spec.classes.map((c) => [c.min, c.max])).toEqual([
    [10, 50],
    [50, 120],
  ]);
  expect(now.spec.minScale).toBe(200000);

  // The Shapefile has a .qml beside it, which QGIS (and the viewer) reads.
  const files: Array<{ name: string; bytes: Uint8Array }> = [];
  for (const entry of iter(zip)) files.push({ name: entry.filename, bytes: await entry.read() });
  expect(files.map((f) => f.name).sort()).toEqual(['towns.cpg', 'towns.dbf', 'towns.prj', 'towns.qml', 'towns.shp', 'towns.shx']);

  // A style QGIS made (no viewer settings in it): categories by name, labels, a scale range.
  const qgis = `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.28.0" hasScaleBasedVisibilityFlag="1" minScale="50000" maxScale="0" labelsEnabled="1">
  <renderer-v2 type="categorizedSymbol" attr="name">
    <categories>
      <category symbol="0" value="神田" label="神田" render="true"/>
      <category symbol="1" value="九段" label="九段" render="false"/>
    </categories>
    <symbols>
      <symbol type="fill" name="0" alpha="1"><layer class="SimpleFill"><Option type="Map"><Option name="color" value="255,0,0,255" type="QString"/><Option name="outline_color" value="0,0,0,255" type="QString"/><Option name="outline_width" value="0.26" type="QString"/><Option name="outline_width_unit" value="MM" type="QString"/></Option></layer></symbol>
      <symbol type="fill" name="1" alpha="1"><layer class="SimpleFill"><prop k="color" v="0,0,255,128"/></layer></symbol>
    </symbols>
  </renderer-v2>
  <labeling type="simple"><settings><text-style fieldName="name" fontSize="10" fontWeight="75" textColor="0,0,0,255"><text-buffer bufferDraw="1" bufferSize="1" bufferSizeUnits="MM" bufferColor="255,255,255,255"/></text-style></settings></labeling>
</qgis>`;
  await page.evaluate(() => localStorage.clear());
  await open(page);
  await chooseFiles(page, [...files.filter((f) => !f.name.endsWith('.qml')), { name: 'towns.qml', bytes: new TextEncoder().encode(qgis) }]);
  await expect(page.locator('#status')).toContainText('towns を開きました');
  now = await graduated(page);
  expect(now.spec.mode).toBe('categorized');
  expect(now.spec.field).toBe('name');
  expect(now.spec.categories).toEqual([
    { value: '神田', color: '#ff0000', visible: true },
    { value: '九段', color: '#0000ff', visible: false },
  ]);
  expect(now.spec.symbol.strokeWidth).toBeCloseTo(0.98, 1); // 0.26 mm
  expect(now.spec.minScale).toBe(50000);
  expect(now.spec.label).toMatchObject({ field: 'name', bold: true, size: 13, haloWidth: 7.5 });
  expect(now.fills['神田']).toEqual([255, 0, 0, 1]);
  expect(now.fills['九段']).toBeNull();
  expect(errors).toEqual([]);
});
