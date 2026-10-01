import type { Mapping } from '../resample.js';
import type { RGBA, Resample } from '../types.js';

/**
 * Main thread → worker. Each request renders output rows `[y0, y1)` from the
 * source rectangle in `window` (null when the rows read no source pixels).
 * The window buffer is transferred.
 */
export type WorkerRequest = {
  type: 'warp';
  id: number;
  window: { buffer: ArrayBuffer; width: number; height: number; x0: number; y0: number } | null;
  width: number;
  y0: number;
  y1: number;
  mapping: Mapping;
  resample: Resample;
  background: RGBA;
};

/** The rendered rows, RGBA, transferred back. */
export type WorkerResponse = { type: 'done'; id: number; buffer: ArrayBuffer };
