import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createPreviewRunner, Pipeline, pipeline, type PipelineJSON } from '../../src/index.js';
import { grayImage, isGrayPixels, noiseImage } from '../helpers.js';

let warnSpy: MockInstance;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warnSpy.mockRestore());

const full = () =>
  pipeline()
    .brightness(0.1)
    .contrast(0.2)
    .exposure(0.3)
    .gamma(1.1)
    .saturation(-0.2)
    .temperature(0.25)
    .levels({ inBlack: 0.05, inWhite: 0.95, gamma: 1.2, outBlack: 0.02, outWhite: 0.98 });

describe('Pipeline builder', () => {
  it('records steps in order with normalized parameters', () => {
    expect(full().ops.map((o) => o.op)).toEqual([
      'brightness',
      'contrast',
      'exposure',
      'gamma',
      'saturation',
      'temperature',
      'levels',
    ]);
    expect(pipeline().levels({}).ops[0]).toEqual({ op: 'levels', inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1 });
  });

  it('is immutable: each call returns a new pipeline', () => {
    const a = pipeline().brightness(0.1);
    const b = a.contrast(0.2);
    expect(a).not.toBe(b);
    expect(a.ops).toHaveLength(1);
    expect(b.ops).toHaveLength(2);
    expect(Object.isFrozen(a.ops)).toBe(true);
  });

  it('clamps parameters at build time', () => {
    expect(pipeline().brightness(3).ops[0]).toEqual({ op: 'brightness', amount: 1 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('add() accepts op objects', () => {
    expect(pipeline().add({ op: 'gamma', gamma: 2 }).ops).toEqual([{ op: 'gamma', gamma: 2 }]);
    expect(() => pipeline().add({ op: 'nope' } as any)).toThrow(TypeError);
  });
});

describe('Pipeline JSON', () => {
  it('round-trips through an object and a string', () => {
    const p = full();
    const json = p.toJSON();
    expect(json.version).toBe(1);
    expect(Pipeline.fromJSON(json).ops).toEqual(p.ops);
    expect(pipeline.fromJSON(JSON.stringify(p)).ops).toEqual(p.ops);
  });

  it('produces identical pixels after a round trip', () => {
    const img = noiseImage(32, 32);
    const p = full();
    expect(pipeline.fromJSON(JSON.stringify(p)).runSync(img).data).toEqual(p.runSync(img).data);
  });

  it('toJSON output is a copy', () => {
    const p = pipeline().brightness(0.2);
    const json = p.toJSON();
    (json.ops[0] as any).amount = 0.9;
    expect(p.ops[0]).toEqual({ op: 'brightness', amount: 0.2 });
  });

  it('validates input', () => {
    expect(() => pipeline.fromJSON({ version: 2, ops: [] } as unknown as PipelineJSON)).toThrow(TypeError);
    expect(() => pipeline.fromJSON('{"ops": []}')).toThrow(TypeError);
    expect(() => pipeline.fromJSON('not json')).toThrow(SyntaxError);
    expect(() => pipeline.fromJSON({ version: 1, ops: [{ op: 'blur' }] } as unknown as PipelineJSON)).toThrow(/Unknown/);
  });

  it('clamps bad values from JSON', () => {
    const p = pipeline.fromJSON({ version: 1, ops: [{ op: 'exposure', ev: 99 }] });
    expect(p.ops[0]).toEqual({ op: 'exposure', ev: 10 });
  });
});

describe('Pipeline.run without Web Workers (Node)', () => {
  it('falls back to the main thread and matches runSync', async () => {
    const img = noiseImage(64, 48, 6);
    const p = full();
    const out = await p.run(img);
    expect(out.data).toEqual(p.runSync(img).data);
    expect(out.width).toBe(64);
    expect(out.height).toBe(48);
  });

  it("output: 'gray' returns one luminance byte per pixel", async () => {
    const img = grayImage(10, 10, 2);
    const out = await pipeline().contrast(0.3).run(img, { output: 'gray' });
    const rgba = pipeline().contrast(0.3).runSync(img);
    expect(out.data).toHaveLength(100);
    for (let i = 0; i < 100; i++) expect(out.data[i]).toBe(rgba.data[i * 4]);
  });

  it("output: 'gray' on a color image gives luminance", async () => {
    const out = await pipeline().run(noiseImage(4, 4), { output: 'gray' });
    expect(out.data).toHaveLength(16);
  });

  it('respects colorMode', async () => {
    const out = await pipeline().temperature(0.8).run(grayImage(8, 8), { colorMode: 'rgb' });
    expect(isGrayPixels(out.data)).toBe(false);
    const gray = await pipeline().run(noiseImage(8, 8), { colorMode: 'gray' });
    expect(isGrayPixels(gray.data)).toBe(true);
  });

  it('warns about color ops on a monochrome image', async () => {
    await pipeline().saturation(0.5).run(grayImage(8, 8));
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects an already-aborted signal with AbortError', async () => {
    const c = new AbortController();
    c.abort();
    await expect(pipeline().brightness(0.1).run(noiseImage(4, 4), { signal: c.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('rejects unknown outputs', async () => {
    await expect(pipeline().run(noiseImage(2, 2), { output: 'png' as any })).rejects.toThrow(/Unknown output/);
  });

  it('rejects malformed input', async () => {
    await expect(pipeline().run({ data: new Uint8ClampedArray(5), width: 1, height: 1 })).rejects.toThrow(RangeError);
  });
});

describe('createPreviewRunner', () => {
  it('resolves only the latest run; superseded runs give null', async () => {
    const preview = createPreviewRunner();
    const img = noiseImage(16, 16);
    const a = preview.run(pipeline().brightness(0.1), img);
    const b = preview.run(pipeline().brightness(0.2), img);
    const c = preview.run(pipeline().brightness(0.3), img);
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra).toBeNull();
    expect(rb).toBeNull();
    expect(rc?.data).toEqual(pipeline().brightness(0.3).runSync(img).data);
  });

  it('cancel() discards the run in progress', async () => {
    const preview = createPreviewRunner();
    const pending = preview.run(pipeline().brightness(0.1), noiseImage(4, 4));
    preview.cancel();
    expect(await pending).toBeNull();
  });

  it('sequential runs all resolve', async () => {
    const preview = createPreviewRunner({ output: 'gray' });
    const img = grayImage(8, 8);
    const one = await preview.run(pipeline().gamma(1.2), img);
    const two = await preview.run(pipeline().gamma(0.8), img);
    expect(one?.data).toHaveLength(64);
    expect(two?.data).toHaveLength(64);
    expect(one?.data).not.toEqual(two?.data);
  });

  it('passes errors of the latest run through', async () => {
    const preview = createPreviewRunner();
    await expect(preview.run(pipeline(), { data: new Uint8ClampedArray(1), width: 1, height: 1 })).rejects.toThrow(RangeError);
  });
});
