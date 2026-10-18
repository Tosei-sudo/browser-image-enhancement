/**
 * Compresses tiles and halves 2 × 2 blocks of them into overview tiles off
 * the main thread, for cog.ts.
 */
import { encodeTile, reduceQuad } from './cog-codec.js';
import type { CogJob, CogReply } from './cog.js';

const post = (reply: CogReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(reply, transfer);

self.onmessage = async (e: MessageEvent<CogJob>) => {
  const job = e.data;
  try {
    if (job.kind === 'encode') {
      const encoded = await encodeTile(job);
      post({ ok: true, encoded }, [encoded.buffer as ArrayBuffer]);
    } else {
      const raw = reduceQuad(job.reduce);
      const encoded = await encodeTile({ tile: raw.slice(), size: job.reduce.size, bands: job.reduce.bands, compress: job.compress });
      post({ ok: true, encoded, raw }, [encoded.buffer as ArrayBuffer, raw.buffer as ArrayBuffer]);
    }
  } catch (error) {
    post({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
};
