/** Runs {@link runPanSharpen} off the main thread. */
import { runPanSharpen, type PanSharpenJob, type PanSharpenOutput } from './pansharpen.js';

export type PanSharpenReply = { ok: true; output: PanSharpenOutput } | { ok: false; message: string };

self.onmessage = (e: MessageEvent<PanSharpenJob>) => {
  try {
    const output = runPanSharpen(e.data);
    const reply: PanSharpenReply = { ok: true, output };
    (self as unknown as Worker).postMessage(reply, [output.raster.data.buffer as ArrayBuffer]);
  } catch (error) {
    const reply: PanSharpenReply = { ok: false, message: error instanceof Error ? error.message : String(error) };
    (self as unknown as Worker).postMessage(reply);
  }
};
