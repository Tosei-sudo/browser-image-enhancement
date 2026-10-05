/** Runs {@link orthorectify} (RPC) or {@link simpleOrthorectify} (sensor angles) off the main thread. */
import { orthorectify, type OrthoInput, type OrthoResult } from './ortho.js';
import { simpleOrthorectify, type SimpleOrthoInput } from './simple-ortho.js';

export type OrthoReply = { ok: true; result: OrthoResult } | { ok: false; message: string };

self.onmessage = (e: MessageEvent<OrthoInput | SimpleOrthoInput>) => {
  try {
    const input = e.data;
    const result = 'toMap' in input ? simpleOrthorectify(input) : orthorectify(input);
    const reply: OrthoReply = { ok: true, result };
    (self as unknown as Worker).postMessage(reply, [result.raster.data.buffer as ArrayBuffer]);
  } catch (error) {
    const reply: OrthoReply = { ok: false, message: error instanceof Error ? error.message : String(error) };
    (self as unknown as Worker).postMessage(reply);
  }
};
