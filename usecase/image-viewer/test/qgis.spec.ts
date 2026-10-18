import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';

/*
 * QGIS interoperability: an SLD read into a vector layer's style dialog
 * (and a QML written from it), and a QGIS project (.qgz) with WMS, WFS and
 * XYZ layers opened from the プロジェクト menu.
 */

const shots = '/mnt/project-files/integrations';

async function open(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

async function choose(page: Page, name: string, bytes: Uint8Array | string) {
  await page.evaluate(
    ([name, data]) => {
      const list = new DataTransfer();
      list.items.add(new File([typeof data === 'string' ? data : new Uint8Array(data)], name));
      const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
      input.files = list.files;
      input.dispatchEvent(new Event('change'));
    },
    [name, typeof bytes === 'string' ? bytes : [...bytes]] as const,
  );
}

/** A zip of stored (uncompressed) files, as small .qgz files are. */
function zip(files: Array<{ name: string; text: string }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.from(f.text, 'utf8');
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, name, data);
    central.push(entry, name);
    offset += local.length + name.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

const square = (x: number, y: number, d = 0.01) => [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]];
const landuse = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: square(139.7, 35.68) }, properties: { name: '中央公園', use: '公園' } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: square(139.71, 35.68) }, properties: { name: '駅前', use: '商業' } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: square(139.7, 35.69) }, properties: { name: '北町', use: '住宅' } },
  ],
});

test('an SLD from QGIS is read into a vector layer’s style, and the style is written as QML', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await choose(page, 'landuse.geojson', landuse);
  await expect(page.locator('#status')).toContainText('landuse を開きました');
  await page.locator('#images li').first().getByRole('button', { name: 'スタイル・ラベル' }).click();
  const dialog = page.getByRole('dialog', { name: 'スタイル: landuse' });

  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: '読み込み…' }).click();
  await (await chooser).setFiles({ name: 'landuse.sld', mimeType: 'application/xml', buffer: readFileSync(new URL('./data/qgis/landuse-categorized.sld', import.meta.url)) });
  const note = dialog.locator('.style-note');
  await expect(note).toContainText('landuse.sld（SLD）を読み込みました');
  await expect(note).toContainText('模様・画像の塗り');
  await expect(dialog.getByLabel('表示方法')).toHaveValue('categorized');
  await expect(dialog.getByLabel('商業 の色')).toHaveValue('#ff8800');
  await expect(dialog.getByLabel('ラベルにする属性')).toHaveValue('name');
  await page.screenshot({ path: `${shots}/qgis-style-import.png` });
  await dialog.getByRole('button', { name: 'OK' }).click();

  const spec = await page.evaluate(() => (window.viewer.images.layers()[0] as { service: import('../src/services/index.js').ServiceLayer }).service.style!.get());
  expect(spec.mode).toBe('categorized');
  expect(spec.categories.find((c) => c.value === '公園')?.color).toBe('#33a02c');
  expect(spec.label).toMatchObject({ field: 'name', size: 16, bold: true, maxScale: 50000 });
  expect(spec.minScale).toBe(200000);

  // Written as QML for QGIS.
  await page.locator('#images li').first().getByRole('button', { name: 'スタイル・ラベル' }).click();
  await dialog.getByRole('button', { name: '書き出し…' }).click();
  await dialog.getByLabel('書き出す形式').selectOption('qml');
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('landuse.qml');
  const qml = readFileSync((await download.path())!, 'utf8');
  expect(qml).toContain('<renderer-v2 type="categorizedSymbol" attr="use"');
  expect(qml).toContain('fieldName="name"');
  await dialog.getByRole('button', { name: 'キャンセル' }).click();
  expect(errors).toEqual([]);
});

const project = (base: string) => `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis projectname="都内" version="3.34.4-Prizren">
  <layer-tree-group>
    <layer-tree-layer id="wfs" name="駅" checked="Qt::Checked" providerKey="WFS" source=""/>
    <layer-tree-group name="背景" checked="Qt::Checked">
      <layer-tree-layer id="wms" name="東京の地図" checked="Qt::Unchecked" providerKey="wms" source=""/>
      <layer-tree-layer id="xyz" name="タイル" checked="Qt::Checked" providerKey="wms" source=""/>
    </layer-tree-group>
    <layer-tree-layer id="pg" name="建物" checked="Qt::Checked" providerKey="postgres" source=""/>
  </layer-tree-group>
  <mapcanvas name="theMapCanvas">
    <extent><xmin>139.70</xmin><ymin>35.65</ymin><xmax>139.80</xmax><ymax>35.72</ymax></extent>
    <destinationsrs><spatialrefsys><authid>EPSG:4326</authid></spatialrefsys></destinationsrs>
  </mapcanvas>
  <projectlayers>
    <maplayer type="vector" geometry="Point">
      <id>wfs</id>
      <datasource>srsname='EPSG:4326' typename='test:stations' url='${base}/svc/wfs' version='auto'</datasource>
      <layername>stations</layername>
      <provider>WFS</provider>
      <renderer-v2 type="singleSymbol"><symbols><symbol type="marker" name="0" alpha="1"><layer class="SimpleMarker" enabled="1"><Option type="Map"><Option name="color" type="QString" value="0,128,255,255"/><Option name="name" type="QString" value="square"/><Option name="size" type="QString" value="12"/><Option name="size_unit" type="QString" value="Pixel"/></Option></layer></symbol></symbols></renderer-v2>
      <labeling type="simple"><settings><text-style fieldName="name" isExpression="0" fontSize="14" fontSizeUnit="Pixel" textColor="0,0,0,255"/></settings></labeling>
      <layerOpacity>0.8</layerOpacity>
    </maplayer>
    <maplayer type="raster">
      <id>wms</id>
      <datasource>crs=EPSG:3857&amp;format=image/png&amp;layers=test:tokyo&amp;styles&amp;url=${encodeURIComponent(`${base}/svc/wms`)}</datasource>
      <layername>tokyo</layername>
      <provider>wms</provider>
      <pipe><rasterrenderer type="singlebandcolordata" opacity="0.5" band="1"/></pipe>
    </maplayer>
    <maplayer type="raster">
      <id>xyz</id>
      <datasource>type=xyz&amp;url=${encodeURIComponent(`${base}/svc/wmts/tile/{z}/{y}/{x}.png`)}&amp;zmax=18&amp;zmin=0</datasource>
      <layername>tiles</layername>
      <provider>wms</provider>
      <pipe><rasterrenderer type="singlebandcolordata" opacity="1" band="1"/></pipe>
    </maplayer>
    <maplayer type="vector" geometry="Polygon">
      <id>pg</id>
      <datasource>dbname='gis' host=localhost table="public"."buildings" (geom)</datasource>
      <layername>buildings</layername>
      <provider>postgres</provider>
    </maplayer>
  </projectlayers>
</qgis>
`;

test('a QGIS project (.qgz) opens with its WMS, WFS and XYZ layers, styles and extent, and is written back as .qgs', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  const qgz = zip([{ name: 'tokyo.qgs', text: project(baseURL!) }]);
  await choose(page, 'tokyo.qgz', qgz);
  const status = page.locator('#status');
  await expect(status).toContainText('QGIS プロジェクト「tokyo」を開きました', { timeout: 20_000 });
  await expect(status).toContainText('開けないレイヤー: 建物（データベース）');

  const layers = await page.evaluate(() =>
    window.viewer.images.layers().map((l) => ({
      name: l.name,
      visible: window.viewer.images.isVisible(l),
      opacity: l.layer.getOpacity(),
      kind: l.type === 'service' ? l.service.ref?.kind : null,
      style: l.type === 'service' ? l.service.style?.get() : undefined,
    })),
  );
  expect(layers.map((l) => [l.name, l.kind, l.visible, l.opacity])).toEqual([
    ['駅', 'wfs', true, 0.8],
    ['東京の地図', 'wms', false, 0.5],
    ['タイル', 'xyz', true, 1],
  ]);
  expect(layers[0].style).toMatchObject({ mode: 'single', symbol: { shape: 'square', size: 12, fill: '#0080ff' }, label: { field: 'name', size: 14 } });
  // The canvas extent, from EPSG:4326.
  const [x, y] = await page.evaluate(() => window.viewer.map.getView().getCenter()!);
  const center = [(x / 20037508.342789244) * 180, (Math.atan(Math.exp(y / 6378137)) * 360) / Math.PI - 90];
  expect(center[0]).toBeCloseTo(139.75, 2);
  expect(center[1]).toBeCloseTo(35.685, 2);
  await page.locator('#project-menu .menu-button').click();
  await page.screenshot({ path: `${shots}/qgis-project-open.png` });

  // And out again, for QGIS.
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'QGIS 形式で書き出す' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('tokyo.qgs');
  const qgs = readFileSync((await download.path())!, 'utf8');
  expect(qgs).toContain('<provider encoding="UTF-8">WFS</provider>');
  expect(qgs).toContain('type=xyz&amp;url=');
  expect(qgs).toContain('<renderer-v2 type="singleSymbol"');
  expect(errors).toEqual([]);
});
