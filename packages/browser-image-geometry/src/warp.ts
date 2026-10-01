/** Asynchronous API: any image source in, the requested output type back, in workers by default. */
import { assertImageData, toBlob, toCanvas, toImageData, type ImageInput } from '@browser-image/workers';
import type { WarpResult } from './functional.js';
import { planWarp, type OutputOptions } from './plan.js';
import type { Transform } from './types.js';
import { execute } from './worker/executor.js';

export type OutputKind = 'imageData' | 'canvas' | 'blob';

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

export type WarpOutput<O extends WarpOptions | undefined> = O extends { output: 'canvas' }
  ? HTMLCanvasElement | OffscreenCanvas
  : O extends { output: 'blob' }
    ? Blob
    : ImageData;

export interface AsyncWarpResult<I> extends WarpResult<I> {
  /** True when the pixels were computed in workers. */
  readonly usedWorker: boolean;
}

/**
 * Applies `transform` to any supported image source. The coordinate transform
 * (if any) runs here on the main thread on a coarse grid; resampling runs in workers.
 */
export async function warp<O extends WarpOptions | undefined = undefined>(
  input: ImageInput,
  transform: Transform,
  options?: O,
): Promise<AsyncWarpResult<WarpOutput<O>>> {
  const opts: WarpOptions = options ?? {};
  const source = await toImageData(input);
  assertImageData(source);
  const plan = planWarp(source.width, source.height, transform, opts);
  const { image, usedWorker } = await execute(source, plan, { worker: opts.worker, signal: opts.signal });
  let out: unknown;
  switch (opts.output ?? 'imageData') {
    case 'imageData':
      out = image;
      break;
    case 'canvas':
      out = toCanvas(image);
      break;
    case 'blob':
      out = await toBlob(image, opts.type, opts.quality);
      break;
    default:
      throw new TypeError(`Unknown output: ${String(opts.output)}`);
  }
  return {
    image: out as WarpOutput<O>,
    width: plan.width,
    height: plan.height,
    geoTransform: plan.geoTransform,
    extent: plan.extent,
    usedWorker,
  };
}
