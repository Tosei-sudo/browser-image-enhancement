import { expect, test, type Page } from '@playwright/test';

/*
 * Runs the built package (dist/) in a real browser: module workers, transfer,
 * canvas/Blob I/O, color space conversion, and fallbacks.
 */

declare global {
  interface Window {
    lib: typeof import('../../src/index.js');
    ready: boolean;
    /** Set by the bundled consumer fixture (test/browser/bundled). */
    bundledResult: Promise<{ workers: number; same: boolean }>;
    helpers: {
      noise(w: number, h: number, seed?: number): ImageData;
      gray(w: number, h: number, seed?: number): ImageData;
      same(a: ArrayLike<number>, b: ArrayLike<number>): boolean;
      workersCreated(): number;
      full(): import('../../src/index.js').Pipeline;
    };
  }
}

async function open(page: Page, path = '/test/browser/index.html') {
  await page.goto(path);
  await page.waitForFunction(() => window.ready === true);
  await page.evaluate(() => {
    let created = 0;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        created++;
      }
    };
    const rand = (seed: number) => () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    window.helpers = {
      noise(w, h, seed = 1) {
        const r = rand(seed);
        const d = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < d.length; i++) d[i] = (i & 3) === 3 ? 255 : Math.floor(r() * 256);
        return new ImageData(d, w, h);
      },
      gray(w, h, seed = 1) {
        const r = rand(seed);
        const d = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < d.length; i += 4) {
          const v = Math.floor(r() * 256);
          d[i] = d[i + 1] = d[i + 2] = v;
          d[i + 3] = 255;
        }
        return new ImageData(d, w, h);
      },
      same(a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
      },
      workersCreated: () => created,
      full: () =>
        window.lib
          .pipeline()
          .brightness(0.1)
          .contrast(0.2)
          .exposure(0.3)
          .gamma(1.1)
          .saturation(0.3)
          .temperature(0.2)
          .levels({ inBlack: 0.03, inWhite: 0.97, gamma: 1.1 }),
    };
  });
}

test.beforeEach(async ({ page }) => {
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[browser]', m.text());
  });
  await open(page);
});

test('workers produce exactly the main-thread result, split into strips', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { lib, helpers } = window;
    lib.configureWorkers({ maxWorkers: 4 });
    const img = helpers.noise(1024, 1024, 3);
    const before = img.data.slice();
    const p = helpers.full();
    const viaWorker = await p.run(img);
    const viaMain = await p.run(img, { worker: false });
    return {
      same: helpers.same(viaWorker.data, viaMain.data),
      sync: helpers.same(viaWorker.data, p.runSync(img).data),
      workers: helpers.workersCreated(),
      inputIntact: helpers.same(img.data, before),
      isImageData: viaWorker instanceof ImageData,
      size: [viaWorker.width, viaWorker.height],
    };
  });
  expect(r.workers).toBe(4);
  expect(r.same).toBe(true);
  expect(r.sync).toBe(true);
  expect(r.inputIntact).toBe(true);
  expect(r.isImageData).toBe(true);
  expect(r.size).toEqual([1024, 1024]);
});

test('autoStretch in workers: one range for the whole image, same as the main thread', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { lib, helpers } = window;
    lib.configureWorkers({ maxWorkers: 4 });
    // Dark top half, bright bottom half: strips stretching on their own would disagree.
    const img = helpers.noise(1024, 1024, 7);
    for (let i = 0; i < img.data.length; i += 4) {
      const bright = i >= img.data.length / 2;
      for (let c = 0; c < 3; c++) img.data[i + c] = (bright ? 128 : 0) + (img.data[i + c] >> 2);
    }
    const p = lib.pipeline().exposure(0.3).autoStretch({ lowPercent: 1, highPercent: 1 }).saturation(0.2);
    const viaWorker = await p.run(img);
    const viaMain = await p.run(img, { worker: false });
    const resolved = p.resolve(lib.histogram(img)).runSync(img);
    const gray = helpers.gray(300, 300, 2);
    const grayWorker = await p.run(gray);
    return {
      same: helpers.same(viaWorker.data, viaMain.data),
      resolved: helpers.same(viaWorker.data, resolved.data),
      workers: helpers.workersCreated(),
      graySame: helpers.same(grayWorker.data, p.runSync(gray).data),
    };
  });
  expect(r.workers).toBe(4);
  expect(r.same).toBe(true);
  expect(r.resolved).toBe(true);
  expect(r.graySame).toBe(true);
});

test('sharpen in workers: strips with a margin give exactly the main-thread result', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { lib, helpers } = window;
    lib.configureWorkers({ maxWorkers: 4 });
    const img = helpers.noise(1024, 1024, 5);
    const p = lib.pipeline().exposure(0.2).sharpen({ amount: 1.2, radius: 2 }).saturation(0.2).sharpen({ amount: 0.5, radius: 0.7 });
    const viaWorker = await p.run(img);
    const viaMain = await p.run(img, { worker: false });
    const gray = helpers.gray(500, 700, 3);
    const grayWorker = await p.run(gray);

    // Timing on 12 MP, for the log.
    const big = helpers.noise(4000, 3000, 2);
    const one = lib.pipeline().sharpen({ amount: 1, radius: 1 });
    let t0 = performance.now();
    await one.run(big, { worker: false });
    const mainMs = Math.round(performance.now() - t0);
    t0 = performance.now();
    await one.run(big);
    const workerMs = Math.round(performance.now() - t0);
    return {
      same: helpers.same(viaWorker.data, viaMain.data),
      changed: !helpers.same(viaWorker.data, img.data),
      workers: helpers.workersCreated(),
      graySame: helpers.same(grayWorker.data, p.runSync(gray).data),
      mainMs,
      workerMs,
    };
  });
  console.log(`12MP sharpen (radius 1): main thread ${r.mainMs} ms, workers ${r.workerMs} ms`);
  expect(r.workers).toBe(4);
  expect(r.changed).toBe(true);
  expect(r.same).toBe(true);
  expect(r.graySame).toBe(true);
});

test('monochrome images are detected across strips and stay gray', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { lib, helpers } = window;
    lib.configureWorkers({ maxWorkers: 4 });
    const img = helpers.gray(800, 800, 7);
    const p = helpers.full();
    const out = await p.run(img);
    let gray = true;
    for (let i = 0; i < out.data.length; i += 4) if (out.data[i] !== out.data[i + 1] || out.data[i] !== out.data[i + 2]) gray = false;
    const main = await p.run(img, { worker: false });
    // One colored pixel at the very end switches the whole image to color mode.
    img.data[img.data.length - 4] = 255;
    img.data[img.data.length - 3] = 0;
    const colored = await p.run(img);
    const coloredMain = await p.run(img, { worker: false });
    return {
      gray,
      same: helpers.same(out.data, main.data),
      tinted: colored.data[0] !== colored.data[2],
      coloredSame: helpers.same(colored.data, coloredMain.data),
      workers: helpers.workersCreated(),
    };
  });
  expect(r.workers).toBeGreaterThan(1);
  expect(r.gray).toBe(true);
  expect(r.same).toBe(true);
  expect(r.tinted).toBe(true);
  expect(r.coloredSame).toBe(true);
});

test('accepts canvas, ImageBitmap, OffscreenCanvas, <img> and Blob inputs', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { lib, helpers } = window;
    const src = helpers.noise(64, 48, 5);
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 48;
    canvas.getContext('2d')!.putImageData(src, 0, 0);
    const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/png'));
    const bitmap = await createImageBitmap(src);
    const off = new OffscreenCanvas(64, 48);
    off.getContext('2d')!.putImageData(src, 0, 0);
    const img = new Image();
    img.src = URL.createObjectURL(blob);

    const p = lib.pipeline().contrast(0.3).saturation(0.2);
    const expected = p.runSync(src).data;
    const results: Record<string, boolean> = {};
    for (const [name, input] of Object.entries({ canvas, blob, bitmap, off, img })) {
      results[name] = helpers.same((await p.run(input as any)).data, expected);
    }
    return results;
  });
  expect(r).toEqual({ canvas: true, blob: true, bitmap: true, off: true, img: true });
});

test('outputs canvas, Blob (png/webp) and gray', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { lib, helpers } = window;
    const src = helpers.noise(40, 30, 9);
    const p = lib.pipeline().brightness(0.2).temperature(0.3);
    const expected = p.runSync(src);

    const canvas = await p.run(src, { output: 'canvas' });
    const fromCanvas = (canvas as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 40, 30).data;

    const png = await p.run(src, { output: 'blob' });
    const decoded = await createImageBitmap(png);
    const c2 = new OffscreenCanvas(40, 30);
    const ctx = c2.getContext('2d')!;
    ctx.drawImage(decoded, 0, 0);
    const fromPng = ctx.getImageData(0, 0, 40, 30).data;

    const webp = await p.run(src, { output: 'blob', type: 'image/webp', quality: 0.8 });
    const gray = await p.run(helpers.gray(10, 10), { output: 'gray' });

    return {
      isCanvas: canvas instanceof HTMLCanvasElement,
      canvasSame: helpers.same(fromCanvas, expected.data),
      pngType: png.type,
      pngSame: helpers.same(fromPng, expected.data),
      webpType: webp.type,
      grayLength: gray.data.length,
      grayIsClamped: gray.data instanceof Uint8ClampedArray,
    };
  });
  expect(r.isCanvas).toBe(true);
  expect(r.canvasSame).toBe(true);
  expect(r.pngType).toBe('image/png');
  expect(r.pngSame).toBe(true);
  expect(r.webpType).toBe('image/webp');
  expect(r.grayLength).toBe(100);
  expect(r.grayIsClamped).toBe(true);
});

test('Display P3 ImageData is converted to sRGB by the pipeline', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { lib } = window;
    const d = new Uint8ClampedArray(2 * 4);
    d.set([128, 128, 128, 255, 255, 0, 0, 255]);
    const p3 = new ImageData(d, 2, 1, { colorSpace: 'display-p3' });
    const out = await lib.pipeline().run(p3);
    let threw = '';
    try {
      lib.brightness(p3, 0.1);
    } catch (e) {
      threw = (e as Error).message;
    }
    return { colorSpace: out.colorSpace, px: Array.from(out.data), threw };
  });
  expect(r.colorSpace).toBe('srgb');
  // P3 gray is sRGB gray; P3 red is outside sRGB and comes out as saturated red.
  expect(r.px[0]).toBe(r.px[1]);
  expect(r.px[1]).toBe(r.px[2]);
  expect(Math.abs(r.px[0] - 128)).toBeLessThanOrEqual(1);
  expect(r.px[4]).toBe(255);
  expect(r.px[5]).toBeLessThan(10);
  expect(r.threw).toMatch(/pipeline/);
});

test('falls back to the main thread when a CSP forbids workers', async ({ page }) => {
  await open(page, '/test/browser/csp.html');
  const r = await page.evaluate(async () => {
    const { helpers } = window;
    const img = helpers.noise(300, 300, 4);
    const p = helpers.full();
    const out = await p.run(img);
    return helpers.same(out.data, p.runSync(img).data);
  });
  expect(r).toBe(true);
});

test('falls back when the worker script cannot be loaded', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { lib, helpers } = window;
    lib.configureWorkers({ createWorker: () => new Worker('/missing-worker.js', { type: 'module' }) as any });
    const img = helpers.noise(100, 100, 4);
    const p = helpers.full();
    const out = await p.run(img);
    return { same: helpers.same(out.data, p.runSync(img).data), workers: helpers.workersCreated() };
  });
  expect(r.workers).toBeGreaterThan(0);
  expect(r.same).toBe(true);
});

test('preview runner keeps only the latest result', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { lib, helpers } = window;
    const img = helpers.noise(512, 512, 2);
    const preview = lib.createPreviewRunner();
    const runs = [0.1, 0.2, 0.3, 0.4].map((b) => preview.run(lib.pipeline().brightness(b), img));
    const results = await Promise.all(runs);
    const last = results[3];
    return {
      nulls: results.slice(0, 3).filter((x) => x === null).length,
      lastOk: last !== null && helpers.same(last.data, lib.pipeline().brightness(0.4).runSync(img).data),
    };
  });
  expect(r.nulls).toBe(3);
  expect(r.lastOk).toBe(true);
});

test('preview runner with maxSize works on a shrunk copy, fast enough for sliders', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { lib, helpers } = window;
    const big = helpers.noise(4000, 3000, 4);
    const preview = lib.createPreviewRunner({ maxSize: 1280 });
    const full = () =>
      lib.pipeline().autoStretch().exposure(0.2).contrast(0.2).levels({ inBlack: 0.02, inWhite: 0.98 }).temperature(0.1).saturation(0.2).sharpen({ amount: 0.8, radius: 2 });
    const first = (await preview.run(full(), big))!; // shrinks the input once
    // Slider moves: the shrunk copy is reused.
    const times: number[] = [];
    for (const ev of [0.1, 0.2, 0.3, 0.4, 0.5]) {
      const t0 = performance.now();
      await preview.run(full().exposure(ev), big);
      times.push(performance.now() - t0);
    }
    // Same as running the scaled pipeline on a copy shrunk the same way.
    const c = new OffscreenCanvas(1280, 960);
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    const src = new OffscreenCanvas(4000, 3000);
    src.getContext('2d')!.putImageData(big, 0, 0);
    ctx.drawImage(src, 0, 0, 1280, 960);
    const small = ctx.getImageData(0, 0, 1280, 960);
    const expected = full().scaled(0.32).runSync(small);
    times.sort((a, b) => a - b);
    return { size: [first.width, first.height], same: helpers.same(first.data, expected.data), median: Math.round(times[2]) };
  });
  console.log(`preview 4000x3000 -> 1280x960, 7 steps with sharpen: median ${r.median} ms per slider move`);
  expect(r.size).toEqual([1280, 960]);
  expect(r.same).toBe(true);
});

test('abort rejects with AbortError', async ({ page }) => {
  const name = await page.evaluate(async () => {
    const { helpers } = window;
    const c = new AbortController();
    const job = helpers.full().run(helpers.noise(1500, 1500), { signal: c.signal });
    c.abort();
    try {
      await job;
      return 'resolved';
    } catch (e) {
      return (e as Error).name;
    }
  });
  expect(name).toBe('AbortError');
});

test('12MP: performance and main-thread responsiveness', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { lib, helpers } = window;
    const img = helpers.noise(4000, 3000, 1);
    const p = lib.pipeline().brightness(0.1).contrast(0.2).saturation(0.2).temperature(0.1).gamma(1.1);

    // Longest gap between main-thread ticks while `fn` runs.
    async function measure(fn: () => Promise<unknown>) {
      let last = performance.now();
      let maxGap = 0;
      let running = true;
      const tick = () => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
        if (running) setTimeout(tick, 0);
      };
      setTimeout(tick, 0);
      const t0 = performance.now();
      await fn();
      const ms = performance.now() - t0;
      running = false;
      await new Promise((res) => setTimeout(res, 5));
      return { ms: Math.round(ms), maxGap: Math.round(maxGap) };
    }

    await p.run(helpers.noise(64, 64)); // start workers
    const main = await measure(() => p.run(img, { worker: false }));
    const worker = await measure(() => p.run(img));
    return { main, worker, cores: navigator.hardwareConcurrency };
  });
  console.log(`12MP x5 ops: main thread ${r.main.ms} ms (longest block ${r.main.maxGap} ms); workers (${r.cores} cores) ${r.worker.ms} ms (longest block ${r.worker.maxGap} ms)`);
  // The main thread is blocked for less than with main-thread processing.
  expect(r.worker.maxGap).toBeLessThan(r.main.maxGap);
});

test('works after being bundled by Vite in a consumer app', async ({ page }) => {
  await page.goto('/.bundled-test/index.html');
  const r = await page.evaluate(() => window.bundledResult);
  expect(r).toEqual({ workers: 2, same: true });
});

test('demo page renders and reacts to sliders, on the GPU and in workers', async ({ page }) => {
  await page.goto('/demo-dist/index.html');
  const status = page.locator('#status');
  // The pixel at (10, 10) of whichever canvas is shown.
  const pixel = () =>
    page.evaluate(() => {
      const shown = [...document.querySelectorAll('canvas')].find((c) => !c.hidden)!;
      const copy = document.createElement('canvas');
      copy.width = shown.width;
      copy.height = shown.height;
      const ctx = copy.getContext('2d')!;
      ctx.drawImage(shown, 0, 0);
      return [shown.id, ...ctx.getImageData(10, 10, 1, 1).data];
    });
  await expect(status).toContainText('640×400 · GPU');
  const before = await pixel();
  expect(before[0]).toBe('gpuView');
  const slider = page.locator('#sliders input').first();
  await slider.fill('0.5');
  await expect.poll(pixel).not.toEqual(before);
  const onGpu = await pixel();

  await page.locator('#gpu').uncheck();
  await expect(status).not.toContainText('GPU');
  await expect.poll(pixel).toEqual(['view', ...onGpu.slice(1)]);
  await slider.fill('0');
  await expect.poll(pixel).toEqual(['view', ...before.slice(1)]);
});
