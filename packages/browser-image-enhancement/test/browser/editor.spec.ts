import { expect, test } from '@playwright/test';

/*
 * createEditor in a real browser: engine choice, previews followed by the full
 * size, coalescing, and the switch to the JS engine when WebGL is lost.
 */

declare global {
  interface Window {
    lib: typeof import('../../src/index.js');
    ready: boolean;
  }
}

test.beforeEach(async ({ page }) => {
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[browser]', m.text());
  });
  await page.goto('/test/browser/index.html');
  await page.waitForFunction(() => window.ready === true);
});

/** Adds helpers to the page: a noise image and reading a canvas of any context type. */
async function helpers(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.noise = (width: number, height: number) => {
      let seed = 7;
      const d = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < d.length; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        d[i] = (i & 3) === 3 ? 255 : seed >>> 24;
      }
      return new ImageData(d, width, height);
    };
    w.pixels = (canvas: HTMLCanvasElement) => {
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const ctx = copy.getContext('2d')!;
      ctx.drawImage(canvas, 0, 0);
      return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    };
  });
}

test('on the GPU: draws the full size, within one level of the exported result', async ({ page }) => {
  await helpers(page);
  const r = await page.evaluate(async () => {
    const { createEditor, pipeline } = window.lib;
    const w = window as unknown as { noise(w: number, h: number): ImageData; pixels(c: HTMLCanvasElement): Uint8ClampedArray };
    const infos: unknown[] = [];
    const editor = createEditor({ onRender: (i) => infos.push(i) });
    document.body.append(editor.canvas);
    await editor.setImage(w.noise(300, 200));
    const p = pipeline().exposure(0.4).contrast(0.2).sharpen({ amount: 1 }).autoStretch();
    const drawn = await editor.render(p);
    const shown = w.pixels(editor.canvas);
    const exact = await editor.export(p);
    let maxDiff = 0;
    for (let i = 0; i < shown.length; i++) maxDiff = Math.max(maxDiff, Math.abs(shown[i] - exact.data[i]));
    return { engine: editor.engine, drawn, size: [editor.canvas.width, editor.canvas.height], maxDiff, infos };
  });
  expect(r.engine).toBe('gpu');
  expect(r.drawn).toBe(true);
  expect(r.size).toEqual([300, 200]);
  expect(r.maxDiff).toBeLessThanOrEqual(1);
  expect(r.infos).toEqual([expect.objectContaining({ engine: 'gpu', width: 300, height: 200, preview: false })]);
});

test('with the JS engine: a shrunk preview first, then exactly the full-size result', async ({ page }) => {
  await helpers(page);
  const r = await page.evaluate(async () => {
    const { createEditor, pipeline } = window.lib;
    const w = window as unknown as { noise(w: number, h: number): ImageData; pixels(c: HTMLCanvasElement): Uint8ClampedArray };
    const infos: Array<{ width: number; preview: boolean }> = [];
    let settled!: () => void;
    const full = new Promise<void>((resolve) => (settled = resolve));
    const editor = createEditor({
      engine: 'cpu',
      previewSize: 400,
      settleDelay: 50,
      onRender: (i) => {
        infos.push(i);
        if (!i.preview) settled();
      },
    });
    await editor.setImage(w.noise(1000, 500));
    const p = pipeline().gamma(1.3).saturation(0.4).sharpen({ amount: 0.8, radius: 2 });
    const drawn = await editor.render(p);
    const previewSize = [editor.canvas.width, editor.canvas.height];
    await full;
    const shown = editor.canvas.getContext('2d')!.getImageData(0, 0, editor.canvas.width, editor.canvas.height).data;
    const exact = await editor.export(p);
    let same = shown.length === exact.data.length;
    for (let i = 0; same && i < shown.length; i++) same = shown[i] === exact.data[i];
    return { engine: editor.engine, drawn, previewSize, infos: infos.map((i) => [i.width, i.preview]), same };
  });
  expect(r.engine).toBe('cpu');
  expect(r.drawn).toBe(true);
  expect(r.previewSize).toEqual([400, 200]);
  expect(r.infos).toEqual([
    [400, true],
    [1000, false],
  ]);
  expect(r.same).toBe(true);
});

test('coalesces calls: only the latest pipeline is drawn', async ({ page }) => {
  await helpers(page);
  for (const engine of ['gpu', 'cpu'] as const) {
    const r = await page.evaluate(async (engine) => {
      const { createEditor, pipeline } = window.lib;
      const w = window as unknown as { noise(w: number, h: number): ImageData };
      const editor = createEditor({ engine, settleDelay: -1 });
      await editor.setImage(w.noise(64, 64));
      const results = await Promise.all([0.1, 0.2, 0.3].map((ev) => editor.render(pipeline().exposure(ev))));
      editor.dispose();
      return results;
    }, engine);
    expect(r, engine).toEqual([false, false, true]);
  }
});

test('switches to the JS engine on a new canvas when the WebGL context is lost', async ({ page }) => {
  await helpers(page);
  const r = await page.evaluate(async () => {
    const { createEditor, pipeline } = window.lib;
    const w = window as unknown as { noise(w: number, h: number): ImageData };
    const editor = createEditor();
    const first = editor.canvas;
    first.className = 'photo';
    document.body.append(first);
    await editor.setImage(w.noise(80, 60));
    await editor.render(pipeline().exposure(0.5));
    const before = editor.engine;
    const lost = new Promise((resolve) => first.addEventListener('webglcontextlost', resolve));
    (first.getContext('webgl2') as WebGL2RenderingContext).getExtension('WEBGL_lose_context')!.loseContext();
    await lost;
    const drawn = await editor.render(pipeline().exposure(0.5));
    return {
      before,
      after: editor.engine,
      drawn,
      replaced: editor.canvas !== first && editor.canvas.isConnected && !first.isConnected,
      className: editor.canvas.className,
      size: [editor.canvas.width, editor.canvas.height],
    };
  });
  expect(r).toEqual({ before: 'gpu', after: 'cpu', drawn: true, replaced: true, className: 'photo', size: [80, 60] });
});
