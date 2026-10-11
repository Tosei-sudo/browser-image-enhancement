import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { writeArrayBuffer } from 'geotiff';
import { toBase64 } from './fixtures.js';

/*
 * The AI tools with tiny stand-in models (test/data/ai/make-models.py), run
 * by ONNX Runtime Web from the build (on the CPU here: headless Chromium has
 * no WebGPU adapter):
 * - 物体検出 finds the bright cells of a white square on a black image and
 *   makes them a temporary layer where the square is;
 * - クリックで抽出 outlines a disc round the click (the stand-in decoder's
 *   mask, at low resolution over the padded input), which is checked for its
 *   size on the map.
 */

const SIZE = 256;
/** The white square: pixels 96–159 each way, in the middle of the image. */
const inSquare = (x: number, y: number) => x >= 96 && x < 160 && y >= 96 && y < 160;
const model = (name: string) => toBase64(readFileSync(new URL(`./data/ai/${name}`, import.meta.url)));

/** An 8-bit RGB GeoTIFF in WGS 84 / UTM zone 54N, 10 m pixels. */
function squareTiff(): Uint8Array {
  const values = new Uint8Array(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) values.fill(inSquare(x, y) ? 255 : 0, (y * SIZE + x) * 3, (y * SIZE + x) * 3 + 3);
  return new Uint8Array(
    writeArrayBuffer(values, {
      width: SIZE,
      height: SIZE,
      SamplesPerPixel: 3,
      BitsPerSample: [8, 8, 8],
      PhotometricInterpretation: 2,
      ModelPixelScale: [10, 10, 0],
      ModelTiepoint: [0, 0, 0, 380000, 3950000, 0],
      ProjectedCSTypeGeoKey: 32654,
      GTModelTypeGeoKey: 1,
      GTRasterTypeGeoKey: 1,
    }),
  );
}

async function openSquare(page: Page, name = 'square.tif') {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
  await page.evaluate(([base64, name]) => {
    const list = new DataTransfer();
    list.items.add(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], name));
    const input = document.querySelector<HTMLInputElement>('#open input[type=file]')!;
    input.files = list.files;
    input.dispatchEvent(new Event('change'));
  }, [toBase64(squareTiff()), name]);
  await expect(page.locator('#images .name')).toHaveCount(1);
  // Let the image draw at its final place.
  await page.evaluate(() => new Promise((resolve) => window.viewer.map.once('rendercomplete', resolve)));
}

/** The square's size on the map (EPSG:3857 units): 640 m of UTM near 35.7° N, stretched by Web Mercator. */
const squareOnMap = 640 / Math.cos((35.69 * Math.PI) / 180);

test('detects objects over the view and adds them as a temporary layer', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openSquare(page);

  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#ai-detect').click();
  const dialog = page.locator('.ai-dialog');
  await expect(dialog).toBeVisible();
  await page.evaluate((base64) => {
    window.viewer.aiDetect.addModelFile(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], 'detect.onnx'));
  }, model('detect.onnx'));
  // The class names and input size come from the model's own metadata.
  await expect(dialog.locator('.ai-model-info')).toContainText('物体検出（矩形）・入力 64×64・2 クラス（bright・dark）・CPU（WebAssembly）で実行');
  await expect(dialog.getByLabel('スコアのしきい値')).toHaveValue('0.25');

  // Cells mostly on the square (the gray padding round the image scores under a half).
  await dialog.locator('summary').click();
  await dialog.getByLabel('スコアのしきい値').fill('0.5');
  await dialog.getByRole('button', { name: '実行' }).click();
  await expect(page.locator('#status')).toContainText('物体検出（detect.onnx） を作成しました', { timeout: 30_000 });
  await expect(dialog).toBeHidden();
  await expect(page.locator('#images .name').first()).toContainText('物体検出（detect.onnx）');

  const found = await page.evaluate(() => {
    const layer = window.viewer.images.layers()[0];
    if (layer.type !== 'service') return null;
    const features = layer.service.vector!.source.getFeatures();
    const extent = layer.service.vector!.source.getExtent()!;
    const view = window.viewer.map.getView();
    return {
      count: features.length,
      classes: [...new Set(features.map((f) => f.get('class')))],
      scores: features.map((f) => f.get('score') as number),
      fields: layer.service.vector!.fields.map((f) => f.name),
      extent,
      center: view.getCenter()!,
      resolution: view.getResolution()!,
    };
  });
  expect(found).not.toBeNull();
  const { count, classes, scores, fields, extent, center, resolution } = found!;
  expect(count).toBeGreaterThan(0);
  expect(classes).toEqual(['bright']);
  expect(Math.min(...scores)).toBeGreaterThanOrEqual(0.5);
  expect(fields).toEqual(['class', 'class_id', 'score', 'image', 'image_id', 'image_time', 'model', 'detected_at', 'note']);
  // The cells found cover the square (to a cell of 16 screen pixels), in the middle of the image and the view.
  const cell = 16 * resolution;
  expect(Math.abs((extent[0] + extent[2]) / 2 - center[0])).toBeLessThan(cell);
  expect(Math.abs((extent[1] + extent[3]) / 2 - center[1])).toBeLessThan(cell);
  expect(Math.abs(extent[2] - extent[0] - squareOnMap)).toBeLessThan(2 * cell);
  expect(Math.abs(extent[3] - extent[1] - squareOnMap)).toBeLessThan(2 * cell);
  expect(errors).toEqual([]);
});

test('draws and analyses an 8 times larger view block by block', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openSquare(page);
  // Zoomed out 8 times: at 8 times the detail, the square has as many pixels as at 1× before.
  await page.evaluate(() => {
    const view = window.viewer.map.getView();
    view.setResolution(view.getResolution()! * 8);
  });
  await page.evaluate(() => new Promise((resolve) => window.viewer.map.once('rendercomplete', resolve)));
  const blocks = await page.evaluate(() => window.viewer.map.getSize()!.map((n) => Math.ceil((n * 8 * devicePixelRatio) / 4096)));
  expect(blocks[0] * blocks[1]).toBeGreaterThan(1);

  await page.evaluate((base64) => {
    window.viewer.aiDetect.open();
    window.viewer.aiDetect.addModelFile(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], 'detect.onnx'));
  }, model('detect.onnx'));
  const dialog = page.locator('.ai-dialog');
  await expect(dialog.locator('.ai-model-info')).toContainText('2 クラス');
  await dialog.locator('summary').click();
  await dialog.getByLabel('解析の細かさ').selectOption('8');
  await dialog.getByLabel('スコアのしきい値').fill('0.5');
  await dialog.getByRole('button', { name: '実行' }).click();
  await expect(page.locator('#status')).toContainText('を作成しました', { timeout: 60_000 });

  const found = await page.evaluate(() => {
    const layer = window.viewer.images.layers()[0];
    if (layer.type !== 'service') return null;
    const view = window.viewer.map.getView();
    return { extent: layer.service.vector!.source.getExtent()!, center: view.getCenter()!, resolution: view.getResolution()! };
  });
  const { extent, center, resolution } = found!;
  // The cells cover the square where it is (to a cell of 16 pixels at 8 times the detail), across the blocks.
  const cell = (16 * resolution) / 8;
  expect(Math.abs((extent[0] + extent[2]) / 2 - center[0])).toBeLessThan(cell);
  expect(Math.abs((extent[1] + extent[3]) / 2 - center[1])).toBeLessThan(cell);
  expect(Math.abs(extent[2] - extent[0] - squareOnMap)).toBeLessThan(2 * cell);
  expect(Math.abs(extent[3] - extent[1] - squareOnMap)).toBeLessThan(2 * cell);
  // The map is back as it was.
  expect(await page.evaluate(() => window.viewer.map.getView().getResolution())).toBeCloseTo(resolution);
  expect(errors).toEqual([]);
});

test('outlines the object under a click with Segment Anything', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openSquare(page);

  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#ai-segment').click();
  const panel = page.locator('.ai-segment-panel');
  await expect(panel).toBeVisible();
  await expect(page.locator('#ai-segment')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(
    ([encoder, decoder]) => {
      const file = (base64: string, name: string) => new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], name);
      // Chosen together, in either order: told apart by their names.
      window.viewer.aiSegment.addModelFiles([file(decoder, 'mini_decoder.onnx'), file(encoder, 'mini_encoder.onnx')]);
    },
    [model('sam-encoder.onnx'), model('sam-decoder.onnx')],
  );
  await expect(panel.locator('.ai-segment-note')).toContainText('準備ができました（CPU（WebAssembly））');

  const box = (await page.locator('#map').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(panel.locator('.ai-segment-note')).toContainText('1 個を抽出しました', { timeout: 30_000 });

  // The stand-in mask is a disc of 64 encoder pixels round the click: 64 / scale on the screen.
  const outline = await page.evaluate(() => {
    const map = window.viewer.map;
    const [width, height] = map.getSize()!;
    const [feature] = window.viewer.aiSegment.outlines();
    const polygon = feature.getGeometry() as import('ol/geom/Polygon.js').default;
    return { area: polygon.getArea(), extent: polygon.getExtent(), resolution: map.getView().getResolution()!, center: map.getView().getCenter()!, longer: Math.max(width, height) * devicePixelRatio, ratio: devicePixelRatio };
  });
  const radius = ((64 * outline.longer) / 1024 / outline.ratio) * outline.resolution;
  expect(outline.area / (Math.PI * radius * radius)).toBeGreaterThan(0.9);
  expect(outline.area / (Math.PI * radius * radius)).toBeLessThan(1.1);
  expect(Math.abs((outline.extent[0] + outline.extent[2]) / 2 - outline.center[0])).toBeLessThan(2 * outline.resolution);

  await panel.getByRole('button', { name: 'レイヤーにする' }).click();
  await expect(page.locator('#status')).toContainText('AI 抽出 を作成しました（1 件、一時レイヤー）');
  await expect(page.locator('#images .name').first()).toContainText('AI 抽出');
  // Esc ends the tool and clears its preview.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(page.locator('#ai-segment')).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test('writes detections, corrected and added ones, to an Esri feature layer by mapped attributes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const url = 'http://localhost:4175/svc/arcgis/rest/services/Detections/FeatureServer/0';
  const settings = {
    detectionOutputs: [
      {
        label: '検出DB',
        url,
        fields: { fileName: 'FILE_NAME', imageId: 'IMAGE_ID', detectedAt: 'DETECTED_AT', sentAt: 'SENT_AT', class: 'CLASS', score: 'CONFIDENCE', model: 'MODEL', status: 'STATUS', lon: 'LON', lat: 'LAT', area: 'AREA_M2', note: 'NOTE' },
        statusValues: { ai: 1, corrected: 2, manual: 3 },
        constants: { SOURCE: 'viewer' },
      },
    ],
  };
  await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(settings) }));
  const name = `transfer-${Date.now()}.tif`;
  await openSquare(page, name);
  await page.evaluate((base64) => {
    window.viewer.aiDetect.open();
    window.viewer.aiDetect.addModelFile(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], 'detect.onnx'));
  }, model('detect.onnx'));
  const dialog = page.locator('.ai-dialog');
  await expect(dialog.locator('.ai-model-info')).toContainText('2 クラス');
  await dialog.locator('summary').click();
  await dialog.getByLabel('スコアのしきい値').fill('0.5');
  await dialog.getByRole('button', { name: '実行' }).click();
  await expect(page.locator('#status')).toContainText('を作成しました', { timeout: 30_000 });

  // A person checks the result: one class corrected, one false detection deleted.
  const count = await page.evaluate(() => {
    const layer = window.viewer.images.layers()[0];
    if (layer.type !== 'service') return 0;
    const source = layer.service.vector!.source;
    const [first, second] = source.getFeatures();
    first.set('class', 'roof');
    source.removeFeature(second);
    return source.getFeatures().length;
  });

  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#ai-transfer').click();
  const transfer = page.locator('.ai-transfer-dialog');
  await expect(transfer.locator('.ai-transfer-plan')).toContainText(`検出結果（ポリゴン）へ新規 ${count} 件・更新 0 件・転記済みで変更なし 0 件（AI ${count - 1}・修正 1）`);
  // NOTE is mapped but the layer has no such attribute: shown, and left out.
  await expect(transfer.locator('.ai-transfer-plan')).toContainText('転記先にない属性 1 個は書きません');
  await transfer.getByRole('button', { name: '転記' }).click();
  await expect(page.locator('#status')).toContainText(`検出DB へ ${count} 件を追加、0 件を更新しました`);

  const rows = async () =>
    ((await (await page.request.get('/svc/detections')).json()) as Array<{ attributes: Record<string, unknown>; geometry: { rings: number[][][] } }>).filter(
      (r) => r.attributes.FILE_NAME === name,
    );
  let sent = await rows();
  expect(sent).toHaveLength(count);
  expect(sent.filter((r) => r.attributes.STATUS === 2).map((r) => r.attributes.CLASS)).toEqual(['roof']);
  expect(sent.filter((r) => r.attributes.STATUS === 1).every((r) => r.attributes.CLASS === 'bright')).toBe(true);
  for (const r of sent) {
    expect(r.attributes).toMatchObject({ MODEL: 'detect.onnx', SOURCE: 'viewer', IMAGE_ID: null });
    expect(r.attributes.CONFIDENCE).toBeGreaterThanOrEqual(0.5);
    expect(typeof r.attributes.DETECTED_AT).toBe('number');
    expect(typeof r.attributes.SENT_AT).toBe('number');
    // Near 35.68° N, 140.3° E (UTM zone 54N, 380 km E), with an area of a few hundred square metres or more.
    expect(r.attributes.LAT as number).toBeGreaterThan(35.6);
    expect(r.attributes.LAT as number).toBeLessThan(35.75);
    expect(r.attributes.AREA_M2 as number).toBeGreaterThan(100);
    expect(r.geometry.rings[0].length).toBe(5);
  }

  // Sent once: nothing new. A box moved afterwards is sent again as an update of its row.
  await transfer.getByRole('button', { name: '閉じる' }).click();
  await page.evaluate(() => {
    const layer = window.viewer.images.layers()[0];
    if (layer.type === 'service') layer.service.vector!.source.getFeatures()[2].getGeometry()!.translate(10, 0);
  });
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#ai-transfer').click();
  await expect(transfer.locator('.ai-transfer-plan')).toContainText(`新規 0 件・更新 1 件・転記済みで変更なし ${count - 1} 件（AI ${count - 2}・修正 2）`);
  await transfer.getByRole('button', { name: '転記' }).click();
  await expect(page.locator('#status')).toContainText('検出DB へ 0 件を追加、1 件を更新しました');
  sent = await rows();
  expect(sent).toHaveLength(count);
  expect(sent.filter((r) => r.attributes.STATUS === 2)).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('the sample models ship with the viewer: YOLO11-OBB and YOLOX-Tiny load, MobileSAM outlines the square', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openSquare(page);

  // 物体検出: the aerial model is chosen first, its classes and input from its own metadata.
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#ai-detect').click();
  const dialog = page.locator('.ai-dialog');
  const models = dialog.getByRole('combobox', { name: 'モデル' });
  await expect(models).toHaveValue('config:0');
  await expect(dialog.locator('.ai-model-info')).toContainText('物体検出（回転矩形）・入力 1024×1024・15 クラス（plane・ship・storage tank', { timeout: 60_000 });
  // YOLOX-Tiny, with COCO's classes.
  await models.selectOption('config:1');
  await expect(dialog.locator('.ai-model-info')).toContainText('物体検出（矩形）・入力 416×416・80 クラス（person・bicycle・car', { timeout: 60_000 });
  await dialog.getByRole('button', { name: '実行' }).click();
  // Nothing of COCO's on a white square.
  await expect(dialog).toContainText('見つかりませんでした', { timeout: 60_000 });
  await page.keyboard.press('Escape');

  // クリックで抽出: MobileSAM takes the white square in.
  await page.getByRole('button', { name: 'ツール' }).click();
  await page.locator('#ai-segment').click();
  const panel = page.locator('.ai-segment-panel');
  await expect(panel.locator('.ai-segment-note')).toContainText('準備ができました', { timeout: 60_000 });
  const box = (await page.locator('#map').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(panel.locator('.ai-segment-note')).toContainText('1 個を抽出しました', { timeout: 60_000 });
  const area = await page.evaluate(() => (window.viewer.aiSegment.outlines()[0].getGeometry() as import('ol/geom/Polygon.js').default).getArea());
  expect(area / (squareOnMap * squareOnMap)).toBeGreaterThan(0.9);
  expect(area / (squareOnMap * squareOnMap)).toBeLessThan(1.1);
  expect(errors).toEqual([]);
});
