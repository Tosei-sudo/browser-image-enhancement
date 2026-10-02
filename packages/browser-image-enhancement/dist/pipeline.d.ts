import { ImageDataLike } from "./workers/src/image.js";
import { ImageInput } from "./workers/src/io.js";
import { AutoStretchOptions, ColorOptions, Histogram, LevelsOptions, OpSpec, StretchOptions } from "./types.js";
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
 * input is reused while the same input object is passed again.
 */
export declare function createPreviewRunner<O extends Omit<RunOptions, 'signal'> | undefined = undefined>(options?: O): PreviewRunner<O>;
//#endregion
//# sourceMappingURL=pipeline.d.ts.map