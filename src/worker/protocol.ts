import type { ResolvedMode } from '../core/process.js';
import type { ColorMode, OpSpec } from '../types.js';

/**
 * Messages from the main thread to a worker. Pixel buffers are transferred, not copied.
 *
 * - `run`: resolve the color mode on this buffer alone, process it, send it back.
 * - `detect` + `process`: two-phase form for an image split across workers in
 *   `auto` mode. The worker keeps the strip between the two messages so the
 *   main thread can decide one mode for the whole image.
 * - `release`: drop a strip held after `detect` (the job was cancelled).
 */
export type WorkerRequest =
  | { type: 'run'; id: number; buffer: ArrayBuffer; ops: OpSpec[]; colorMode: ColorMode }
  | { type: 'detect'; id: number; buffer: ArrayBuffer }
  | { type: 'process'; id: number; ops: OpSpec[]; mode: ResolvedMode }
  | { type: 'release'; id: number };

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'detected'; id: number; mono: boolean }
  | { type: 'done'; id: number; buffer: ArrayBuffer; mode: ResolvedMode }
  | { type: 'error'; id: number; message: string };
