import { expect, test, type Download, type Page } from '@playwright/test';
import { toBase64, zip } from './fixtures.js';

/*
 * KML, KMZ, GPX and FlatGeobuf: opened as layers with their attributes,
 * and written by the export dialog (a FlatGeobuf written here opens again).
 */

async function open(page: Page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

async function choose(page: Page, name: string, bytes: Uint8Array) {
  await page.evaluate(
    (f) => {
      const list = new DataTransfer();
      list.items.add(new File([Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))], f.name));
      const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
      input.files = list.files;
      input.dispatchEvent(new Event('change'));
    },
    { name, base64: toBase64(bytes) },
  );
}

async function bytesOf(download: Download): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const utf8 = (s: string) => new TextEncoder().encode(s);

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <name>東京駅</name>
      <description>丸の内口</description>
      <ExtendedData><Data name="lines"><value>12</value></Data></ExtendedData>
      <Point><coordinates>139.7671,35.6812,0</coordinates></Point>
    </Placemark>
    <Folder>
      <Placemark>
        <name>皇居</name>
        <Polygon><outerBoundaryIs><LinearRing><coordinates>139.745,35.680 139.760,35.680 139.760,35.690 139.745,35.690 139.745,35.680</coordinates></LinearRing></outerBoundaryIs></Polygon>
      </Placemark>
    </Folder>
  </Document>
</kml>`;

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="35.3606" lon="138.7274"><ele>3776</ele><time>2024-08-01T04:30:00Z</time><name>山頂</name></wpt>
  <wpt lat="35.3950" lon="138.7310"><ele>2305</ele><name>五合目</name></wpt>
  <trk><name>登山道</name><trkseg>
    <trkpt lat="35.3950" lon="138.7310"><ele>2305</ele></trkpt>
    <trkpt lat="35.3800" lon="138.7290"><ele>3000</ele></trkpt>
    <trkpt lat="35.3606" lon="138.7274"><ele>3776</ele></trkpt>
  </trkseg></trk>
</gpx>`;

const rowsOf = (page: Page, name: string) =>
  page.evaluate((name) => {
    const layer = window.viewer.images.layers().find((l) => l.name === name);
    if (layer?.type !== 'service') return null;
    return layer.service.vector!.source.getFeatures().map((f) => {
      const p = { ...f.getProperties() };
      delete p[f.getGeometryName()];
      return { type: f.getGeometry()?.getType(), ...p };
    });
  }, name);

test('opens KML, KMZ and GPX as layers with their attributes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);

  await choose(page, 'stations.kml', utf8(KML));
  await expect(page.locator('#images .name', { hasText: 'stations' })).toHaveCount(1);
  await expect(page.locator('#images li', { hasText: 'stations' }).getByText('KML', { exact: true })).toBeVisible();
  const kml = await rowsOf(page, 'stations');
  expect(kml).toEqual([
    { type: 'Point', name: '東京駅', description: '丸の内口', lines: '12' },
    { type: 'Polygon', name: '皇居' },
  ]);

  await choose(page, 'packed.kmz', zip([{ name: 'doc.kml', bytes: utf8(KML) }]));
  await expect(page.locator('#images .name', { hasText: 'packed' })).toHaveCount(1);
  expect(await rowsOf(page, 'packed')).toHaveLength(2);

  await choose(page, 'fuji.gpx', utf8(GPX));
  await expect(page.locator('#images .name', { hasText: 'fuji' })).toHaveCount(1);
  const gpx = (await rowsOf(page, 'fuji'))!;
  expect(gpx.map((r) => r.type)).toEqual(['Point', 'Point', 'MultiLineString']);
  expect(gpx[0]).toMatchObject({ name: '山頂', ele: 3776, time: Date.UTC(2024, 7, 1, 4, 30) });
  expect(gpx[1]).toMatchObject({ name: '五合目', ele: 2305 });
  expect(gpx[2]).toMatchObject({ name: '登山道' });
  expect(errors).toEqual([]);
});

test('writes FlatGeobuf, KML and GPX; the FlatGeobuf opens again the same', async ({ page }) => {
  await open(page);
  await choose(page, 'stations.kml', utf8(KML));
  const row = page.locator('#images li', { hasText: 'stations' });
  await expect(row).toHaveCount(1);
  const exportAs = async (format: string) => {
    await row.getByRole('button', { name: /書き出し/ }).click();
    const dialog = page.getByRole('dialog', { name: '書き出し' });
    await dialog.getByLabel('形式').selectOption(format);
    if (format !== 'fgb') await expect(dialog.getByLabel('座標系')).toBeDisabled();
    const downloading = page.waitForEvent('download');
    await dialog.getByRole('button', { name: '書き出し' }).click();
    const download = await downloading;
    return { name: download.suggestedFilename(), bytes: await bytesOf(download) };
  };

  const fgb = await exportAs('fgb');
  expect(fgb.name).toBe('stations.fgb');
  expect([...fgb.bytes.subarray(0, 4)]).toEqual([0x66, 0x67, 0x62, 0x03]);
  await choose(page, 'again.fgb', fgb.bytes);
  await expect(page.locator('#images .name', { hasText: 'again' })).toHaveCount(1);
  expect(await rowsOf(page, 'again')).toEqual(await rowsOf(page, 'stations'));
  const [a, b] = await page.evaluate(() =>
    ['stations', 'again'].map((name) => {
      const layer = window.viewer.images.layers().find((l) => l.name === name)!;
      return layer.type === 'service' ? (layer.service.vector!.source.getFeatures()[0].getGeometry() as unknown as { getCoordinates(): number[] }).getCoordinates() : [];
    }),
  );
  expect(b[0]).toBeCloseTo(a[0], 3);
  expect(b[1]).toBeCloseTo(a[1], 3);

  const kml = (await exportAs('kml')).bytes.toString('utf8');
  expect(kml).toContain('<name>東京駅</name>');
  expect(kml).toContain('<Data name="lines"><value>12</value></Data>');

  const gpx = (await exportAs('gpx')).bytes.toString('utf8');
  expect(gpx).toContain('<wpt lat="35.6812" lon="139.7671">');
  expect(gpx).not.toContain('皇居');
});
