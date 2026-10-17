/**
 * Decodes the LZW tiles geotiff.js reads for the map in the library's
 * worker pool with the fast decoder (lzw.ts), instead of geotiff.js's own.
 */
import { getPool } from '../worker/pool.js';
import { decodeLzwBlock, type PredictorParameters } from './lzw.js';
import { nextWorkerId } from './worker-ids.js';

/** The part of a geotiff.js decoder (or a pool's bound decoder) that reads a tile. */
interface BlockDecoder {
  decode(buffer: ArrayBuffer): Promise<ArrayBuffer> | ArrayBuffer;
}

/** The block decoded in a worker, or null when no worker can run (`buffer` is then untouched). */
export async function decodeLzwInWorker(buffer: ArrayBuffer, parameters: PredictorParameters): Promise<ArrayBuffer | null> {
  if (typeof Worker === 'undefined') return null;
  const pool = getPool();
  if (!pool.available) return null;
  let slot;
  try {
    [slot] = await pool.acquire(1);
  } catch {
    return null;
  }
  const response = await pool.request(slot, { type: 'lzw', id: nextWorkerId(), buffer, parameters }, [buffer]);
  if (response.type !== 'lzwDecoded') throw new Error('The worker did not decode the tile.');
  return response.buffer;
}

/** The part of geotiff.js's `GeoTIFFImage` read here. */
interface TiffImage {
  planarConfiguration: number;
  getTileWidth(): number;
  getTileHeight(): number;
  fileDirectory: { getValue(tag: string): unknown };
}

/**
 * For an LZW image, a decoder that runs the fast decoder in the worker pool
 * (on this thread where there is none); `fallback`, what geotiff.js would
 * have used, for any other image. Where the pool cannot run, `fallback`
 * decodes too.
 */
export function lzwDecoderFor(img: TiffImage, fallback: unknown): unknown {
  let parameters: PredictorParameters;
  try {
    if (Number(img.fileDirectory.getValue('Compression')) !== 5) return fallback;
    const bits = img.fileDirectory.getValue('BitsPerSample') as number | ArrayLike<number> | undefined;
    if (bits === undefined) return fallback;
    parameters = {
      tileWidth: img.getTileWidth(),
      tileHeight: img.getTileHeight(),
      planarConfiguration: img.planarConfiguration,
      bitsPerSample: typeof bits === 'number' ? bits : Array.from(bits, Number),
      predictor: Number(img.fileDirectory.getValue('Predictor') ?? 1) || 1,
    };
  } catch {
    // A tag not read yet: leave the image to geotiff.js.
    return fallback;
  }
  const original = fallback as BlockDecoder | null;
  return {
    decode: async (buffer: ArrayBuffer) => {
      const decoded = await decodeLzwInWorker(buffer, parameters);
      if (decoded) return decoded;
      return original && typeof original.decode === 'function' ? original.decode(buffer) : decodeLzwBlock(buffer, parameters);
    },
  } satisfies BlockDecoder;
}
