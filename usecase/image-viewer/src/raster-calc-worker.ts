/** Makes blocks of a raster calculation (raster-calc.ts) off the main thread. */
import { makeCalcBlock, type CalcBlock, type CalcTask } from './raster-calc.js';

export type CalcReply = { ok: true; block: CalcBlock } | { ok: false; message: string };

const post = (reply: CalcReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(reply, transfer);

self.onmessage = (e: MessageEvent<CalcTask>) => {
  try {
    const block = makeCalcBlock(e.data);
    post({ ok: true, block }, block.tiles.map((t) => t.bytes.buffer as ArrayBuffer));
  } catch (error) {
    post({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
};
