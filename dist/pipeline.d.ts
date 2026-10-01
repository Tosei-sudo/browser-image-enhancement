import { type ImageInput } from './io.js';
import type { ColorOptions, ImageDataLike, LevelsOptions, OpSpec } from './types.js';
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
export type RunResult<O extends RunOptions | undefined> = O extends {
    output: 'canvas';
} ? HTMLCanvasElement | OffscreenCanvas : O extends {
    output: 'blob';
} ? Blob : O extends {
    output: 'gray';
} ? GrayImage : ImageData;
/** Serialized pipeline, from `toJSON()`. */
export interface PipelineJSON {
    version: 1;
    ops: OpSpec[];
}
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
//# sourceMappingURL=pipeline.d.ts.map