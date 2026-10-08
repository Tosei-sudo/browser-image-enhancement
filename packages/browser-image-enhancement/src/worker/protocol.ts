import type { ResolvedMode } from '../core/process.js';
import type { ColorMode, Histogram, OpSpec } from '../types.js';

/**
 * Messages from the main thread to a worker. Pixel buffers are transferred, not copied.
 *
 * A strip carries `width` pixels per row. When the steps read neighbouring
 * pixels (`sharpen`), it also carries rows of margin above and below its own
 * rows, which are `core` (first row, end row) within the buffer; the margin
 * rows are processed too but only the core rows are used, and only they are
 * counted for statistics.
 *
 * - `run`: resolve the color mode (and any `autoStretch`) on this buffer alone,
 *   process it, send it back.
 * - `detect` + `process`: two-phase form for an image split across workers in
 *   `auto` mode or with `autoStretch`. The worker keeps the strip between the
 *   two messages and reports whether it is monochrome and, when `stats` is set,
 *   its histogram, so the main thread can decide one mode and one stretch for
 *   the whole image. `process` carries the resolved ops.
 * - `release`: drop a strip held after `detect` (the job was cancelled).
 *
 * `wasm` passes on the main thread's `configureWasm` setting.
 */
export type WorkerRequest =
  | { type: 'run'; id: number; buffer: ArrayBuffer; width: number; ops: OpSpec[]; colorMode: ColorMode; wasm: boolean }
  | { type: 'detect'; id: number; buffer: ArrayBuffer; width: number; core: [number, number]; stats: ResolvedMode | null }
  | { type: 'process'; id: number; ops: OpSpec[]; mode: ResolvedMode; wasm: boolean }
  | { type: 'release'; id: number };

/** Answers to requests. `ready` and `error` are sent too; see `ControlResponse` in @browser-image/workers. */
export type WorkerResponse =
  | { type: 'detected'; id: number; mono: boolean; stats: Histogram | null }
  | { type: 'done'; id: number; buffer: ArrayBuffer; mode: ResolvedMode };
