/**
 * Pipeline API: declare a chain of corrections, then run it in one pass
 * (no 8-bit rounding between steps), in Web Workers by default.
 */
import { assertImageData, createImageData } from './core/image.js';
import { needsStats, resolveOps } from './core/histogram.js';
import { extractGray } from './core/process.js';
import { applySync, warnColorOnly } from './functional.js';
import { toBlob, toCanvas, toImageData, type ImageInput } from './io.js';
import { normalizeOp } from './ops/index.js';
import type { AutoStretchOptions, ColorOptions, Histogram, ImageDataLike, LevelsOptions, OpSpec, StretchOptions } from './types.js';
import { abortError, execute } from './worker/executor.js';

export type OutputKind = 'imageData' | 'canvas' | 'blob' | 'gray';

/** One 8-bit luminance value per pixel. */
export interface GrayImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

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

export type RunResult<O extends RunOptions | undefined> = O extends { output: 'canvas' }
  ? HTMLCanvasElement | OffscreenCanvas
  : O extends { output: 'blob' }
    ? Blob
    : O extends { output: 'gray' }
      ? GrayImage
      : ImageData;

/** Serialized pipeline, from `toJSON()`. */
export interface PipelineJSON {
  version: 1;
  ops: OpSpec[];
}

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
pipeline.fromJSON = Pipeline.fromJSON;

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
 * input is reused while the same input object is passed again.
 */
export function createPreviewRunner<O extends Omit<RunOptions, 'signal'> | undefined = undefined>(
  options?: O,
): PreviewRunner<O> {
  let generation = 0;
  let controller: AbortController | null = null;
  let lastInput: ImageInput | null = null;
  let lastDecoded: Promise<ImageDataLike> | null = null;

  return {
    async run(p, input) {
      const mine = ++generation;
      controller?.abort();
      const current = new AbortController();
      controller = current;
      if (input !== lastInput || !lastDecoded) {
        lastInput = input;
        lastDecoded = toImageData(input);
        lastDecoded.catch(() => {
          if (lastInput === input) lastDecoded = null;
        });
      }
      try {
        const decoded = await lastDecoded;
        if (mine !== generation) return null;
        const result = await p.run(decoded, { ...(options ?? {}), signal: current.signal } as RunOptions);
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
