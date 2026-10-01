/**
 * Worker-side message handling, kept free of worker globals so it can be tested directly.
 */
import { compile, isMonochrome, processPixels, resolveMode, type Program, type ResolvedMode } from '../core/process.js';
import { countPixels, resolveForPixels } from '../core/histogram.js';
import type { OpSpec } from '../types.js';
import type { Post as SharedPost } from '@browser-image/workers';
import type { WorkerRequest, WorkerResponse } from './protocol.js';

export type Post = SharedPost<WorkerResponse>;

export function createWorkerHandler(post: Post): (request: WorkerRequest) => void {
  const held = new Map<number, ArrayBuffer>();
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

  function finish(id: number, buffer: ArrayBuffer, ops: OpSpec[], mode: ResolvedMode): void {
    const pixels = new Uint8ClampedArray(buffer);
    processPixels(pixels, pixels, program(ops, mode));
    post({ type: 'done', id, buffer, mode }, [buffer]);
  }

  return (request) => {
    const id = request.id;
    try {
      switch (request.type) {
        case 'run': {
          const pixels = new Uint8ClampedArray(request.buffer);
          const mode = resolveMode(pixels, request.colorMode);
          finish(id, request.buffer, resolveForPixels(request.ops, pixels, mode), mode);
          break;
        }
        case 'detect': {
          held.set(id, request.buffer);
          const pixels = new Uint8ClampedArray(request.buffer);
          const stats = request.stats ? countPixels(pixels, Math.max(1, pixels.length >> 2), request.stats) : null;
          post({ type: 'detected', id, mono: isMonochrome(pixels), stats });
          break;
        }
        case 'process': {
          const buffer = held.get(id);
          if (!buffer) throw new Error(`No strip held for job ${id}.`);
          held.delete(id);
          finish(id, buffer, request.ops, request.mode);
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
