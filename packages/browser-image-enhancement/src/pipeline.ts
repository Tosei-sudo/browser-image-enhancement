/**
 * Pipeline API: declare a chain of corrections, then run it in one pass
 * (no 8-bit rounding between steps), in Web Workers by default.
 */
import { assertImageData, createImageData } from './core/image.js';
import { needsStats, resolveOps } from './core/histogram.js';
import { extractGray } from './core/process.js';
import { applySync, warnColorOnly } from './functional.js';
import { toBlob, toCanvas, toImageData, type ImageInput } from './io.js';
import { isIdentity, marginOf, normalizeOp } from './ops/index.js';
import { opInfo } from './ops/info.js';
import { downscale } from './preview.js';
import type {
  AutoStretchOptions,
  ColorOptions,
  Histogram,
  ImageDataLike,
  LevelsOptions,
  OpName,
  OpSpec,
  SharpenOptions,
  StepOptions,
  StretchOptions,
} from './types.js';
import { abortError, execute } from './worker/executor.js';

/**
 * What `run()` resolves with: `imageData` (default), a `canvas`
 * (`OffscreenCanvas` where available), an encoded `blob`, or a single-channel
 * `gray` image.
 */
export type OutputKind = 'imageData' | 'canvas' | 'blob' | 'gray';

/** One 8-bit luminance value per pixel. */
export interface GrayImage {
  /** `width * height` values, row by row from the top left. */
  data: Uint8ClampedArray;
  /** Width in pixels. */
  width: number;
  /** Height in pixels. */
  height: number;
}

/** Options for {@link Pipeline.run} and {@link createPreviewRunner}. */
export interface RunOptions extends ColorOptions {
  /** Result type. Default `imageData`. */
  output?: OutputKind;
  /** Encoding for `output: 'blob'`. Default `image/png`. */
  type?: string;
  /** Encoder quality 0-1 for lossy `type`s. */
  quality?: number;
  /** Run in Web Workers (default true). Falls back to the main thread automatically. */
  worker?: boolean;
  /** Cancels the run; the promise rejects with an AbortError. */
  signal?: AbortSignal;
}

/** The type `run()` resolves with, chosen by `output` in the options. */
export type RunResult<O extends RunOptions | undefined> = O extends { output: 'canvas' }
  ? HTMLCanvasElement | OffscreenCanvas
  : O extends { output: 'blob' }
    ? Blob
    : O extends { output: 'gray' }
      ? GrayImage
      : ImageData;

/** Serialized pipeline, from `toJSON()`. */
export interface PipelineJSON {
  /** Format version. Always 1. */
  version: 1;
  /** The steps, in order. */
  ops: OpSpec[];
}

/**
 * An immutable chain of corrections. Each method returns a new pipeline with
 * one more step; `run()` applies all steps in one pass in linear light, so no
 * precision is lost to 8-bit rounding between steps.
 *
 * @example
 * ```ts
 * const p = pipeline().exposure(0.5).contrast(0.2).saturation(0.1);
 * const out = await p.run(img, { output: 'canvas' });
 * ```
 */
export class Pipeline {
  /** The normalized steps, in order. */
  readonly ops: readonly OpSpec[];

  /** Use `pipeline()` or `Pipeline.fromJSON()`. */
  constructor(ops: readonly OpSpec[] = []) {
    this.ops = Object.freeze(ops.map(normalizeOp));
  }

  /** Restores a pipeline saved with `toJSON()` (object or JSON string). */
  static fromJSON(json: PipelineJSON | string): Pipeline {
    const parsed = (typeof json === 'string' ? JSON.parse(json) : json) as Partial<PipelineJSON>;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.ops)) {
      throw new TypeError('Not a browser-image-enhancement pipeline (expected { version: 1, ops: [...] }).');
    }
    return new Pipeline(parsed.ops);
  }

  /** Returns a new pipeline with `op` appended. Pipelines are immutable. */
  add(op: OpSpec): Pipeline {
    return new Pipeline([...this.ops, op]);
  }

  /** Brightness, -1 to 1. */
  brightness(amount: number): Pipeline {
    return this.add({ op: 'brightness', amount });
  }

  /** Contrast, -1 to 1. */
  contrast(amount: number): Pipeline {
    return this.add({ op: 'contrast', amount });
  }

  /** Exposure in EV stops, -10 to 10. */
  exposure(ev: number): Pipeline {
    return this.add({ op: 'exposure', ev });
  }

  /** Gamma, 0.1 to 10. */
  gamma(value: number): Pipeline {
    return this.add({ op: 'gamma', gamma: value });
  }

  /** Saturation, -1 to 1. No effect on monochrome images. */
  saturation(amount: number): Pipeline {
    return this.add({ op: 'saturation', amount });
  }

  /** Color temperature, -1 (cool) to 1 (warm). No effect on monochrome images. */
  temperature(amount: number): Pipeline {
    return this.add({ op: 'temperature', amount });
  }

  /** Levels (black/white points 0-1, midtone gamma). */
  levels(params: LevelsOptions): Pipeline {
    return this.add({ op: 'levels', ...params } as OpSpec);
  }

  /**
   * Stretches the range black..white (sRGB-encoded, one number or [R, G, B])
   * to full black..white.
   */
  stretch(params: StretchOptions): Pipeline {
    return this.add({ op: 'stretch', ...params } as OpSpec);
  }

  /**
   * Automatic stretch (dynamic range adjustment). The range comes from the
   * pixel distribution of the image as it reaches this step, ignoring
   * transparent pixels. `run` takes the statistics from the image it is given;
   * for tiles, collect statistics over the area you show and call `resolve`.
   */
  autoStretch(options?: AutoStretchOptions): Pipeline {
    return this.add({ op: 'autoStretch', ...options } as OpSpec);
  }

  /**
   * Sharpens with an unsharp mask (see {@link SharpenOptions}). Run on its own
   * image, the result is the same whether or not it is split across workers.
   * For tiles of a larger picture, give each tile {@link Pipeline.margin}
   * pixels of its neighbours so the tile edges do not show.
   */
  sharpen(options?: SharpenOptions): Pipeline {
    return this.add({ op: 'sharpen', ...options } as OpSpec);
  }

  /**
   * Pixels of context the pipeline needs around each part of a picture: when
   * a tile is run with this many pixels of its neighbours on every side (and
   * the margin is cropped off afterwards), it matches the same area of the
   * whole picture run at once, so tile seams cannot show. 0 unless the
   * pipeline has `sharpen` steps.
   */
  get margin(): number {
    return marginOf(this.ops);
  }

  /**
   * Returns a pipeline with step `op` set to `params`: the first step of that
   * kind is updated in place (parameters not given keep their values), or the
   * step is appended when the pipeline has none. Made for controls: each
   * slider sets its own step without rebuilding the chain.
   *
   * Steps with one main value (`brightness`, `contrast`, `exposure`, `gamma`,
   * `saturation`, `temperature`, `sharpen`, ...) also take that value as a number;
   * {@link OpInfo.value} names it.
   *
   * @example
   * ```ts
   * let p = pipeline().exposure(0).contrast(0).sharpen({ amount: 0 });
   * p = p.set('contrast', 0.3);                // same as { amount: 0.3 }
   * p = p.set('sharpen', { radius: 2 });       // amount stays 0
   * p = p.set('levels', { inBlack: 0.05 });    // appended: there was no levels step
   * ```
   */
  set<N extends OpName>(op: N, params: StepOptions[N] | number): Pipeline {
    const info = opInfo[op];
    if (!info) throw new TypeError(`Unknown correction: ${String(op)}`);
    let given: object;
    if (typeof params === 'number') {
      if (!info.value) throw new TypeError(`${op} takes an object of parameters, not a number.`);
      given = { [info.value]: params };
    } else given = params ?? {};
    const i = this.ops.findIndex((s) => s.op === op);
    const next = [...this.ops] as OpSpec[];
    if (i < 0) next.push({ ...given, op } as OpSpec);
    else next[i] = { ...next[i], ...given, op } as OpSpec;
    return new Pipeline(next);
  }

  /** The first step of kind `op`, with its normalized parameters, or undefined when there is none. */
  get<N extends OpName>(op: N): Extract<OpSpec, { op: N }> | undefined {
    return this.ops.find((s) => s.op === op) as Extract<OpSpec, { op: N }> | undefined;
  }

  /** Returns a pipeline without any step of kind `op`. */
  remove(op: OpName): Pipeline {
    return this.ops.some((s) => s.op === op) ? new Pipeline(this.ops.filter((s) => s.op !== op)) : this;
  }

  /** True when no step changes the image (an empty pipeline, or every step at its neutral value). */
  get isIdentity(): boolean {
    return this.ops.every(isIdentity);
  }

  /**
   * The same correction for the image shrunk by `factor` (0.5 = half the
   * width and height): pixel distances (the `sharpen` radius) are scaled with
   * it, so a preview on a smaller copy looks like the full-size result.
   */
  scaled(factor: number): Pipeline {
    if (!(factor > 0) || factor === 1) return this;
    return new Pipeline(this.ops.map((op) => (op.op === 'sharpen' ? { ...op, radius: Math.min(50, Math.max(0.1, op.radius * factor)) } : op)));
  }

  /** True when the pipeline has `autoStretch` steps that still need statistics. */
  get needsStats(): boolean {
    return needsStats(this.ops);
  }

  /**
   * Returns a pipeline with every `autoStretch` replaced by a fixed `stretch`
   * computed from `stats`, the histogram of the image (or of the area of a
   * tiled image) it will run on. Every image run through the result gets the
   * same range. With `null`, `autoStretch` steps are removed.
   */
  resolve(stats: Histogram | null): Pipeline {
    return needsStats(this.ops) ? new Pipeline(resolveOps(this.ops, stats)) : this;
  }

  /** Serializable form of the steps, for saving presets. Restore with {@link Pipeline.fromJSON}. */
  toJSON(): PipelineJSON {
    return { version: 1, ops: this.ops.map((op) => ({ ...op })) };
  }

  /** Runs synchronously on the calling thread. */
  runSync(image: ImageDataLike, options: ColorOptions = {}): ImageData {
    return applySync(image, this.ops, options);
  }

  /** Runs on any supported input and returns the requested output type. */
  async run<O extends RunOptions | undefined = undefined>(input: ImageInput, options?: O): Promise<RunResult<O>> {
    const opts: RunOptions = options ?? {};
    const source = await toImageData(input);
    assertImageData(source);
    if (opts.signal?.aborted) throw abortError(opts.signal);
    const result = await execute(source, this.ops, {
      colorMode: opts.colorMode,
      worker: opts.worker,
      signal: opts.signal,
    });
    if (result.mode === 'gray') warnColorOnly(this.ops);

    switch (opts.output ?? 'imageData') {
      case 'gray':
        return { data: extractGray(result.data), width: result.width, height: result.height } as RunResult<O>;
      case 'canvas':
        return toCanvas(result) as RunResult<O>;
      case 'blob':
        return (await toBlob(result, opts.type, opts.quality)) as RunResult<O>;
      case 'imageData':
        return createImageData(result.data, result.width, result.height) as RunResult<O>;
      default:
        throw new TypeError(`Unknown output: ${String(opts.output)}`);
    }
  }
}

/** Starts an empty pipeline. */
export function pipeline(): Pipeline {
  return new Pipeline();
}
/** Same as {@link Pipeline.fromJSON}. */
pipeline.fromJSON = Pipeline.fromJSON;

/** Options for {@link createPreviewRunner}. */
export interface PreviewOptions extends Omit<RunOptions, 'signal'> {
  /**
   * Longest side, in pixels, the preview is computed at. A larger input is
   * shrunk once (and reused while the same input is passed) and each run
   * works on the small copy, with the `sharpen` radius scaled to match, so
   * slider moves are fast. Results then have the reduced size. Default: no
   * limit. Run the pipeline on the original for the final full-size result.
   */
  maxSize?: number;
}

/** Created by {@link createPreviewRunner}. */
export interface PreviewRunner<O extends RunOptions | undefined> {
  /**
   * Runs `p` on `input`. Resolves with `null` if a newer `run` (or `cancel`)
   * came in before this one finished, so only the latest result is shown.
   */
  run(p: Pipeline, input: ImageInput): Promise<RunResult<O> | null>;
  /** Discards the run in progress, if any. */
  cancel(): void;
}

/**
 * For slider previews: each call supersedes the previous one. The last decoded
 * (and, with `maxSize`, shrunk) input is reused while the same input object is
 * passed again.
 *
 * @example
 * ```ts
 * const preview = createPreviewRunner({ maxSize: 1280 });
 * slider.oninput = async () => show(await preview.run(current(), img));
 * slider.onchange = async () => show(await current().run(img)); // full size on release
 * ```
 */
export function createPreviewRunner<O extends PreviewOptions | undefined = undefined>(options?: O): PreviewRunner<O> {
  let generation = 0;
  let controller: AbortController | null = null;
  let lastInput: ImageInput | null = null;
  let lastDecoded: Promise<{ image: ImageDataLike; scale: number }> | null = null;
  const { maxSize, ...runOptions } = (options ?? {}) as PreviewOptions;

  return {
    async run(p, input) {
      const mine = ++generation;
      controller?.abort();
      const current = new AbortController();
      controller = current;
      if (input !== lastInput || !lastDecoded) {
        lastInput = input;
        lastDecoded = toImageData(input).then((image) =>
          maxSize !== undefined && maxSize > 0 ? downscale(image, maxSize) : { image, scale: 1 },
        );
        lastDecoded.catch(() => {
          if (lastInput === input) lastDecoded = null;
        });
      }
      try {
        const decoded = await lastDecoded;
        if (mine !== generation) return null;
        const result = await p.scaled(decoded.scale).run(decoded.image, { ...runOptions, signal: current.signal } as RunOptions);
        return mine === generation ? (result as RunResult<O>) : null;
      } catch (e) {
        if (mine !== generation) return null;
        throw e;
      } finally {
        if (controller === current) controller = null;
      }
    },
    cancel() {
      generation++;
      controller?.abort();
      controller = null;
    },
  };
}
