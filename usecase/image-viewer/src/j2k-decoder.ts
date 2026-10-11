/**
 * Decodes the JPEG 2000 tiles of a NITF read as a TIFF (see j2k.ts) with
 * OpenJPEG built to WebAssembly (@cornerstonejs/codec-openjpeg), bundled
 * with the site so it works without a network. Loaded on first use.
 */
import { BaseDecoder } from 'geotiff';
import OpenJPEGWASM from '@cornerstonejs/codec-openjpeg/decodewasmjs';
import wasmUrl from '@cornerstonejs/codec-openjpeg/decodewasm?url';
import { tileCodestream } from './j2k.js';

interface J2kDecoderInstance {
  getEncodedBuffer(length: number): Uint8Array;
  getDecodedBuffer(): Uint8Array;
  decode(): void;
  getFrameInfo(): { width: number; height: number; bitsPerSample: number; componentCount: number; isSigned: boolean };
  delete(): void;
}

let codec: Promise<{ J2KDecoder: new () => J2kDecoderInstance }> | null = null;

/** The OpenJPEG module, loaded once (in a browser, from the bundled .wasm file). */
function openjpeg() {
  const browser = typeof window !== 'undefined' || typeof importScripts === 'function';
  codec ??= OpenJPEGWASM(browser ? { locateFile: () => wasmUrl } : {});
  return codec;
}

declare function importScripts(...urls: string[]): void;

/**
 * Decodes one JPEG 2000 codestream: its samples, components interleaved,
 * 8-bit or (for deeper ones) 16-bit in the platform's byte order.
 */
export async function decodeJ2k(codestream: Uint8Array): Promise<{ width: number; height: number; components: number; bytes: number; data: Uint8Array }> {
  const { J2KDecoder } = await openjpeg();
  const decoder = new J2KDecoder();
  try {
    decoder.getEncodedBuffer(codestream.length).set(codestream);
    decoder.decode();
    const info = decoder.getFrameInfo();
    const data = decoder.getDecodedBuffer().slice();
    return { width: info.width, height: info.height, components: info.componentCount, bytes: info.bitsPerSample > 8 ? 2 : 1, data };
  } finally {
    decoder.delete();
  }
}

interface J2kParameters {
  tileWidth: number;
  tileHeight: number;
  bitsPerSample: number[];
  j2kHeader: Uint8Array;
}

/** A tile of the TIFF: decoded, padded to the full tile size, samples big-endian as the TIFF says. */
export default class J2kTileDecoder extends BaseDecoder {
  override async decodeBlock(buffer: ArrayBufferLike): Promise<ArrayBuffer> {
    const { tileWidth, tileHeight, bitsPerSample, j2kHeader } = this.parameters as unknown as J2kParameters;
    const { codestream } = tileCodestream(j2kHeader, new Uint8Array(buffer));
    const tile = await decodeJ2k(codestream);
    const samples = bitsPerSample.length;
    const bytes = bitsPerSample[0] / 8;
    const out = new Uint8Array(tileWidth * tileHeight * samples * bytes);
    const src = new DataView(tile.data.buffer, tile.data.byteOffset, tile.data.byteLength);
    const dst = new DataView(out.buffer);
    const comps = Math.min(samples, tile.components);
    const w = Math.min(tile.width, tileWidth);
    const h = Math.min(tile.height, tileHeight);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const from = (y * tile.width + x) * tile.components;
        const to = (y * tileWidth + x) * samples;
        for (let c = 0; c < comps; c++) {
          if (bytes === 1) out[to + c] = tile.bytes === 1 ? tile.data[from + c] : src.getUint16((from + c) * 2, true) >> 8;
          else dst.setUint16((to + c) * 2, tile.bytes === 2 ? src.getUint16((from + c) * 2, true) : tile.data[from + c], false);
        }
      }
    }
    return out.buffer;
  }
}
