import { expect, test, type Page } from '@playwright/test';

/*
 * The OpenLayers + COG example (examples/openlayers-cog), built with Vite, on a
 * GeoTIFF generated in the page so no network is needed.
 */

declare global {
  interface Window {
    example: {
      map: import('ol/Map.js').default;
      layer: import('../../src/openlayers/gpu-layer.js').default;
      source: import('../../src/openlayers/enhanced-geotiff.js').default;
      inputs: Record<string, HTMLInputElement>;
      pipeline: typeof import('../../src/index.js').pipeline;
      fitLonLat: (extent: number[]) => void;
    };
  }
}

async function open(page: Page, query = '&engine=worker') {
  // The base map is not needed for these checks.
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort());
  await page.goto(`/.example-dist/openlayers-cog/index.html?fixture${query}`);
  await page.waitForFunction(() => window.example?.source?.getState() === 'ready');
  await settle(page);
}

/** Waits until every visible tile has been loaded and drawn. */
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        window.example.map.once('rendercomplete', () => resolve());
        window.example.map.render();
      }),
  );
}

/** Tile data under a map pixel, as the WebGL layer holds it (after correction). */
function sample(page: Page, x: number, y: number) {
  return page.evaluate(([x, y]) => Array.from(window.example.layer.getData([x, y]) as Uint8Array), [x, y]);
}

test('tiles are corrected with the pipeline and re-corrected when it changes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);

  const [w, h] = await page.evaluate(() => window.example.map.getSize()!);
  const points: Array<[number, number]> = [
    [w * 0.5, h * 0.5],
    [w * 0.3, h * 0.45],
    [w * 0.7, h * 0.55],
  ];

  // Switch correction off to read the raw tile values.
  await page.evaluate(() => {
    (document.getElementById('enabled') as HTMLInputElement).click();
  });
  await page.waitForTimeout(50);
  await settle(page);
  const raw = await Promise.all(points.map(([x, y]) => sample(page, x, y)));
  for (const px of raw) expect(px.length).toBe(4); // RGB + alpha added by OpenLayers

  // Back on, with exposure +1 and warmer color.
  await page.evaluate(() => {
    (document.getElementById('enabled') as HTMLInputElement).click();
    const { inputs } = window.example;
    inputs.exposure.value = '1';
    inputs.temperature.value = '0.5';
    inputs.exposure.dispatchEvent(new Event('input'));
  });
  await page.waitForTimeout(50);
  await settle(page);
  const corrected = await Promise.all(points.map(([x, y]) => sample(page, x, y)));

  const expected = await page.evaluate(
    (raw) =>
      raw.map((px) => {
        const data = new Uint8ClampedArray(px);
        const out = window.example
          .pipeline()
          .exposure(1)
          .brightness(0)
          .contrast(0)
          .gamma(1)
          .levels({ inBlack: 0, inWhite: 1, gamma: 1 })
          .temperature(0.5)
          .saturation(0)
          .runSync({ data, width: 1, height: 1 }, { colorMode: 'rgb' });
        return Array.from(out.data);
      }),
    raw,
  );

  for (let i = 0; i < points.length; i++) {
    expect(corrected[i]).not.toEqual(raw[i]);
    // Reprojection to Web Mercator resamples after correction, so allow a little slack.
    for (let c = 0; c < 4; c++) expect(Math.abs(corrected[i][c] - expected[i][c])).toBeLessThanOrEqual(3);
  }

  const stats = await page.evaluate(() => ({ ...window.example.source.stats }));
  expect(stats.tiles).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('changing the pipeline re-corrects cached tiles without reading the COG again', async ({ page }) => {
  await open(page);
  const before = await page.evaluate(() => ({ ...window.example.source.stats }));
  expect(before.reads).toBeGreaterThan(0);

  for (const ev of ['0.5', '1', '1.5']) {
    await page.evaluate((ev) => {
      window.example.inputs.exposure.value = ev;
      window.example.inputs.exposure.dispatchEvent(new Event('input'));
    }, ev);
    await page.waitForTimeout(50);
    await settle(page);
  }

  const after = await page.evaluate(() => ({ ...window.example.source.stats }));
  expect(after.reads).toBe(before.reads);
  expect(after.tiles).toBeGreaterThan(0); // reset on each change, so these are the latest re-corrections
});

test('sharpening corrects tiles with their neighbours as margin', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  const [w, h] = await page.evaluate(() => window.example.map.getSize()!);
  // A line across the fixture's stripes (an edge every 48 image pixels): sharpening shows next to them.
  const points = Array.from({ length: 40 }, (_, i): [number, number] => [w * (0.2 + i * 0.015), h * 0.5]);
  const before = await Promise.all(points.map(([x, y]) => sample(page, x, y)));

  await page.evaluate(() => {
    const { inputs } = window.example;
    inputs.sharpen.value = '2';
    inputs.sharpenRadius.value = '2';
    inputs.sharpen.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => window.example.source.getEffectivePipeline().margin === 6);
  await page.waitForTimeout(50);
  await settle(page);
  const stats = await page.evaluate(() => ({ ...window.example.source.stats }));
  expect(stats.tiles).toBeGreaterThan(0);
  const after = await Promise.all(points.map(([x, y]) => sample(page, x, y)));
  for (const px of after) expect(px.length).toBe(4);
  expect(after).not.toEqual(before);
  expect(errors).toEqual([]);
});

/** RGBA of the map's COG layer as shown on screen, at CSS pixels `points`. */
function shown(page: Page, points: Array<[number, number]>) {
  return page.evaluate((points) => {
    const canvas = document.querySelector<HTMLCanvasElement>('.ol-layers canvas.gpu-corrected')!;
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const ctx = copy.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(canvas, 0, 0);
    const ratio = canvas.width / canvas.clientWidth;
    return points.map(([x, y]) => Array.from(ctx.getImageData(Math.floor(x * ratio), Math.floor(y * ratio), 1, 1).data));
  }, points);
}

/** Sets sliders and waits until the map is drawn with them. */
async function setSliders(page: Page, values: Record<string, string>) {
  await page.evaluate((values) => {
    const { inputs } = window.example;
    for (const [k, v] of Object.entries(values)) inputs[k].value = v;
    inputs.exposure.dispatchEvent(new Event('input'));
  }, values);
  await page.waitForTimeout(50);
  await settle(page);
}

test('the GPU corrects the drawn map without reloading tiles, matching corrected tiles', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const corrections = { exposure: '0.7', contrast: '0.3', temperature: '-0.4', saturation: '0.5' };
  const [w, h] = [800, 600];
  await page.setViewportSize({ width: w + 320, height: h });
  const points = Array.from({ length: 30 }, (_, i): [number, number] => [w * (0.2 + i * 0.02), h * (0.3 + (i % 5) * 0.1)]);

  await open(page, '&engine=gpu');
  test.skip(!(await page.evaluate(() => window.example.layer.hasGpu())), 'WebGL2 with float render targets is not available in this browser');
  expect(await page.evaluate(() => window.example.source.correctsTiles())).toBe(false);
  const raw = await shown(page, points);
  const reads = await page.evaluate(() => window.example.source.stats.reads);
  await setSliders(page, corrections);
  const gpu = await shown(page, points);
  const after = await page.evaluate(() => ({ ...window.example.source.stats, frames: window.example.layer.frames }));
  expect(after.reads).toBe(reads); // no tile read again
  expect(after.tiles).toBe(0); // and none corrected: the map was only redrawn
  expect(after.frames).toBeGreaterThan(0);
  expect(gpu).not.toEqual(raw);

  // Tiles corrected in Workers, then drawn: per-pixel steps give the same picture
  // (up to resampling, which happens before the correction on the GPU and after it here).
  await open(page, '&engine=worker');
  await setSliders(page, corrections);
  const js = await shown(page, points);
  for (let i = 0; i < points.length; i++) {
    for (let c = 0; c < 4; c++) expect(Math.abs(gpu[i][c] - js[i][c])).toBeLessThanOrEqual(2);
  }
  expect(errors).toEqual([]);
});

test('the GPU layer recovers from a lost WebGL context', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page, '&engine=gpu');
  test.skip(!(await page.evaluate(() => window.example.layer.hasGpu())), 'WebGL2 is not available');
  const [w, h] = await page.evaluate(() => window.example.map.getSize()!);
  const points = Array.from({ length: 20 }, (_, i): [number, number] => [w * (0.2 + i * 0.03), h * 0.5]);
  const raw = await shown(page, points);
  await setSliders(page, { exposure: '0.7', saturation: '0.5' });
  const corrected = await shown(page, points);

  await page.evaluate(() => {
    const gl = window.example.layer.getOutputCanvas().getContext('webgl2')!;
    (window as unknown as { loser: WEBGL_lose_context }).loser = gl.getExtension('WEBGL_lose_context')!;
    (window as unknown as { loser: WEBGL_lose_context }).loser.loseContext();
  });
  await page.waitForFunction(() => !window.example.layer.hasGpu());
  await page.evaluate(() => (window as unknown as { loser: WEBGL_lose_context }).loser.restoreContext());
  await page.waitForFunction(() => window.example.layer.hasGpu());
  await settle(page);
  // Corrected again (the redrawn map may differ by a level or so from the first drawing).
  const restored = await shown(page, points);
  expect(restored).not.toEqual(raw);
  for (let i = 0; i < points.length; i++) {
    for (let c = 0; c < 4; c++) expect(Math.abs(restored[i][c] - corrected[i][c])).toBeLessThanOrEqual(4);
  }
  expect(errors).toEqual([]);
});

test('the GPU layer sharpens the drawn map and follows DRA', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page, '&engine=gpu');
  test.skip(!(await page.evaluate(() => window.example.layer.hasGpu())), 'WebGL2 is not available');
  const [w, h] = await page.evaluate(() => window.example.map.getSize()!);
  const points = Array.from({ length: 40 }, (_, i): [number, number] => [w * (0.2 + i * 0.015), h * 0.5]);
  const before = await shown(page, points);
  await setSliders(page, { sharpen: '2', sharpenRadius: '2' });
  const sharpened = await shown(page, points);
  expect(sharpened).not.toEqual(before);

  await setSliders(page, { sharpen: '0' });
  await enableDra(page, 'minMax');
  const stretched = await shown(page, points);
  expect(stretched).not.toEqual(before);
  expect(await page.evaluate(() => window.example.source.stats.tiles)).toBe(0);
  expect(errors).toEqual([]);
});

/** Fixture pixel values (see examples/openlayers-cog/fixture.ts). */
const FX = { width: 768, height: 384, extent: [139.6, 35.6, 139.9, 35.75] };
const stripe = (x: number) => (Math.floor(x / 48) % 2 === 0 ? 0 : 24);
const fixtureR = (x: number) => Math.round((x / (FX.width - 1)) * 200) + stripe(x);
const fixtureG = (x: number, y: number) => Math.round((y / (FX.height - 1)) * 200) + stripe(x);

/** Turns DRA on with the given method and waits until its statistics are in and drawn. */
async function enableDra(page: Page, method: string) {
  await page.evaluate((method) => {
    (document.getElementById('draMethod') as HTMLSelectElement).value = method;
    (document.getElementById('dra') as HTMLInputElement).click();
  }, method);
  await page.waitForFunction(() => window.example.source.getEffectivePipeline().ops.some((op) => op.op === 'stretch'));
  await settle(page);
}

/** Moves the view to show `extent` (EPSG:4326) and waits for new DRA statistics. */
async function showExtent(page: Page, extent: number[]) {
  const before = await page.evaluate(() => JSON.stringify(window.example.source.getDraInfo()));
  await page.evaluate((extent) => window.example.fitLonLat(extent), extent);
  await page.waitForFunction((before) => JSON.stringify(window.example.source.getDraInfo()) !== before, before);
  await settle(page);
}

function stretchOp(page: Page) {
  return page.evaluate(() => {
    const op = window.example.source.getEffectivePipeline().ops.find((o) => o.op === 'stretch');
    return op && op.op === 'stretch' ? { black: op.black, white: op.white } : null;
  });
}

test('DRA stretches to the visible area and follows the view', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  const readsBefore = await page.evaluate(() => window.example.source.stats.reads);
  await enableDra(page, 'minMax');

  // Whole image visible: R and G span the fixture's full range, B (constant 120) is left alone.
  const whole = (await stretchOp(page))!;
  expect(whole.black[0] * 255).toBeCloseTo(0, 6);
  expect(whole.white[0] * 255).toBeCloseTo(224, 6);
  expect(whole.black[1] * 255).toBeCloseTo(0, 6);
  expect(whole.white[1] * 255).toBeCloseTo(224, 6);
  expect([whole.black[2], whole.white[2]]).toEqual([0, 1]);

  // Zoom into the left-bottom part: the range shrinks to what is on screen, computed from the fixture itself.
  await showExtent(page, [139.62, 35.61, 139.7, 35.66]);
  const info = (await page.evaluate(() => window.example.source.getDraInfo()))!;
  const px = (lon: number) => ((lon - FX.extent[0]) / (FX.extent[2] - FX.extent[0])) * FX.width;
  const py = (lat: number) => ((FX.extent[3] - lat) / (FX.extent[3] - FX.extent[1])) * FX.height;
  const cols = range(Math.floor(px(info.extent[0])), Math.ceil(px(info.extent[2])));
  const rows = range(Math.floor(py(info.extent[3])), Math.ceil(py(info.extent[1])));
  const rs = cols.map(fixtureR);
  const gs = cols.flatMap((x) => rows.map((y) => fixtureG(x, y)));
  const zoomed = (await stretchOp(page))!;
  expect(zoomed.black[0] * 255).toBeCloseTo(Math.min(...rs), 6);
  expect(zoomed.white[0] * 255).toBeCloseTo(Math.max(...rs), 6);
  expect(zoomed.black[1] * 255).toBeCloseTo(Math.min(...gs), 6);
  expect(zoomed.white[1] * 255).toBeCloseTo(Math.max(...gs), 6);
  expect(zoomed.white[0]).toBeLessThan(whole.white[0]);

  // Every visible tile is corrected with that one range: samples across the view match it (no per-tile ranges).
  const [w, h] = await page.evaluate(() => window.example.map.getSize()!);
  const points: Array<[number, number]> = [[w * 0.2, h * 0.2], [w * 0.5, h * 0.5], [w * 0.8, h * 0.8], [w * 0.8, h * 0.2]];
  const corrected = await Promise.all(points.map(([x, y]) => sample(page, x, y)));
  await page.evaluate(() => (document.getElementById('enabled') as HTMLInputElement).click());
  await page.waitForTimeout(50);
  await settle(page);
  const raw = await Promise.all(points.map(([x, y]) => sample(page, x, y)));
  const expected = await page.evaluate(
    ([raw, s]) =>
      raw.map((px) => Array.from(window.example.pipeline().stretch(s!).runSync({ data: new Uint8ClampedArray(px), width: 1, height: 1 }, { colorMode: 'rgb' }).data)),
    [raw, zoomed] as const,
  );
  expect(corrected).not.toEqual(raw);
  for (let i = 0; i < points.length; i++) {
    for (let c = 0; c < 3; c++) expect(Math.abs(corrected[i][c] - expected[i][c])).toBeLessThanOrEqual(3);
  }
  await page.evaluate(() => (document.getElementById('enabled') as HTMLInputElement).click());

  // Back to the whole image: the range comes back. Statistics reuse cached raw tiles.
  await showExtent(page, FX.extent);
  expect(await stretchOp(page)).toEqual(whole);
  const reads = await page.evaluate(() => window.example.source.stats.reads);
  expect(reads).toBe(readsBefore);

  // DRA off: no stretch left in the pipeline.
  await page.evaluate(() => (document.getElementById('dra') as HTMLInputElement).click());
  await page.waitForFunction(() => !window.example.source.getEffectivePipeline().ops.some((op) => op.op === 'stretch'));
  expect(errors).toEqual([]);
});

test('DRA statistics count only the image, not the empty map around it', async ({ page }) => {
  await open(page);
  await enableDra(page, 'minMax');
  // A view much larger than the image: the counted area is clipped to the image, so the range is unchanged.
  const whole = await stretchOp(page);
  await page.evaluate(() => window.example.map.getView().setZoom(window.example.map.getView().getZoom()! - 2));
  await page.waitForFunction(() => {
    const e = window.example.source.getDraInfo()!.extent;
    return e[0] <= 139.6 + 1e-9 && e[2] >= 139.9 - 1e-9;
  });
  expect(await stretchOp(page)).toEqual(whole);
});

function range(a: number, b: number): number[] {
  return Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
}

test('16-bit raw values on the GPU: tiles hold the raw stretch, DRA stretches the raw values', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page, '16');
  const [w, h] = await page.evaluate(() => window.example.map.getSize()!);
  const gpu = await page.evaluate(() => window.example.layer.hasGpu());
  expect(await page.evaluate(() => window.example.source.correctsTiles())).toBe(!gpu);

  // Without DRA: the whole image's statistics, band by band.
  const whole = await page.evaluate(() => window.example.source.getDraInfo()!.rawStretch!);
  expect(whole.black[0]).toBeGreaterThanOrEqual(3000);
  expect(whole.white[0]).toBeLessThanOrEqual(7480);
  const left = await sample(page, w * 0.3, h * 0.5);
  const right = await sample(page, w * 0.7, h * 0.5);
  expect(right[0] - left[0]).toBeGreaterThan(60);

  // DRA on: its options stretch the raw values, and the 8-bit pipeline has no autoStretch left.
  await page.evaluate(async () => {
    const { source, map } = window.example;
    source.setPipeline(source.getPipeline().autoStretch({ lowPercent: 20, highPercent: 20 }));
    await source.updateDra(map);
  });
  await settle(page);
  const dra = await page.evaluate(() => window.example.source.getDraInfo()!.rawStretch!);
  expect(dra.black[0]).toBeGreaterThan(whole.black[0]);
  expect(dra.white[0]).toBeLessThan(whole.white[0]);
  expect(await page.evaluate(() => window.example.source.getEffectivePipeline().get('autoStretch'))).toBeUndefined();
  const contrasty = await sample(page, w * 0.7, h * 0.5);
  expect(contrasty[0]).toBeGreaterThan(right[0]);

  // DRA off again: back to the whole image's stretch.
  await page.evaluate(() => {
    const { source } = window.example;
    source.setPipeline(source.getPipeline().remove('autoStretch'));
  });
  await settle(page);
  expect(await sample(page, w * 0.7, h * 0.5)).toEqual(right);
  expect(errors).toEqual([]);
});

test('16-bit raw values (normalize: false) are stretched from their own statistics, then corrected', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page, '16&engine=worker');
  const [w, h] = await page.evaluate(() => window.example.map.getSize()!);

  // Corrections off: only the raw stretch.
  await page.evaluate(() => (document.getElementById('enabled') as HTMLInputElement).click());
  await page.waitForTimeout(50);
  await settle(page);
  const left = await sample(page, w * 0.3, h * 0.5);
  const right = await sample(page, w * 0.7, h * 0.5);
  const info = await page.evaluate(() => window.example.source.getDraInfo());
  expect(info?.rawStretch).toBeDefined();
  // The fixture's red runs from 3000 to 7480 (16-bit); the stretch covers about that, not 0-65535.
  expect(info!.rawStretch!.black[0]).toBeGreaterThanOrEqual(3000);
  expect(info!.rawStretch!.white[0]).toBeLessThanOrEqual(7480);
  expect(info!.rawStretch!.white[0]).toBeGreaterThan(6000);
  // Red rises from left to right and uses the 8-bit range (a 0-65535 scale would leave it near 20-30).
  expect(right[0] - left[0]).toBeGreaterThan(60);
  expect(left[3]).toBe(255);

  // Corrections on: exposure applies on top of the stretched values.
  await page.evaluate(() => {
    (document.getElementById('enabled') as HTMLInputElement).click();
    window.example.inputs.exposure.value = '1';
    window.example.inputs.exposure.dispatchEvent(new Event('input'));
  });
  await page.waitForTimeout(50);
  await settle(page);
  const brighter = await sample(page, w * 0.3, h * 0.5);
  expect(brighter[0]).toBeGreaterThan(left[0]);
  expect(errors).toEqual([]);
});

test('tiles reprojected on the CPU match OpenLayers’ WebGL reprojection', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // The fixture is in EPSG:4326 on a Web Mercator map, so every tile is reprojected.
  const pixel = (x: number, y: number) =>
    page.evaluate(([x, y]) => {
      const data = window.example.layer.getData([x, y]) as Uint8Array | null;
      return data ? Array.from(data) : [];
    }, [x, y]);
  const read = async (query: string) => {
    await open(page, `${query}&engine=worker`);
    const [w, h] = await page.evaluate(() => window.example.map.getSize()!);
    const values: number[][] = [];
    for (const zoom of [0, 1.5, 3]) {
      if (zoom) {
        await page.evaluate((z) => window.example.map.getView().setZoom(window.example.map.getView().getZoom()! + z), zoom);
        await settle(page);
      }
      // A grid over the map: inside the image, across its edges and outside it.
      for (let y = 0.05; y < 1; y += 0.1) for (let x = 0.05; x < 1; x += 0.1) values.push(await pixel(Math.round(w * x), Math.round(h * y)));
    }
    return values;
  };
  const gl = await read('&glReprojection');
  const cpu = await read('');
  expect(cpu.length).toBe(gl.length);
  let inside = 0;
  for (let i = 0; i < gl.length; i++) {
    expect(cpu[i].length, `point ${i}`).toBe(gl[i].length);
    if (gl[i].length) inside++;
    // Bilinear on both; the GPU rounds its 8-bit result once more.
    for (let k = 0; k < gl[i].length; k++) expect(Math.abs(cpu[i][k] - gl[i][k]), `point ${i} band ${k}`).toBeLessThanOrEqual(1);
  }
  expect(inside).toBeGreaterThan(50);
  expect(errors).toEqual([]);
});
