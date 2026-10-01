/**
 * Runs a chain of normalized ops on an image, in workers when possible.
 *
 * The image is cut into horizontal strips, one per worker. Each strip's pixels
 * are copied once into their own buffer and transferred to the worker and back.
 * In `auto` color mode with several strips, workers first report whether their
 * strip is monochrome so the whole image is computed in one mode.
 */
import { type ResolvedMode } from '../core/process.js';
import type { ColorMode, ImageDataLike, OpSpec } from '../types.js';
import { type WorkerPool } from './pool.js';
export interface ExecuteOptions {
    colorMode?: ColorMode;
    /** Use workers (default true). Falls back to the main thread when they cannot start. */
    worker?: boolean;
    signal?: AbortSignal;
    /** Pool to use; defaults to the shared one. */
    pool?: WorkerPool;
}
export interface ExecuteResult {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    /** The mode pixels were computed in. */
    mode: ResolvedMode;
    /** True when the work ran in workers. */
    usedWorker: boolean;
}
export declare function abortError(signal?: AbortSignal): Error;
/** Processes on the calling thread. */
export declare function executeOnMainThread(image: ImageDataLike, ops: readonly OpSpec[], colorMode?: ColorMode): ExecuteResult;
/** Splits `height` rows into `count` contiguous ranges of near-equal size. */
export declare function splitRows(height: number, count: number): Array<[start: number, end: number]>;
export declare function execute(image: ImageDataLike, ops: readonly OpSpec[], options?: ExecuteOptions): Promise<ExecuteResult>;
//# sourceMappingURL=executor.d.ts.map