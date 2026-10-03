import { ImageInput } from "./workers/src/io.js";
import { Pipeline, RunOptions, RunResult } from "./pipeline.js";
//#region src/presets.d.ts
/** Names of the built-in {@link presets}. */
export type PresetName = 'auto' | 'vivid' | 'soft' | 'satellite' | 'document' | 'blackAndWhite';
/**
 * Built-in corrections:
 *
 * - `auto`: automatic stretch per channel (0.5 % clipped at each end, which
 *   also removes color casts) and light sharpening. What {@link autoEnhance} runs.
 * - `vivid`: `auto` with more contrast and saturation.
 * - `soft`: lifted shadows, calmer highlights, less contrast and a little warmth.
 * - `satellite`: a stronger stretch (2 % clipped) for hazy aerial and
 *   satellite imagery, with sharpening.
 * - `document`: for photographed pages: one stretch for all channels that
 *   pushes the paper to white, more contrast and crisp sharpening.
 * - `blackAndWhite`: stretch, then monochrome with a little extra contrast.
 *
 * @example
 * ```ts
 * const out = await presets.vivid.run(img, { output: 'canvas' });
 * editor.render(presets.soft.set('shadows', 0.6)); // a preset as a starting point
 * ```
 */
export declare const presets: Readonly<Record<PresetName, Pipeline>>;
/**
 * One-call automatic correction: runs {@link presets}.auto (automatic stretch
 * and light sharpening) and returns the output `options.output` asks for, as
 * {@link Pipeline.run} does.
 *
 * @example
 * ```ts
 * const fixed = await autoEnhance(file, { output: 'blob', type: 'image/jpeg', quality: 0.9 });
 * ```
 */
export declare function autoEnhance<O extends RunOptions | undefined = undefined>(input: ImageInput, options?: O): Promise<RunResult<O>>;
//#endregion
//# sourceMappingURL=presets.d.ts.map