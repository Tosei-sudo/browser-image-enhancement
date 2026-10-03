import { expect, test } from '@playwright/test';

/*
 * The WebGL2 renderer against the JS engine, in a real browser (headless
 * Chromium renders WebGL2 on the CPU with SwiftShader, so the timings here
 * say nothing about a real GPU; the results are what is checked).
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

test('matches the JS engine within one level for every kind of step', async ({ page }) => {
  const results = await page.evaluate(() => {
    const { lib } = window;
    const rand = (seed: number) => () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    /** A smooth picture with noise and hard edges, so sharpening has something to do. */
    const picture = (w: number, h: number, seed: number, gray = false, holes = false) => {
      const r = rand(seed);
      const d = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const edge = (x >> 4) % 2 === (y >> 4) % 2 ? 60 : 0;
          const n = Math.floor(r() * 40);
          d[i] = (x * 255) / w + edge * 0.5 + n;
          d[i + 1] = gray ? d[i] : (y * 255) / h + n;
          d[i + 2] = gray ? d[i] : 128 + edge - n;
          d[i + 3] = holes && (x * 7 + y * 3) % 11 === 0 ? 0 : holes && x % 5 === 0 ? 128 : 255;
        }
      }
      return new ImageData(d, w, h);
    };
    const p = lib.pipeline;
    const cases: Array<[string, import('../../src/index.js').Pipeline, ImageData, ('auto' | 'rgb' | 'gray')?]> = [
      ['per-channel only', p().brightness(0.1).contrast(0.3).exposure(0.4).gamma(1.2).temperature(0.3), picture(97, 61, 1)],
      ['brightness extremes', p().brightness(-1), picture(31, 17, 2)],
      ['saturation in the middle', p().exposure(-0.3).saturation(0.6).levels({ inBlack: 0.05, inWhite: 0.9, gamma: 1.3 }), picture(97, 61, 3)],
      ['stretch per channel', p().stretch({ black: [0.1, 0.05, 0], white: [0.8, 0.9, 1] }).contrast(-0.2), picture(64, 40, 4)],
      ['autoStretch', p().autoStretch({ lowPercent: 2, highPercent: 2 }).saturation(-0.4), picture(80, 50, 5)],
      ['sharpen alone', p().sharpen({ amount: 1.5, radius: 1.3 }), picture(97, 61, 6)],
      ['sharpen between steps', p().exposure(0.3).saturation(0.4).sharpen({ amount: 0.8, radius: 2, threshold: 0.02 }).contrast(0.2).levels({ gamma: 0.8 }), picture(97, 61, 7)],
      ['two sharpens', p().sharpen({ amount: 0.5, radius: 0.7 }).gamma(1.1).sharpen({ amount: 1, radius: 3 }), picture(70, 90, 8)],
      ['sharpen with transparency', p().contrast(0.2).sharpen({ amount: 2, radius: 1.5 }), picture(97, 61, 9, false, true)],
      ['monochrome', p().contrast(0.4).saturation(1).sharpen({ amount: 1, radius: 1 }), picture(97, 61, 10, true)],
      ['forced gray on color', p().exposure(0.2).sharpen({ amount: 1, radius: 1 }).gamma(0.9), picture(97, 61, 11), 'gray'],
      ['forced rgb on gray', p().temperature(0.5).saturation(0.3), picture(50, 30, 12, true), 'rgb'],
      ['nothing', p(), picture(23, 9, 13, false, true)],
      ['tint, white balance, shadows, highlights', p().whiteBalance({ r: 0.55, g: 0.5, b: 0.42 }).tint(-0.4).shadows(0.8).highlights(-0.7), picture(97, 61, 14)],
      [
        'curves',
        p()
          .curve({ points: [[0.2, 0.1], [0.5, 0.55], [0.8, 0.95]], red: [[0.5, 0.6]] })
          .sharpen({ amount: 0.6 })
          .curve({ points: [[0.3, 0.2]], blue: [[0, 0.1], [1, 0.9]] }),
        picture(97, 61, 15),
      ],
      ['curve on monochrome', p().curve({ points: [[0.25, 0.4]], green: [[0.5, 0.1]] }).shadows(-0.5), picture(64, 40, 16, true)],
    ];
    const gpu = lib.createGpuRenderer();
    if (!gpu) return null;
    return cases.map(([name, pipe, img, colorMode]) => {
      gpu.setImage(img, { colorMode });
      gpu.render(pipe);
      const got = gpu.read().data;
      const want = pipe.runSync(img, { colorMode }).data;
      let max = 0;
      let off = 0;
      for (let i = 0; i < want.length; i++) {
        const d = Math.abs(got[i] - want[i]);
        if (d > max) max = d;
        if (d > 0) off++;
      }
      return { name, max, offShare: off / want.length };
    });
  });
  expect(results, 'WebGL2 should be available in Chromium').not.toBeNull();
  for (const r of results!) {
    expect(r.max, r.name).toBeLessThanOrEqual(1);
    expect(r.offShare, r.name).toBeLessThan(0.01);
  }
});

test('draws on the canvas it was given, the right way up', async ({ page }) => {
  const r = await page.evaluate(() => {
    const { lib } = window;
    const canvas = document.createElement('canvas');
    const gpu = lib.createGpuRenderer({ canvas })!;
    const d = new Uint8ClampedArray(4 * 3 * 4);
    for (let i = 0; i < d.length; i += 4) d.set([i * 5, 255 - i * 5, 40, 255], i);
    const img = new ImageData(d, 4, 3);
    gpu.setImage(img);
    gpu.render(lib.pipeline().exposure(0.5));
    const shown = document.createElement('canvas');
    shown.width = 4;
    shown.height = 3;
    const ctx = shown.getContext('2d')!;
    ctx.drawImage(canvas, 0, 0);
    const want = lib.pipeline().exposure(0.5).runSync(img).data;
    return { size: [canvas.width, canvas.height], drawn: Array.from(ctx.getImageData(0, 0, 4, 3).data), want: Array.from(want), read: Array.from(gpu.read().data) };
  });
  expect(r.size).toEqual([4, 3]);
  expect(r.read).toEqual(r.want);
  expect(r.drawn).toEqual(r.want);
});

test('rejects images larger than the GPU accepts', async ({ page }) => {
  const message = await page.evaluate(() => {
    const gpu = window.lib.createGpuRenderer()!;
    const side = gpu.maxSize + 1;
    try {
      gpu.setImage({ data: new Uint8ClampedArray(side * 4), width: side, height: 1 });
      return 'accepted';
    } catch (e) {
      return (e as Error).name;
    }
  });
  expect(message).toBe('RangeError');
});

test('reads another canvas directly, the same as its pixels', async ({ page }) => {
  const r = await page.evaluate(() => {
    const { lib } = window;
    const w = 37;
    const h = 23;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) d.set([x * 6, y * 10, (x * y) % 256, 255], (y * w + x) * 4);
    }
    const img = new ImageData(d, w, h);
    const picture = document.createElement('canvas');
    picture.width = w;
    picture.height = h;
    picture.getContext('2d')!.putImageData(img, 0, 0);

    const p = lib.pipeline().exposure(0.4).temperature(0.3).sharpen({ amount: 1, radius: 1 });
    const gpu = lib.createGpuRenderer()!;
    gpu.setImage(img, { colorMode: 'rgb' });
    gpu.render(p);
    const fromPixels = Array.from(gpu.read().data);
    gpu.setImage(picture);
    gpu.render(p);
    const fromCanvas = Array.from(gpu.read().data);
    // Redrawn canvas of the same size: the texture is overwritten in place.
    picture.getContext('2d')!.fillRect(0, 0, w, h);
    gpu.setImage(picture);
    gpu.render(lib.pipeline());
    const redrawn = Array.from(gpu.read().data.slice(0, 4));
    let stretch = '';
    try {
      gpu.render(lib.pipeline().autoStretch());
    } catch (e) {
      stretch = (e as Error).name;
    }
    return { fromPixels, fromCanvas, redrawn, stretch };
  });
  expect(r.fromCanvas).toEqual(r.fromPixels);
  expect(r.redrawn).toEqual([0, 0, 0, 255]);
  expect(r.stretch).toBe('TypeError');
});
