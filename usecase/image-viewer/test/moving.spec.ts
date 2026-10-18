import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/*
 * Moving objects: a polled feed and an SSE feed from config.json, a WebSocket
 * by URL (stubbed with page.routeWebSocket), a history CSV interpolated at a
 * time set like 「撮影時刻に合わせる」 does, the popup of a clicked ship, and
 * AI detections checked against the history.
 */

const T0 = Date.UTC(2026, 9, 17, 9, 0, 0);
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

async function open(page: Page) {
  await page.route(/cyberjapandata\.gsi\.go\.jp|tile\.openstreetmap\.org/, (route) => route.fulfill({ status: 404, body: '' }));
  await page.route('**/config.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        movingFeeds: [
          { label: '港の AIS（ポーリング）', type: 'poll', url: './stub/ais.json', interval: 2 },
          { label: '空の ADS-B（SSE）', type: 'sse', url: './stub/adsb-events', kind: 'aircraft' },
          { label: '壊れた設定', type: 'websocket', url: 'https://x/y' },
        ],
      }),
    }),
  );
  // Positions now: two ships off Tokyo, in the shape of a GeoJSON FeatureCollection.
  await page.route('**/stub/ais.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: { mmsi: 431000001, shipname: 'HIKARI', cog: 45, sog: 12, timestamp: new Date().toISOString() }, geometry: { type: 'Point', coordinates: [139.75, 35.6] } },
          { type: 'Feature', properties: { mmsi: 431000002, shipname: 'NOZOMI', cog: 270, sog: 8, timestamp: new Date().toISOString() }, geometry: { type: 'Point', coordinates: [139.8, 35.55] } },
        ],
      }),
    }),
  );
  // An event stream of OpenSky-like aircraft (the body ends, and EventSource connects again).
  await page.route('**/stub/adsb-events', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
      body: `retry: 60000\n\ndata: ${JSON.stringify({ icao24: '86d5e1', callsign: 'JAL123', latitude: 35.65, longitude: 139.7, true_track: 180, velocity: 200, last_contact: Math.floor(Date.now() / 1000) })}\n\ndata: not json\n\n`,
    }),
  );
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

async function openDialog(page: Page) {
  await page.locator('#tools-menu .menu-button').click();
  await page.locator('#moving-open').click();
  await expect(page.locator('.moving-dialog')).toBeVisible();
}

test('connects polled, SSE and WebSocket feeds as layers of rotated symbols', async ({ page }) => {
  await page.routeWebSocket('wss://ais.example/stream', (ws) => {
    ws.onMessage(() => {});
    // aisstream.io's shape: nested objects, found by name.
    ws.send(
      JSON.stringify({
        MessageType: 'PositionReport',
        MetaData: { MMSI: 431999999, ShipName: 'SOCKET MARU', latitude: 35.62, longitude: 139.78, time_utc: new Date().toISOString().replace('T', ' ').replace('Z', ' +0000 UTC') },
        Message: { PositionReport: { Cog: 90, Sog: 5, TrueHeading: 92 } },
      }),
    );
    ws.send('x'.repeat(10));
  });
  await open(page);
  await openDialog(page);
  // The broken entry of config.json is left out.
  await expect(page.locator('.moving-dialog select[name=preset] option')).toHaveCount(2);

  await page.locator('.moving-dialog button[value=preset]').click();
  await page.locator('.moving-dialog select[name=preset]').selectOption({ index: 1 });
  await page.locator('.moving-dialog button[value=preset]').click();
  await page.locator('.moving-dialog input[name=url]').fill('wss://ais.example/stream');
  await page.locator('.moving-dialog button[value=url]').click();

  await expect.poll(() => page.evaluate(() => window.viewer.moving.feeds().map((f) => f.store.tracks.size))).toEqual([2, 1, 1]);
  await expect(page.locator('.moving-row')).toHaveCount(3);
  await expect(page.locator('.moving-row').first()).toContainText('ID=mmsi');
  // The layer's features follow the store on a timer, so they are polled too.
  const info = () =>
    page.evaluate(() =>
      window.viewer.moving.feeds().map((f) => ({ kind: f.kind, features: f.source.getFeatures().length, label: f.feed.label, names: f.source.getFeatures().map((x) => x.get('name')) })),
    );
  await expect.poll(info).toEqual([
    { kind: 'ship', features: 2, label: '港の AIS（ポーリング）', names: ['HIKARI', 'NOZOMI'] },
    { kind: 'aircraft', features: 1, label: '空の ADS-B（SSE）', names: ['JAL123'] },
    { kind: 'ship', features: 1, label: 'ais.example', names: ['SOCKET MARU'] },
  ]);
  // The layers are in the layer list, with their objects in the attribute table.
  await expect(page.locator('#images li')).toHaveCount(3);
  await page.locator('.moving-dialog button[value=cancel]').click();
  await page.locator('#images .name', { hasText: '港の AIS' }).click();
  await expect(page.locator('#table')).toContainText('HIKARI');

  // Closing a layer disconnects it.
  await openDialog(page);
  await page.locator('.moving-row', { hasText: 'ais.example' }).getByRole('button', { name: '切断' }).click();
  await expect(page.locator('.moving-row')).toHaveCount(2);
});

test('a history CSV follows the time set, and detections are checked against it', async ({ page }) => {
  await open(page);
  await openDialog(page);
  // Ship 1 sails east 139.70 → 139.80 from 09:00 to 09:20; ship 2 lies at 139.90 until 08:00.
  const csv = [
    'MMSI,BaseDateTime,LAT,LON,SOG,COG,Heading,VesselName',
    `1,${iso(0).slice(0, 19)},35.60,139.70,10,90,90,EAST`,
    `1,${iso(10).slice(0, 19)},35.60,139.75,10,90,90,EAST`,
    `1,${iso(20).slice(0, 19)},35.60,139.80,10,90,90,EAST`,
    `2,${iso(-90).slice(0, 19)},35.62,139.90,0,0,511,STILL`,
    `2,${iso(-60).slice(0, 19)},35.62,139.90,0,0,511,STILL`,
  ].join('\n');
  await page.locator('.moving-dialog input[type=file]').setInputFiles({ name: 'ais-history.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.locator('.moving-note')).toContainText('2 件・5 点');
  await expect(page.locator('.moving-row')).toContainText('時刻=BaseDateTime');

  // At 09:05 (as 「撮影時刻に合わせる」 sets an image's time): ship 1 halfway between its fixes, ship 2 long gone.
  await page.evaluate((t) => window.viewer.moving.alignTo(t), T0 + 5 * 60_000);
  await expect(page.locator('#timeline')).toBeVisible();
  const at = await page.evaluate(() => window.viewer.moving.feeds()[0].source.getFeatures().map((f) => [f.get('id'), f.get('lon'), f.get('state')]));
  expect(at).toEqual([['1', 139.725, '補間']]);

  // The popup of the clicked ship.
  await page.locator('.moving-dialog button[value=cancel]').click();
  await page.evaluate(() => window.viewer.map.getView().setZoom(14));
  await page.evaluate(() => {
    const f = window.viewer.moving.feeds()[0].source.getFeatures()[0];
    window.viewer.map.getView().setCenter((f.getGeometry() as import('ol/geom/Point.js').default).getCoordinates());
  });
  await page.waitForTimeout(300);
  const box = (await page.locator('#map').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('.moving-popup')).toContainText('EAST');
  await expect(page.locator('.moving-popup')).toContainText('補間');
  mkdirSync('/mnt/project-files/integrations', { recursive: true });
  await page.screenshot({ path: '/mnt/project-files/integrations/moving-history.png' }).catch(() => {});

  // Detections at 09:10: one on ship 1, one where ship 2 was (too long before), one at sea with nothing.
  const detections = {
    type: 'FeatureCollection',
    features: [
      [139.7502, 35.6001],
      [139.9, 35.62],
      [139.6, 35.5],
    ].map((c, i) => ({ type: 'Feature', properties: { class: 'ship', score: 0.9, n: i, image_time: iso(10) }, geometry: { type: 'Point', coordinates: c } })),
  };
  await page.evaluate((text) => {
    const list = new DataTransfer();
    list.items.add(new File([text], 'detections.geojson'));
    const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
    input.files = list.files;
    input.dispatchEvent(new Event('change'));
  }, JSON.stringify(detections));
  await expect(page.locator('#images .name', { hasText: 'detections' })).toHaveCount(1);
  await page.locator('#tools-menu .menu-button').click();
  await page.locator('#moving-match').click();
  const dialog = page.locator('.moving-match-dialog');
  await expect(dialog.locator('select[name=timeFrom]')).toHaveValue('field');
  await dialog.locator('input[name=distance]').fill('300');
  await dialog.locator('button[value=run]').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#images .name', { hasText: '照合' })).toHaveCount(1);
  const result = await page.evaluate(() => {
    const layer = window.viewer.images.selectedLayer()!;
    if (layer.type !== 'service') return null;
    const spec = layer.service.style!.get();
    return {
      rows: layer.service.vector!.source
        .getFeatures()
        .map((f) => [f.get('n'), f.get('ais_status'), f.get('ais_id'), f.get('ais_dt_s')])
        .sort((a, b) => a[0] - b[0]),
      mode: spec.mode,
      red: spec.categories.find((c) => c.value === 'なし')?.color,
    };
  });
  expect(result).toEqual({
    rows: [
      [0, '一致', '1', 0],
      [1, 'なし', null, null],
      [2, 'なし', null, null],
    ],
    mode: 'categorized',
    red: '#e03131',
  });
  await page.screenshot({ path: '/mnt/project-files/integrations/moving-match.png' }).catch(() => {});
});
