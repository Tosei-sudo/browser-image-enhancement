/** Runs {@link orthorectify} off the main thread. */
import { orthorectify, type OrthoInput, type OrthoResult } from './ortho.js';

export type OrthoReply = { ok: true; result: OrthoResult } | { ok: false; message: string };

self.onmessage = (e: MessageEvent<OrthoInput>) => {
  try {
    const result = orthorectify(e.data);
    const reply: OrthoReply = { ok: true, result };
    (self as unknown as Worker).postMessage(reply, [result.raster.data.buffer as ArrayBuffer]);
  } catch (error) {
    const reply: OrthoReply = { ok: false, message: error instanceof Error ? error.message : String(error) };
    (self as unknown as Worker).postMessage(reply);
  }
};
