/**
 * Worker-side message handling, kept free of worker globals so it can be tested directly.
 */
import { compile, isMonochrome, processPixels, resolveMode, type Program, type ResolvedMode } from '../core/process.js';
import { countPixels, resolveForPixels } from '../core/histogram.js';
import { configureWasm } from '../core/wasm.js';
import type { OpSpec } from '../types.js';
import type { Post as SharedPost } from '@browser-image/workers';
import type { WorkerRequest, WorkerResponse } from './protocol.js';

export type Post = SharedPost<WorkerResponse>;

export function createWorkerHandler(post: Post): (request: WorkerRequest) => void {
  const held = new Map<number, { buffer: ArrayBuffer; width: number }>();
  // Strips of one image arrive with the same ops; reuse the compiled tables.
  let cacheKey = '';
  let cached: Program | null = null;

  function program(ops: OpSpec[], mode: ResolvedMode): Program {
    const key = mode + JSON.stringify(ops);
    if (key !== cacheKey || !cached) {
      cached = compile(ops, mode);
      cacheKey = key;
    }
    return cached;
  }

  function finish(id: number, buffer: ArrayBuffer, width: number, ops: OpSpec[], mode: ResolvedMode, wasm: boolean): void {
    configureWasm({ enabled: wasm });
    const pixels = new Uint8ClampedArray(buffer);
    processPixels(pixels, pixels, program(ops, mode), width);
    post({ type: 'done', id, buffer, mode }, [buffer]);
  }

  return (request) => {
    const id = request.id;
    try {
      switch (request.type) {
        case 'run': {
          const pixels = new Uint8ClampedArray(request.buffer);
          const mode = resolveMode(pixels, request.colorMode);
          finish(id, request.buffer, request.width, resolveForPixels(request.ops, pixels, mode), mode, request.wasm);
          break;
        }
        case 'detect': {
          const { buffer, width, core } = request;
          held.set(id, { buffer, width });
          const pixels = new Uint8ClampedArray(buffer);
          const rect = { x: 0, y: core[0], width, height: core[1] - core[0] };
          const stats = request.stats ? countPixels(pixels, width, request.stats, rect) : null;
          post({ type: 'detected', id, mono: isMonochrome(pixels), stats });
          break;
        }
        case 'process': {
          const strip = held.get(id);
          if (!strip) throw new Error(`No strip held for job ${id}.`);
          held.delete(id);
          finish(id, strip.buffer, strip.width, request.ops, request.mode, request.wasm);
          break;
        }
        case 'release':
          held.delete(id);
          break;
      }
    } catch (e) {
      post({ type: 'error', id, message: e instanceof Error ? e.message : String(e) });
    }
  };
}
