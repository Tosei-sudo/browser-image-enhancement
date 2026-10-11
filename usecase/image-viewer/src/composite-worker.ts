/**
 * Makes one block of a color composite off the main thread: each band
 * looked up in its image through the mesh (see composite.ts), then cut into
 * the tiles of the GeoTIFF being written.
 */
import { makeBlock, type CompositeBlock, type CompositeTask } from './composite.js';

export type { CompositeBlock, CompositeTask } from './composite.js';

export type CompositeReply = { ok: true; block: CompositeBlock } | { ok: false; message: string };

const post = (reply: CompositeReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(reply, transfer);

self.onmessage = (e: MessageEvent<CompositeTask>) => {
  try {
    const block = makeBlock(e.data);
    post({ ok: true, block }, block.tiles.map((t) => t.bytes.buffer as ArrayBuffer));
  } catch (error) {
    post({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
};
