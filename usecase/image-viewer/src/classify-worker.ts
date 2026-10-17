/** Makes blocks of a classification (classify-block.ts) off the main thread. */
import { classifyBlock, sampleBlock, type ClassifyResult, type ClassifyTask, type SampleResult, type SampleTask } from './classify-block.js';

export type ClassifyReply = { ok: true; result: SampleResult | ClassifyResult } | { ok: false; message: string };

const post = (reply: ClassifyReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(reply, transfer);

self.onmessage = (e: MessageEvent<SampleTask | ClassifyTask>) => {
  try {
    if (e.data.op === 'sample') {
      const result = sampleBlock(e.data);
      post({ ok: true, result }, [result.samples.buffer as ArrayBuffer]);
    } else {
      const result = classifyBlock(e.data);
      post({ ok: true, result }, [...result.classTiles, ...result.colorTiles].map((t) => t.bytes.buffer as ArrayBuffer));
    }
  } catch (error) {
    post({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
};
