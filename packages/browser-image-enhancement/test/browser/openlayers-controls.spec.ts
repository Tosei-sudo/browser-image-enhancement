import { expect, test, type Page } from '@playwright/test';

/*
 * The OpenLayers controls example (examples/openlayers-controls): the image
 * loading control and the correction panel, on images made in the page.
 */

declare global {
  interface Window {
    controlsExample: {
      map: import('ol/Map.js').default;
      layer: import('../../src/openlayers/gpu-layer.js').default;
      loader: import('../../src/openlayers/load-image-control.js').default;
      enhance: import('../../src/openlayers/enhance-control.js').default;
    };
  }
}

async function open(page: Page, query = '?fixture') {
  // The base map is not needed for these checks.
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort());
  await page.goto(`/.example-dist/openlayers-controls/index.html${query}`);
  await page.waitForFunction(() => window.controlsExample !== undefined);
  if (query.includes('fixture')) await page.waitForFunction(() => window.controlsExample.enhance.getSource()?.getState() === 'ready');
}

/** Sets the slider named `label` in the panel and waits for the next pipeline. */
async function slide(page: Page, label: string, value: string) {
  await page.evaluate(
    ([label, value]) => {
      const row = [...document.querySelectorAll('.ol-enhance-row')].find((r) => r.firstElementChild?.textContent === label)!;
      const input = row.querySelector('input')!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    },
    [label, value],
  );
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

const ops = (page: Page) => page.evaluate(() => window.controlsExample.enhance.getSource()!.getPipeline().ops.map((o) => ({ ...o })));

test('the panel builds the pipeline of the layer source from its sliders', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  expect(await ops(page)).toEqual([]); // neutral sliders add no step

  await slide(page, '露出 (EV)', '1');
  await slide(page, 'レベル 黒', '0.1');
  await slide(page, 'シャープ 量', '0.5');
  expect(await ops(page)).toEqual([
    { op: 'exposure', ev: 1 },
    { op: 'levels', inBlack: 0.1, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1 },
    { op: 'sharpen', amount: 0.5, radius: 1, threshold: 0 },
  ]);

  // Off, on again, then reset.
  await page.getByLabel('補正', { exact: true }).uncheck();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  expect(await ops(page)).toEqual([]);
  await page.getByLabel('補正', { exact: true }).check();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  expect((await ops(page)).length).toBe(3);
  await page.getByRole('button', { name: 'リセット' }).click();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  expect(await ops(page)).toEqual([]);

  // A preset moves the sliders.
  await page.evaluate(() => {
    const { enhance } = window.controlsExample;
    enhance.setPipeline(enhance.getPipeline().set('contrast', 0.25).autoStretch({ method: 'minMax' }));
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const row = (label: string) =>
    page.evaluate((label) => [...document.querySelectorAll('.ol-enhance-row')].find((r) => r.firstElementChild?.textContent === label)!.querySelector('input')!.value, label);
  expect(await row('コントラスト')).toBe('0.25');
  expect((await ops(page)).map((o) => o.op)).toEqual(['autoStretch', 'contrast']);
  expect(errors).toEqual([]);
});

test('DRA fixes the stretch from the visible area', async ({ page }) => {
  await open(page);
  await page.getByLabel('オン').check();
  await page.waitForFunction(() => window.controlsExample.enhance.getSource()!.getEffectivePipeline().ops[0]?.op === 'stretch');
  const info = await page.evaluate(() => window.controlsExample.enhance.getSource()!.getDraInfo());
  expect(info!.pixels).toBeGreaterThan(0);
});

test('the GPU layer redraws the map with the new pipeline', async ({ page }) => {
  await open(page);
  test.skip(!(await page.evaluate(() => window.controlsExample.layer.hasGpu())), 'WebGL2 with float render targets is not available in this browser');
  expect(await page.evaluate(() => window.controlsExample.enhance.getSource()!.correctsTiles())).toBe(false);
  const frames = await page.evaluate(() => window.controlsExample.layer.frames);
  await slide(page, '露出 (EV)', '1');
  await page.waitForFunction((frames) => window.controlsExample.layer.frames > frames, frames);
});

test('an ordinary picture is placed over the view and keeps the correction', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await slide(page, 'コントラスト', '0.4');

  // A gray PNG, 300×200, with a transparent corner.
  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 300;
    canvas.height = 200;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, 300, 0);
    g.addColorStop(0, '#000');
    g.addColorStop(1, '#fff');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 300, 200);
    ctx.clearRect(0, 0, 30, 30);
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));
    const { map, loader, enhance } = window.controlsExample;
    const viewExtent = map.getView().calculateExtent(map.getSize());
    const loaded = new Promise<string>((r) => loader.once('load' as 'change', (e) => r((e as unknown as { loaded: { kind: string } }).loaded.kind)));
    const source = await loader.loadFile(new File([blob], 'gradient.png', { type: 'image/png' }));
    const { extent } = await source.getView();
    return {
      kind: await loaded,
      same: enhance.getSource() === source,
      bands: source.getColorMode(),
      inView: extent![0] >= viewExtent[0] && extent![2] <= viewExtent[2] && extent![1] >= viewExtent[1] && extent![3] <= viewExtent[3],
      aspect: (extent![2] - extent![0]) / (extent![3] - extent![1]),
      ops: source.getPipeline().ops.map((o) => o.op),
    };
  });
  expect(result.kind).toBe('image');
  expect(result.same).toBe(true);
  expect(result.bands).toBe('gray');
  expect(result.inView).toBe(true);
  expect(result.aspect).toBeCloseTo(1.5, 5);
  expect(result.ops).toEqual(['contrast']);
  // Color-only sliders are hidden for a gray image.
  await expect(page.getByText('彩度', { exact: true })).toBeHidden();
  await expect(page.getByText('明るさ', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a file that cannot be read reports an error and keeps the current image', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const { loader, layer } = window.controlsExample;
    const before = layer.getSource();
    let reported = '';
    loader.once('error' as 'change', (e) => (reported = (e as unknown as { name: string }).name));
    const failed = await loader.loadFile(new File([new Uint8Array([1, 2, 3, 4, 5])], 'broken.png', { type: 'image/png' })).then(
      () => false,
      () => true,
    );
    return { failed, reported, kept: layer.getSource() === before };
  });
  expect(result).toEqual({ failed: true, reported: 'broken.png', kept: true });
});

test('a URL that cannot be read reports an error instead of waiting forever', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const { loader, layer } = window.controlsExample;
    const before = layer.getSource();
    const url = new URL('/missing.tif', location.href).href;
    const failed = await Promise.race([
      loader.loadUrl(url).then(() => 'loaded', () => 'failed'),
      new Promise((r) => setTimeout(() => r('timeout'), 10_000)),
    ]);
    return { failed, busy: loader.isLoading(), kept: layer.getSource() === before };
  });
  expect(result).toEqual({ failed: 'failed', busy: false, kept: true });
});

test('the band selects assign bands of a multiband image to R, G and B', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.text().startsWith('[browser-image-enhancement]') && errors.push(m.text()));
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort());
  await page.goto('/.example-dist/openlayers-controls/index.html?fixture=multiband');
  await page.waitForFunction(() => window.controlsExample?.enhance.getSource()?.getState() === 'ready');

  /** The first pixel of tile 0/0/0 as the layer gets it: the bands OpenLayers draws. */
  const pixel = () =>
    page.evaluate(async () => {
      const source = window.controlsExample.enhance.getSource() as import('../../src/openlayers/enhanced-geotiff.js').default;
      const z = source.getTileGrid()!.getMinZoom();
      const tile = source.getTile(z, 0, 0, 1, source.getProjection()!)!;
      tile.load();
      await new Promise<void>((r) => {
        const done = () => tile.getState() >= 2;
        if (done()) r();
        else tile.addEventListener('change', () => done() && r());
      });
      const t = tile as unknown as { getData(): Uint8Array; getSize(): [number, number] };
      const data = t.getData();
      const bands = data.length / (t.getSize()[0] * t.getSize()[1]);
      // The top left pixel: bands 1 and 2 are 0 there.
      return { bands, values: [...data.slice(0, 4)] };
    });

  const bandSet = page.locator('.ol-enhance-bands');
  await expect(bandSet).toBeVisible();
  const r = bandSet.getByLabel('R（赤）');
  await expect(r.locator('option')).toHaveCount(5);
  await expect(r.locator('option').nth(4)).toHaveText('バンド 5');
  // More than 4 bands: bands 1, 2, 3 by default.
  expect(await page.evaluate(() => window.controlsExample.enhance.getSource()!.getSelect())).toEqual([0, 1, 2]);
  expect(await r.inputValue()).toBe('0');
  expect((await pixel()).values).toEqual([0, 0, 40, 255]);

  // Bands 5, 4, 3 as R, G, B.
  await r.selectOption('4');
  await bandSet.getByLabel('G（緑）').selectOption('3');
  await bandSet.getByLabel('B（青）').selectOption('2');
  expect(await page.evaluate(() => window.controlsExample.enhance.getSource()!.getSelect())).toEqual([4, 3, 2]);
  const after = await pixel();
  expect(after.bands).toBe(5);
  expect(after.values).toEqual([220, 120, 40, 255]);
  expect(await page.evaluate(() => window.controlsExample.enhance.getSource()!.getColorMode())).toBe('rgb');

  // One band in all three is gray: color-only sliders hide.
  await bandSet.getByLabel('G（緑）').selectOption('4');
  await bandSet.getByLabel('B（青）').selectOption('4');
  expect(await page.evaluate(() => window.controlsExample.enhance.getSource()!.getColorMode())).toBe('gray');
  expect((await pixel()).values).toEqual([220, 220, 220, 255]);
  await expect(page.getByText('彩度', { exact: true })).toBeHidden();

  // DRA follows the new bands: a flat band stretches to a fixed range.
  await page.getByLabel('オン').check();
  await page.waitForFunction(() => window.controlsExample.enhance.getSource()!.getEffectivePipeline().ops[0]?.op === 'stretch');
  expect(errors).toEqual([]);
});

test('an RGB image is drawn as read until bands are chosen; a gray one has no band selects', async ({ page }) => {
  await open(page);
  await expect(page.locator('.ol-enhance-bands')).toBeVisible();
  expect(await page.evaluate(() => window.controlsExample.enhance.getSource()!.getSelect())).toBeNull();
  await page.locator('.ol-enhance-bands').getByLabel('R（赤）').selectOption('2');
  expect(await page.evaluate(() => window.controlsExample.enhance.getSource()!.getSelect())).toEqual([2, 1, 2]);

  // A gray picture: one band, nothing to assign.
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#888';
    ctx.fillRect(0, 0, 64, 64);
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));
    await window.controlsExample.loader.loadFile(new File([blob], 'gray.png', { type: 'image/png' }));
  });
  await expect(page.locator('.ol-enhance-bands')).toBeHidden();
});
