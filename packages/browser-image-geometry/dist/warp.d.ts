import { Transform } from "./types.js";
import { ImageInput } from "./workers/src/io.js";
import { OutputOptions } from "./plan.js";
import { WarpResult } from "./functional.js";
//#region src/warp.d.ts
/** What {@link warp} resolves with: `imageData` (default), a `canvas` (`OffscreenCanvas` where available) or an encoded `blob`. */
export type OutputKind = 'imageData' | 'canvas' | 'blob';
/** Options for {@link warp}. */
export interface WarpOptions extends OutputOptions {
  /** Result type. Default `imageData`. */
  output?: OutputKind;
  /** Encoding for `output: 'blob'`. Default `image/png`. */
  type?: string;
  /** Encoder quality 0-1 for lossy `type`s. */
  quality?: number;
  /** Run in Web Workers (default true). Falls back to the main thread automatically. */
  worker?: boolean;
  /** Cancels the warp; the promise rejects with an AbortError. */
  signal?: AbortSignal;
}
/** The image type {@link warp} produces, chosen by `output` in the options. */
export type WarpOutput<O extends WarpOptions | undefined> = O extends {
  output: 'canvas';
} ? HTMLCanvasElement | OffscreenCanvas : O extends {
  output: 'blob';
} ? Blob : ImageData;
/** What {@link warp} resolves with. */
export interface AsyncWarpResult<I> extends WarpResult<I> {
  /** True when the pixels were computed in workers. */
  readonly usedWorker: boolean;
}
/**
 * Applies `transform` to any supported image source. The coordinate transform
 * (if any) runs here on the main thread on a coarse grid; resampling runs in workers.
 */
export declare function warp<O extends WarpOptions | undefined = undefined>(input: ImageInput, transform: Transform, options?: O): Promise<AsyncWarpResult<WarpOutput<O>>>;
//#endregion
//# sourceMappingURL=warp.d.ts.map