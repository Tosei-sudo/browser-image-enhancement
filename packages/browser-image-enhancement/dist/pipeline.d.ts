import { ImageDataLike } from "./workers/src/image.js";
import { ImageInput } from "./workers/src/io.js";
import { AutoStretchOptions, ColorOptions, CurveOptions, Histogram, LevelsOptions, OpName, OpSpec, SharpenOptions, StepOptions, StretchOptions, WhiteBalanceOptions } from "./types.js";
//#region src/pipeline.d.ts
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
export type RunResult<O extends RunOptions | undefined> = O extends {
  output: 'canvas';
} ? HTMLCanvasElement | OffscreenCanvas : O extends {
  output: 'blob';
} ? Blob : O extends {
  output: 'gray';
} ? GrayImage : ImageData;
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
export declare class Pipeline {
  /** The normalized steps, in order. */
  readonly ops: readonly OpSpec[];
  /** Use `pipeline()` or `Pipeline.fromJSON()`. */
  constructor(ops?: readonly OpSpec[]);
  /** Restores a pipeline saved with `toJSON()` (object or JSON string). */
  static fromJSON(json: PipelineJSON | string): Pipeline;
  /** Returns a new pipeline with `op` appended. Pipelines are immutable. */
  add(op: OpSpec): Pipeline;
  /** Brightness, -1 to 1. */
  brightness(amount: number): Pipeline;
  /** Contrast, -1 to 1. */
  contrast(amount: number): Pipeline;
  /** Exposure in EV stops, -10 to 10. */
  exposure(ev: number): Pipeline;
  /** Gamma, 0.1 to 10. */
  gamma(value: number): Pipeline;
  /** Saturation, -1 to 1. No effect on monochrome images. */
  saturation(amount: number): Pipeline;
  /** Color temperature, -1 (cool) to 1 (warm). No effect on monochrome images. */
  temperature(amount: number): Pipeline;
  /** Tint, -1 (green) to 1 (magenta): the color axis temperature does not cover. No effect on monochrome images. */
  tint(amount: number): Pipeline;
  /**
   * White balance from a gray point: `gray` is the color (sRGB-encoded, 0-1)
   * of something that should be neutral, for example from `sampleColor` on the
   * image. Put it first so it sees the colors of the original image. No effect
   * on monochrome images.
   */
  whiteBalance(gray: WhiteBalanceOptions): Pipeline;
  /** Shadows, -1 (darker) to 1 (lifted): moves dark tones, leaving black, white and highlights almost unchanged. */
  shadows(amount: number): Pipeline;
  /** Highlights, -1 (recovered, darker) to 1 (brighter): moves light tones, leaving black, white and shadows almost unchanged. */
  highlights(amount: number): Pipeline;
  /**
   * Tone curve (see {@link CurveOptions}): points `[input, output]` on the
   * sRGB 0-1 scale joined by a smooth curve, for all channels and per channel.
   *
   * @example
   * ```ts
   * pipeline().curve({ points: [[0.25, 0.2], [0.75, 0.8]] }); // gentle S curve: more contrast
   * ```
   */
  curve(options: CurveOptions): Pipeline;
  /** Levels (black/white points 0-1, midtone gamma). */
  levels(params: LevelsOptions): Pipeline;
  /**
   * Stretches the range black..white (sRGB-encoded, one number or [R, G, B])
   * to full black..white.
   */
  stretch(params: StretchOptions): Pipeline;
  /**
   * Automatic stretch (dynamic range adjustment). The range comes from the
   * pixel distribution of the image as it reaches this step, ignoring
   * transparent pixels. `run` takes the statistics from the image it is given;
   * for tiles, collect statistics over the area you show and call `resolve`.
   */
  autoStretch(options?: AutoStretchOptions): Pipeline;
  /**
   * Sharpens with an unsharp mask (see {@link SharpenOptions}). Run on its own
   * image, the result is the same whether or not it is split across workers.
   * For tiles of a larger picture, give each tile {@link Pipeline.margin}
   * pixels of its neighbours so the tile edges do not show.
   */
  sharpen(options?: SharpenOptions): Pipeline;
  /**
   * Pixels of context the pipeline needs around each part of a picture: when
   * a tile is run with this many pixels of its neighbours on every side (and
   * the margin is cropped off afterwards), it matches the same area of the
   * whole picture run at once, so tile seams cannot show. 0 unless the
   * pipeline has `sharpen` steps.
   */
  get margin(): number;
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
  set<N extends OpName>(op: N, params: StepOptions[N] | number): Pipeline;
  /** The first step of kind `op`, with its normalized parameters, or undefined when there is none. */
  get<N extends OpName>(op: N): Extract<OpSpec, {
    op: N;
  }> | undefined;
  /** Returns a pipeline without any step of kind `op`. */
  remove(op: OpName): Pipeline;
  /** True when no step changes the image (an empty pipeline, or every step at its neutral value). */
  get isIdentity(): boolean;
  /**
   * The same correction for the image shrunk by `factor` (0.5 = half the
   * width and height): pixel distances (the `sharpen` radius) are scaled with
   * it, so a preview on a smaller copy looks like the full-size result.
   */
  scaled(factor: number): Pipeline;
  /** True when the pipeline has `autoStretch` steps that still need statistics. */
  get needsStats(): boolean;
  /**
   * Returns a pipeline with every `autoStretch` replaced by a fixed `stretch`
   * computed from `stats`, the histogram of the image (or of the area of a
   * tiled image) it will run on. Every image run through the result gets the
   * same range. With `null`, `autoStretch` steps are removed.
   */
  resolve(stats: Histogram | null): Pipeline;
  /** Serializable form of the steps, for saving presets. Restore with {@link Pipeline.fromJSON}. */
  toJSON(): PipelineJSON;
  /** Runs synchronously on the calling thread. */
  runSync(image: ImageDataLike, options?: ColorOptions): ImageData;
  /** Runs on any supported input and returns the requested output type. */
  run<O extends RunOptions | undefined = undefined>(input: ImageInput, options?: O): Promise<RunResult<O>>;
}
/** Starts an empty pipeline. */
export declare function pipeline(): Pipeline;
export declare namespace pipeline {
  var fromJSON: typeof Pipeline.fromJSON;
}
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
export declare function createPreviewRunner<O extends PreviewOptions | undefined = undefined>(options?: O): PreviewRunner<O>;
//#endregion
//# sourceMappingURL=pipeline.d.ts.map