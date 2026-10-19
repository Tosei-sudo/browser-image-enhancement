import { expect, test, type Download, type Page } from '@playwright/test';
import { writeArrayBuffer } from 'geotiff';
import { toBase64 } from './fixtures.js';

/*
 * Scripts (ツール → スクリプト): JavaScript run apart from the page. It
 * cannot reach the network, the viewer's storage or the page; it reads and
 * edits layers through `viewer.*` (edits wait for 「保存」), makes layers and
 * rasters, plans imaging and exports files.
 */

async function open(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

async function choose(page: Page, name: string, bytes: Uint8Array | string) {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  await page.evaluate((f) => {
    const list = new DataTransfer();
    list.items.add(new File([Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))], f.name));
    const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
    input.files = list.files;
    input.dispatchEvent(new Event('change'));
  }, { name, base64: toBase64(data) });
  await expect(page.locator('#images .name', { hasText: name.replace(/\.[^.]+$/, '') })).not.toHaveCount(0);
}

async function textOf(download: Download): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'スクリプト' });

async function openScripts(page: Page) {
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.getByRole('button', { name: 'スクリプト…' }).click();
  await expect(dialog(page)).toBeVisible();
}

/** Types `code` into the editor, runs it and waits for the end; returns the status line. */
async function run(page: Page, code: string): Promise<string> {
  await dialog(page).getByLabel('スクリプト（JavaScript）').fill(code);
  await dialog(page).getByRole('button', { name: '実行' }).click();
  await expect(dialog(page).getByRole('button', { name: '実行' })).toBeEnabled({ timeout: 30_000 });
  return (await dialog(page).locator('.script-status').textContent()) ?? '';
}

const output = (page: Page) => dialog(page).locator('.script-output');

/** Three parcels (one with a hole-free 1 km × 1 km square) with a name and a note. */
const parcels = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    [139.70, 35.68, 'A'],
    [139.72, 35.68, 'B'],
    [139.74, 35.68, 'C'],
  ].map(([lon, lat, name]) => ({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[[lon, lat], [(lon as number) + 0.01, lat], [(lon as number) + 0.01, (lat as number) + 0.01], [lon, (lat as number) + 0.01], [lon, lat]]] },
    properties: { name, note: '' },
  })),
});

test('a script runs apart from the page: no network, no storage, no DOM, and it can be stopped', async ({ page }) => {
  // Answered by the test server (404) if a request ever got out: none may.
  const leaks: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/leak')) leaks.push(r.url());
  });
  const errors: string[] = [];
  // (Playwright's own script reads navigator.serviceWorker in every frame, which the sandbox refuses.)
  page.on('pageerror', (e) => {
    if (!e.message.includes("'serviceWorker'")) errors.push(e.message);
  });
  await open(page);
  await page.evaluate(() => localStorage.setItem('secret', 'token-123'));
  await openScripts(page);

  const status = await run(
    page,
    `const tries = {
  origin: () => self.origin,
  fetch: () => fetch('http://localhost:4175/leak-fetch'),
  fetchProto: () => WorkerGlobalScope.prototype.fetch.call(self, 'http://localhost:4175/leak-proto'),
  xhr: () => { const x = new XMLHttpRequest(); x.open('GET', 'http://localhost:4175/leak-xhr'); x.send(); return 'sent'; },
  socket: () => new WebSocket('ws://localhost:4175/leak-ws'),
  importScripts: () => importScripts('http://localhost:4175/leak-a.js'),
  dynamicImport: () => import('http://localhost:4175/leak-b.js'),
  indexedDB: () => indexedDB.open('image-viewer-temp'),
  document: () => document.title,
  parent: () => parent.document.title,
  localStorage: () => localStorage.getItem('secret'),
};
for (const [name, f] of Object.entries(tries)) {
  try {
    const v = await f();
    print(name, 'OK', String(v));
  } catch (e) {
    print(name, 'NG');
  }
}`,
  );
  expect(status).toContain('完了');
  const lines = (await output(page).textContent()) ?? '';
  expect(lines).toContain('origin OK null');
  for (const name of ['fetch', 'fetchProto', 'xhr', 'socket', 'importScripts', 'dynamicImport', 'indexedDB', 'document', 'parent', 'localStorage']) expect(lines).toContain(`${name} NG`);
  expect(lines).not.toContain('token-123');
  expect(leaks).toEqual([]);

  // A loop that never ends leaves the page working, and 「停止」 ends it.
  await dialog(page).getByLabel('スクリプト（JavaScript）').fill('print("start");\nwhile (true) {}');
  await dialog(page).getByRole('button', { name: '実行' }).click();
  await expect(output(page)).toContainText('start');
  expect(await page.evaluate(() => 1 + 1)).toBe(2);
  await dialog(page).getByRole('button', { name: '停止' }).click();
  await expect(dialog(page).locator('.script-status')).toContainText('停止しました');
  await expect(page.locator('iframe[sandbox]')).toHaveCount(0);

  // Errors point at the line of the script.
  expect(await run(page, 'print(1);\nconst x = ;')).toContain('エラー');
  await expect(output(page)).toContainText('行 2');
  await run(page, 'print(1);\n\nawait viewer.features("どこにもない");');
  await expect(output(page)).toContainText('レイヤー「どこにもない」が見つかりません（行 3');
  expect(errors).toEqual([]);
});

test('a script reads layers, makes a temporary layer, and its edits wait for 「保存」 as one undo step', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await open(page);
  await choose(page, 'parcels.geojson', parcels);
  await openScripts(page);

  // The area of each parcel, into a new temporary layer.
  await dialog(page).getByLabel('スクリプトを開く').selectOption({ label: '面積を計算して一時レイヤーに' });
  await dialog(page).getByRole('button', { name: '実行' }).click();
  await expect(dialog(page).locator('.script-status')).toContainText('完了');
  await expect(output(page)).toContainText('3 件の面積を計算しました');
  const areas = await page.evaluate(() => {
    const layer = window.viewer.images.layers().find((l) => l.name === 'parcels（面積）');
    return layer?.type === 'service' ? layer.service.vector!.source.getFeatures().map((f) => f.get('area_m2') as number) : null;
  });
  expect(areas).toHaveLength(3);
  // About 905 m × 1110 m at 35.68° N.
  for (const a of areas!) {
    expect(a).toBeGreaterThan(990_000);
    expect(a).toBeLessThan(1_020_000);
  }

  // Edits: an attribute changed, a parcel added, one deleted; nothing written until 「保存」.
  await page.evaluate(() => window.viewer.images.select(window.viewer.images.layers().find((l) => l.name === 'parcels')!));
  const status = await run(
    page,
    `const layer = (await viewer.layers()).find((l) => l.name === 'parcels');
const fc = await viewer.features(layer.id);
const a = fc.features.find((f) => f.properties.name === 'A');
const c = fc.features.find((f) => f.properties.name === 'C');
await viewer.updateFeatures(layer.id, [{ id: a.id, properties: { note: '確認済み' } }]);
const added = await viewer.addFeatures(layer.id, [{ type: 'Feature', geometry: await geo.buffer({ type: 'Point', coordinates: [139.8, 35.7] }, 100), properties: { name: 'D', unknown: 1 } }]);
print('ignored', added.ignored);
const r = await viewer.deleteFeatures(layer.id, [c.id]);
print('pending', r.pending);`,
  );
  expect(status).toContain('未保存の変更が 3 件あります（parcels）');
  await expect(output(page)).toContainText('ignored [\n  "unknown"\n]');
  await expect(page.locator('.edit-bar')).toBeVisible();
  const names = () =>
    page.evaluate(() => {
      const layer = window.viewer.images.layers().find((l) => l.name === 'parcels');
      return layer?.type === 'service'
        ? layer.service.vector!.source
            .getFeatures()
            .map((f) => `${f.get('name')}:${f.get('note')}`)
            .sort()
        : [];
    });
  expect(await names()).toEqual(['A:確認済み', 'B:', 'D:undefined']);
  // One 「元に戻す」 takes back the whole script.
  await page.locator('.edit-bar button[data-tool=undo]').click();
  expect(await names()).toEqual(['A:', 'B:', 'C:']);
  expect(await page.evaluate(() => window.viewer.editor.session()?.count())).toBe(0);

  // viewer.saveEdits() asks first; declined, nothing is written.
  const asked: string[] = [];
  page.removeAllListeners('dialog');
  let answer = false;
  page.on('dialog', (d) => {
    asked.push(d.message());
    void (answer ? d.accept() : d.dismiss());
  });
  const edit = `const fc = await viewer.features('parcels');\nawait viewer.updateFeatures('parcels', [{ id: fc.features[0].id, properties: { note: 'x' } }]);\nprint(JSON.stringify(await viewer.saveEdits()));`;
  await run(page, edit);
  expect(asked.pop()).toContain('スクリプトが「parcels」の未保存の変更 1 件を');
  await expect(output(page)).toContainText('保存は取り消されました');
  expect(await page.evaluate(() => window.viewer.editor.session()?.count())).toBe(1);
  // Accepted: saved (a file without a handle is saved as a download of the same name).
  answer = true;
  const saved = page.waitForEvent('download');
  await run(page, 'print(JSON.stringify(await viewer.saveEdits()));');
  expect((await saved).suggestedFilename()).toBe('parcels.geojson');
  await expect(output(page)).toContainText('{"saved":1,"failed":[]');
  expect(await page.evaluate(() => window.viewer.editor.session()?.count())).toBe(0);

  // A layer it cannot edit is refused.
  await run(page, `const t = (await viewer.layers()).find((l) => l.name === 'parcels（面積）');\nawait viewer.deleteFeatures(t.id, ['nope']);`);
  await expect(output(page)).toContainText('id「nope」の地物がありません');
});

test('the editor suggests functions and layer names', async ({ page }) => {
  await open(page);
  await choose(page, 'parcels.geojson', parcels);
  await openScripts(page);
  const editor = dialog(page).getByLabel('スクリプト（JavaScript）');
  const list = dialog(page).getByRole('listbox', { name: '候補' });
  await editor.fill('');
  await editor.pressSequentially('const fc = await viewer.fea');
  await expect(list).toBeVisible();
  await expect(list.getByRole('option').first()).toContainText('viewer.features(layer, { selected, bbox, limit, fields })');
  await editor.press('Enter');
  await expect(list).toBeHidden();
  await expect(editor).toHaveValue('const fc = await viewer.features(');
  await editor.pressSequentially("'par");
  await expect(list.getByRole('option')).toHaveText(['parcelsレイヤー']);
  await editor.press('Tab');
  await expect(editor).toHaveValue("const fc = await viewer.features('parcels");
  // geo. lists the geometry functions; Esc closes the list and keeps the panel.
  await editor.pressSequentially("');\nawait geo.");
  await expect(list.getByRole('option').first()).toContainText('geo.area(geometry)');
  await editor.press('Escape');
  await expect(list).toBeHidden();
  await expect(dialog(page)).toBeVisible();
});

test('the editor colours the script and keeps the colours on its text and scroll', async ({ page }) => {
  await open(page);
  await openScripts(page);
  const editor = dialog(page).getByLabel('スクリプト（JavaScript）');
  const colours = dialog(page).locator('.script-highlight');
  const code = `${"const n = await viewer.layers(); // 一覧\nprint('件数', n.length, 1 < 2);\n".repeat(40)}`;
  await editor.fill(code);
  // The coloured copy has the same text (plus the space that holds a last empty line) and the textarea's own text is transparent.
  expect(await colours.evaluate((el) => el.textContent)).toBe(`${code} `);
  await expect(colours.locator('.hl-keyword').first()).toHaveText('const');
  await expect(colours.locator('.hl-builtin').first()).toHaveText('viewer');
  await expect(colours.locator('.hl-comment').first()).toHaveText('// 一覧');
  expect(await editor.evaluate((el) => getComputedStyle(el).color)).toBe('rgba(0, 0, 0, 0)');
  const keyword = (scheme: 'light' | 'dark') =>
    page.emulateMedia({ colorScheme: scheme }).then(() => colours.locator('.hl-keyword').first().evaluate((el) => getComputedStyle(el).color));
  expect(await keyword('light')).not.toBe(await keyword('dark'));
  // Scrolling the editor scrolls the colours with it.
  await editor.evaluate((el) => {
    el.scrollTop = 200;
    el.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => colours.evaluate((el) => el.scrollTop)).toBe(await editor.evaluate((el) => el.scrollTop));
});

test('a script exports GeoJSON and CSV, plans imaging, and reads and makes rasters', async ({ page }) => {
  await open(page);
  await choose(page, 'parcels.geojson', parcels);
  await openScripts(page);

  // Exports, as downloads.
  const downloads: Download[] = [];
  page.on('download', (d) => downloads.push(d));
  await run(page, `await viewer.export('parcels', { format: 'geojson', name: 'out.geojson' });\nawait viewer.export('parcels', { format: 'csv', name: 'out.csv' });\nawait viewer.saveText('../../evil.sh', 'x');`);
  await expect.poll(() => downloads.length).toBe(3);
  const geojson = JSON.parse(await textOf(downloads[0]));
  expect(downloads[0].suggestedFilename()).toBe('out.geojson');
  expect(geojson.features).toHaveLength(3);
  expect(geojson.features[0].geometry.coordinates[0][0][0]).toBeCloseTo(139.7, 6);
  const csv = await textOf(downloads[1]);
  expect(csv.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe('name,note,WKT');
  expect(csv).toContain('POLYGON((139.7 35.68');
  // No folders, and only text file types.
  expect(downloads[2].suggestedFilename()).toBe('evil.sh.csv');

  // The imaging plan (the sample satellites without a catalog) over a point.
  await run(
    page,
    `const sats = await viewer.satellites();
print('satellites', sats.length);
const plan = await viewer.imagingPlan({ target: [139.7, 35.7], start: '2026-10-20T00:00:00Z', days: 3, daylight: 'none', addLayer: '計画' });
print('opportunities', plan.opportunities.length, plan.opportunities[0].satellite, typeof plan.layer);`,
  );
  await expect(output(page)).toContainText(/satellites [1-9]/);
  await expect(output(page)).toContainText(/opportunities [1-9]\d* \S+ string/);
  await expect(page.locator('#images .name', { hasText: '計画' })).toHaveCount(1);

  // Rasters: pixels read, a new GeoTIFF made of them, its values read back.
  const size = 32;
  const values = new Uint16Array(size * size * 2);
  for (let i = 0; i < size * size; i++) values.set([100, 100 + (i % size) * 10], i * 2);
  const tif = new Uint8Array(
    writeArrayBuffer(values, {
      width: size,
      height: size,
      SamplesPerPixel: 2,
      BitsPerSample: [16, 16],
      SampleFormat: [1, 1],
      PlanarConfiguration: 1,
      PhotometricInterpretation: 1,
      ExtraSamples: [0],
      ModelPixelScale: [10, 10, 0],
      ModelTiepoint: [0, 0, 0, 380000, 3950000, 0],
      ProjectedCSTypeGeoKey: 32654,
      GTModelTypeGeoKey: 1,
      GTRasterTypeGeoKey: 1,
    }),
  );
  await choose(page, 'two.tif', tif);
  await run(
    page,
    `const info = await viewer.rasterInfo('two.tif');
print('info', info.width, info.height, info.bands, info.crs);
const px = await viewer.readPixels('two.tif', { bands: [0, 1] });
const [a, b] = px.data;
const out = new Float32Array(a.length);
for (let i = 0; i < out.length; i++) out[i] = (b[i] - a[i]) / (b[i] + a[i]);
const id = await viewer.createRaster('nd', { width: px.width, height: px.height, data: out, extent: px.extent, crs: px.crs });
const lonLat = await geo.transform({ type: 'Point', coordinates: [380000 + 315, 3950000 - 5] }, 'EPSG:32654', 'EPSG:4326');
print('sample', JSON.stringify(await viewer.sample(id, [lonLat.coordinates])));`,
  );
  await expect(output(page)).toContainText('info 32 32 2 EPSG:32654');
  // x = 31: (410 - 100) / (410 + 100)
  await expect(output(page)).toContainText(`sample [[${Math.fround(310 / 510)}]]`);
});

test('a saved script repeats at an interval while the page is open, with a record of each run, until 「停止」', async ({ page }) => {
  await page.clock.install();
  await open(page);
  await openScripts(page);
  await dialog(page).getByLabel('スクリプト（JavaScript）').fill('print("run");');
  page.once('dialog', (d) => void d.accept('数える'));
  await dialog(page).getByRole('button', { name: '保存' }).click();
  await expect(dialog(page).getByLabel('スクリプトを開く')).toHaveValue('saved:0');

  await dialog(page).getByLabel('繰り返し').selectOption({ label: '1分ごと' });
  await dialog(page).getByRole('button', { name: '実行' }).click();
  const status = dialog(page).locator('.script-status');
  await expect(status).toContainText('次は');
  // Waiting for the next run, 「停止」 is still there (it ends the repeat), and so is 「実行」.
  await expect(dialog(page).getByRole('button', { name: '停止' })).toBeEnabled();
  // 「実行の記録」 opens under the output.
  await dialog(page).locator('.script-log summary').click();
  const log = dialog(page).getByRole('list', { name: '実行の記録' });
  await expect(log.locator('li')).toHaveCount(1);
  await expect(log.locator('li').first()).toContainText('「数える」 完了');

  // An edit to the editor does not change what repeats.
  await dialog(page).getByLabel('スクリプト（JavaScript）').fill('throw new Error("edited");');
  await page.clock.fastForward(61_000);
  await expect(log.locator('li')).toHaveCount(2);
  await expect(log.locator('li').first()).toContainText('完了');
  await expect(dialog(page).locator('.script-log summary')).toContainText('2 回');

  // Closing the panel keeps it going.
  await dialog(page).getByRole('button', { name: '閉じる' }).click();
  await page.clock.fastForward(61_000);
  await openScripts(page);
  await expect(log.locator('li')).toHaveCount(3);

  await dialog(page).getByRole('button', { name: '停止' }).click();
  await expect(status).toContainText('繰り返しを止めました');
  await expect(dialog(page).getByRole('button', { name: '停止' })).toBeDisabled();
  await page.clock.fastForward(130_000);
  await expect(log.locator('li')).toHaveCount(3);
});
