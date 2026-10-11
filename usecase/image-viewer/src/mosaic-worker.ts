/**
 * Makes one block of a mosaic off the main thread: each image looked up
 * through its mesh and laid under the ones before it (see mosaic.ts), then
 * cut into the tiles of the GeoTIFF being written.
 */
import type { CompositeBlock } from './composite.js';
import { makeMosaicBlock, type MosaicTask } from './mosaic.js';

export type MosaicReply = { ok: true; block: CompositeBlock } | { ok: false; message: string };

const post = (reply: MosaicReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(reply, transfer);

self.onmessage = (e: MessageEvent<MosaicTask>) => {
  try {
    const block = makeMosaicBlock(e.data);
    post({ ok: true, block }, block.tiles.map((t) => t.bytes.buffer as ArrayBuffer));
  } catch (error) {
    post({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
};
