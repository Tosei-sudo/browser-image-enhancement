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
