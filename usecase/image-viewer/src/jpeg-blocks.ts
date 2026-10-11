/**
 * The JPEG blocks of a NITF (IC C3 / M3) read as TIFF tiles: each block is
 * a whole JPEG stream, decoded by geotiff.js's JPEG decoder. Three-component
 * streams hold YCbCr (as in JFIF) unless an Adobe marker says they hold RGB,
 * so they are turned into RGB here; geotiff.js leaves that to the reader.
 *
 * Import this module (for its side effect) wherever such an image is read.
 */
import { addDecoder, BaseDecoder, getDecoder } from 'geotiff';

/** The private TIFF compression code of NITF JPEG blocks. */
export const NITF_JPEG_COMPRESSION = 65101;

/** Whether a JPEG stream says its three components are RGB (an Adobe APP14 marker with transform 0). */
export function jpegIsRgb(bytes: Uint8Array): boolean {
  for (let p = 2; p + 4 <= bytes.length && bytes[p] === 0xff; ) {
    const marker = bytes[p + 1];
    if (marker === 0xda) break; // SOS: no more header markers
    const length = (bytes[p + 2] << 8) | bytes[p + 3];
    if (marker === 0xee && length >= 12 && String.fromCharCode(...bytes.subarray(p + 4, p + 9)) === 'Adobe') return bytes[p + 15] === 0;
    p += 2 + length;
  }
  return false;
}

/** YCbCr (full range, as in JFIF) to RGB, in place, 8-bit samples interleaved. */
export function ycbcrToRgb(data: Uint8Array): void {
  for (let i = 0; i + 2 < data.length; i += 3) {
    const y = data[i];
    const cb = data[i + 1] - 128;
    const cr = data[i + 2] - 128;
    data[i] = clamp(y + 1.402 * cr);
    data[i + 1] = clamp(y - 0.344136 * cb - 0.714136 * cr);
    data[i + 2] = clamp(y + 1.772 * cb);
  }
}

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

interface JpegParameters {
  tileWidth: number;
  tileHeight: number;
  samplesPerPixel: number;
}

class NitfJpegDecoder extends BaseDecoder {
  override async decodeBlock(buffer: ArrayBufferLike): Promise<ArrayBufferLike> {
    const { tileWidth, tileHeight, samplesPerPixel } = this.parameters as unknown as JpegParameters;
    const jpeg = await getDecoder(7, { tileWidth, tileHeight, planarConfiguration: 1, bitsPerSample: 8, predictor: 1 });
    const decoded = await jpeg.decode(buffer as ArrayBuffer);
    if (samplesPerPixel === 3 && !jpegIsRgb(new Uint8Array(buffer))) ycbcrToRgb(new Uint8Array(decoded));
    return decoded;
  }
}

addDecoder(
  NITF_JPEG_COMPRESSION,
  () => Promise.resolve(NitfJpegDecoder),
  async (fd) => {
    const planar = Number(await fd.loadValue('PlanarConfiguration')) === 2;
    return {
      tileWidth: Number(await fd.loadValue('TileWidth')),
      tileHeight: Number(await fd.loadValue('TileLength')),
      planarConfiguration: planar ? 2 : 1,
      bitsPerSample: 8,
      predictor: 1,
      samplesPerPixel: planar ? 1 : Number(await fd.loadValue('SamplesPerPixel')),
    } as ConstructorParameters<typeof BaseDecoder>[0];
  },
  false,
);
