import { expect, test, type Page } from '@playwright/test';
import { writeArrayBuffer } from 'geotiff';
import { toBase64 } from './fixtures.js';

/*
 * Scripts automate what a person does in the viewer: layers shown, ordered
 * and closed, correction, bands and styles, the view and the menus, the tool
 * dialogs, and opening layers from a URL (a new server is asked about) or
 * from files the person picks.
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

const dialog = (page: Page) => page.getByRole('dialog', { name: 'スクリプト' });
const output = (page: Page) => dialog(page).locator('.script-output');

async function openScripts(page: Page) {
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.getByRole('button', { name: 'スクリプト…' }).click();
  await expect(dialog(page)).toBeVisible();
}

/** Types `code` into the editor and runs it; resolves once it has ended. */
async function run(page: Page, code: string): Promise<string> {
  await dialog(page).getByLabel('スクリプト（JavaScript）').fill(code);
  await dialog(page).getByRole('button', { name: '実行' }).click();
  await expect(dialog(page).getByRole('button', { name: '実行' })).toBeEnabled({ timeout: 30_000 });
  return (await dialog(page).locator('.script-status').textContent()) ?? '';
}

const parcels = JSON.stringify({
  type: 'FeatureCollection',
  features: ['A', 'B', 'C'].map((name, i) => {
    const lon = 139.7 + i * 0.02;
    return {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[[lon, 35.68], [lon + 0.01, 35.68], [lon + 0.01, 35.69], [lon, 35.69], [lon, 35.68]]] },
      properties: { name, kind: i === 2 ? 'x' : 'y' },
    };
  }),
});

/** A small 3-band (or `bands`-band) 8-bit GeoTIFF near Tokyo. */
function geotiff(bands = 3, size = 32): Uint8Array {
  const values = new Uint8Array(size * size * bands);
  for (let i = 0; i < size * size; i++) for (let b = 0; b < bands; b++) values[i * bands + b] = 20 + b * 40 + (i % size);
  return new Uint8Array(
    writeArrayBuffer(values, {
      width: size,
      height: size,
      SamplesPerPixel: bands,
      BitsPerSample: Array(bands).fill(8),
      SampleFormat: Array(bands).fill(1),
      PlanarConfiguration: 1,
      PhotometricInterpretation: bands >= 3 ? 2 : 1,
      ...(bands > 3 || bands === 2 ? { ExtraSamples: Array(bands === 2 ? 1 : bands - 3).fill(0) } : {}),
      ModelPixelScale: [0.001, 0.001, 0],
      ModelTiepoint: [0, 0, 0, 139.7, 35.7, 0],
      GeographicTypeGeoKey: 4326,
      GTModelTypeGeoKey: 2,
      GTRasterTypeGeoKey: 1,
    }),
  );
}

test('a script shows, orders and styles layers, corrects images and drives the view and menus', async ({ page }) => {
  await open(page);
  await choose(page, 'parcels.geojson', parcels);
  await choose(page, 'rgb.tif', geotiff());
  await openScripts(page);
  const status = await run(
    page,
    `const parcels = (await viewer.layers()).find((l) => l.kind === 'vector');
const rgb = (await viewer.layers()).find((l) => l.kind === 'raster');
await viewer.setVisible(parcels, false);
print('visible', (await viewer.layer(parcels)).visible);
await viewer.setVisible(parcels, true);
await viewer.setOpacity(rgb, 0.5);
print('order', (await viewer.moveLayer(parcels, 'top'))[0] === parcels.id);
print('ops', JSON.stringify((await viewer.setEnhance(rgb, { brightness: 0.2, contrast: 0.1 })).map((s) => s.op)));
print('bands', JSON.stringify(await viewer.setBands(rgb, [2, 1, 0])));
const spec = await viewer.setStyle(parcels, { mode: 'categorized', field: 'kind' });
print('categories', spec.categories.map((c) => c.value).sort().join(','));
const view = await viewer.setView({ center: [139.72, 35.685], zoom: 13 });
print('zoom', view.zoom);
print('commands', (await viewer.commands()).some((c) => c.id === 'timeline-open'));
await viewer.command('timeline-open');
await viewer.split(2);
await viewer.theme('dark');
try { await viewer.setEnhance(rgb, { brightness: 'much' }); } catch (e) { print('bad', e.message.includes('補正を設定できません')); }`,
  );
  expect(status).toContain('完了');
  await expect(output(page)).toContainText('visible false');
  await expect(output(page)).toContainText('order true');
  await expect(output(page)).toContainText('ops ["brightness","contrast"]');
  await expect(output(page)).toContainText('bands [2,1,0]');
  await expect(output(page)).toContainText('categories x,y');
  await expect(output(page)).toContainText('zoom 13');
  await expect(output(page)).toContainText('commands true');
  await expect(output(page)).toContainText('bad true');
  const state = await page.evaluate(() => {
    const v = window.viewer;
    const rgb = v.images.list()[0];
    return {
      opacity: rgb.layer.getOpacity(),
      brightness: rgb.source.getPipeline().get('brightness')?.amount,
      top: v.images.layers()[0].name,
      timeline: v.timeline.isOpen(),
      split: v.split.getCount(),
      theme: document.documentElement.dataset.theme ?? document.documentElement.style.colorScheme,
    };
  });
  expect(state).toMatchObject({ opacity: 0.5, brightness: 0.2, top: expect.stringContaining('parcels'), timeline: true, split: 2 });
  expect(String(state.theme)).toContain('dark');
});

test('a script runs tool dialogs with its settings and gets their layers', async ({ page }) => {
  await open(page);
  await choose(page, 'parcels.geojson', parcels);
  await choose(page, 'two.tif', geotiff(2));
  await openScripts(page);
  await run(
    page,
    `print('tools', (await viewer.tools()).map((t) => t.id).filter((id) => ['buffer', 'band-math', 'classify', 'mosaic'].includes(id)).join(','));
const parcels = (await viewer.layers()).find((l) => l.kind === 'vector');
const two = (await viewer.layers()).find((l) => l.kind === 'raster');
const buffered = await viewer.tool('buffer', { input: parcels, distance: 50 });
print('buffer', buffered.layers.length, buffered.layers[0].count);
const options = await viewer.toolOptions('band-math');
print('options', Object.keys(options).includes('expression'));
const index = await viewer.tool('band-math', { image: two, preset: '', expression: 'B2 - B1' });
print('band-math', index.layers.length, index.layers[0].kind);
const px = await viewer.readPixels(index.layers[0].id, { width: 4 });
print('value', px.data[0][0]);
try { await viewer.tool('buffer', { input: parcels, nope: 1 }); } catch (e) { print('unknown', e.message.includes('distance')); }
try { await viewer.tool('buffer', { input: parcels, unit: 'mile' }); } catch (e) { print('choice', e.message.includes('km')); }`,
  );
  await expect(output(page)).toContainText('tools buffer,band-math,classify,mosaic');
  await expect(output(page)).toContainText('buffer 1 3');
  await expect(output(page)).toContainText('options true');
  await expect(output(page)).toContainText('band-math 1 raster');
  // Band 2 − band 1 is 40 everywhere.
  await expect(output(page)).toContainText('value 40');
  await expect(output(page)).toContainText('unknown true');
  await expect(output(page)).toContainText('choice true');
  // The dialogs are closed again.
  await expect(page.locator('dialog.processing-dialog[open]')).toHaveCount(0);
});

test('a script opens layers from URLs (asking about a new server) and from files the person picks, and closes layers', async ({ page }) => {
  await open(page);
  await openScripts(page);
  // The viewer's own server: no question.
  await run(page, `const [l] = await viewer.open('/fixture.tif');\nprint('cog', l.kind, l.name);`);
  await expect(output(page)).toContainText('cog raster');

  // Another server: asked, and declined.
  const other = 'http://127.0.0.1:4175/svc/wms';
  const asked: string[] = [];
  page.once('dialog', (d) => {
    asked.push(d.message());
    void d.dismiss();
  });
  await run(page, `try { await viewer.serviceLayers('${other}', 'wms'); } catch (e) { print('declined', e.message); }`);
  expect(asked[0]).toContain('http://127.0.0.1:4175');
  await expect(output(page)).toContainText('declined http://127.0.0.1:4175 への接続は許可されませんでした');

  // Allowed once, it is not asked again in the same run.
  let questions = 0;
  page.on('dialog', (d) => {
    questions++;
    void d.accept();
  });
  await run(
    page,
    `const layers = await viewer.serviceLayers('${other}', 'wms');
print('layers', layers.map((l) => l.name).join(','));
const [wms] = await viewer.open('${other}', { type: 'wms', layer: 'test:tokyo' });
print('wms', wms.kind);`,
  );
  await expect(output(page)).toContainText('layers test:tokyo');
  await expect(output(page)).toContainText('wms picture');
  expect(questions).toBe(1);

  // Files: the script asks, the person picks.
  await dialog(page).getByLabel('スクリプト（JavaScript）').fill(`const got = await viewer.openFiles({ accept: '.geojson', message: '区画のファイルを選んでください' });\nprint('files', got.length, got[0]?.kind);`);
  await dialog(page).getByRole('button', { name: '実行' }).click();
  const ask = dialog(page).getByRole('group', { name: 'スクリプトからの確認' });
  await expect(ask).toContainText('区画のファイルを選んでください');
  const chooser = page.waitForEvent('filechooser');
  await ask.getByRole('button', { name: 'ファイルを選ぶ…' }).click();
  await (await chooser).setFiles({ name: 'parcels.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(parcels) });
  await expect(output(page)).toContainText('files 1 vector');
  await expect(ask).toBeHidden();

  // Declining gives none.
  await dialog(page).getByLabel('スクリプト（JavaScript）').fill(`print('none', (await viewer.openFiles()).length);`);
  await dialog(page).getByRole('button', { name: '実行' }).click();
  await ask.getByRole('button', { name: 'やめる' }).click();
  await expect(output(page)).toContainText('none 0');

  // Closing a layer; one with unsaved edits is kept.
  await run(
    page,
    `const p = (await viewer.layers()).find((l) => l.kind === 'vector');
const f = await viewer.features(p);
await viewer.updateFeatures(p, [{ id: f.features[0].id, properties: { name: 'Z' } }]);
try { await viewer.removeLayer(p); } catch (e) { print('kept', e.message.includes('未保存')); }
const cog = (await viewer.layers()).find((l) => l.kind === 'raster');
await viewer.removeLayer(cog);
print('left', (await viewer.layers()).filter((l) => l.kind === 'raster').length);`,
  );
  await expect(output(page)).toContainText('kept true');
  await expect(output(page)).toContainText('left 0');
});

test('the automation samples run', async ({ page }) => {
  await open(page);
  await choose(page, 'four.tif', geotiff(4));
  await choose(page, 'parcels.geojson', parcels);
  await openScripts(page);
  for (const name of ['画像の見え方をそろえる（補正・バンド・不透明度）', 'すべての画像で NDVI（ツールを実行）', '属性で色分けしてラベルを付ける']) {
    // The last one styles the selected layer: the parcels (the NDVI result was selected when made).
    if (name.startsWith('属性')) await page.evaluate(() => window.viewer.images.select(window.viewer.images.layers().find((l) => l.name.includes('parcels'))!));
    await dialog(page).getByLabel('スクリプトを開く').selectOption({ label: name });
    await dialog(page).getByRole('button', { name: '実行' }).click();
    await expect(dialog(page).getByRole('button', { name: '実行' })).toBeEnabled({ timeout: 30_000 });
    await expect(dialog(page).locator('.script-status')).toContainText('完了');
  }
  await expect(output(page)).toContainText('name で 3 色に分けました');
  await expect(page.locator('#images .name', { hasText: 'NDVI' })).not.toHaveCount(0);
});
