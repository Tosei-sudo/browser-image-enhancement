/**
 * A geotiff.js decoder that turns complex SAR samples (I and Q, or amplitude
 * and phase) into detected amplitude, so a SICD's (or complex NITF's) pixel
 * data can be read in place as a one-band float image: see nitf-tiff.ts,
 * which points the tiles of a TIFF header at the NITF's data and marks them
 * with {@link COMPLEX_COMPRESSION}.
 *
 * Import this module (for its side effect) wherever geotiff.js reads such an
 * image: it registers the decoder with geotiff.js in that thread.
 */
import { addDecoder, BaseDecoder } from 'geotiff';

/** The private TIFF compression code of complex samples read as amplitude. */
export const COMPLEX_COMPRESSION = 65099;
/** The private TIFF tag (DOUBLE) holding the sample kind, then for amplitude / phase its amplitude table (256 values). */
export const COMPLEX_TAG = 65098;

/** How the complex samples are stored: big-endian I, Q pairs of 16-bit integers or 32-bit floats, or 8-bit amplitude and phase. */
export const ComplexKind = { Int16: 1, Float32: 2, AmpPhase8: 3, Int8: 4 } as const;
export type ComplexKind = (typeof ComplexKind)[keyof typeof ComplexKind];

/** Amplitude of the complex samples in `buffer`, as big-endian 32-bit floats. */
export function complexToAmplitude(buffer: ArrayBufferLike, kind: ComplexKind, table?: ArrayLike<number>): ArrayBuffer {
  const input = new DataView(buffer);
  const bytes = kind === ComplexKind.Float32 ? 8 : kind === ComplexKind.Int16 ? 4 : 2;
  const n = Math.floor(input.byteLength / bytes);
  const out = new ArrayBuffer(n * 4);
  const view = new DataView(out);
  for (let i = 0; i < n; i++) {
    let a: number;
    if (kind === ComplexKind.Float32) a = Math.hypot(input.getFloat32(i * 8, false), input.getFloat32(i * 8 + 4, false));
    else if (kind === ComplexKind.Int16) {
      const re = input.getInt16(i * 4, false);
      const im = input.getInt16(i * 4 + 2, false);
      a = Math.sqrt(re * re + im * im);
    } else if (kind === ComplexKind.Int8) {
      const re = input.getInt8(i * 2);
      const im = input.getInt8(i * 2 + 1);
      a = Math.sqrt(re * re + im * im);
    } else {
      const m = input.getUint8(i * 2);
      a = table ? table[m] : m;
    }
    view.setFloat32(i * 4, a, false);
  }
  return out;
}

interface ComplexParameters {
  complexKind: ComplexKind;
  ampTable?: number[];
}

class ComplexDecoder extends BaseDecoder {
  override decodeBlock(buffer: ArrayBufferLike): ArrayBuffer {
    const { complexKind, ampTable } = this.parameters as unknown as ComplexParameters;
    return complexToAmplitude(buffer, complexKind, ampTable);
  }
}

addDecoder(
  COMPLEX_COMPRESSION,
  () => Promise.resolve(ComplexDecoder),
  async (fd) => {
    const isTiled = !fd.hasTag('StripOffsets');
    const raw = (await fd.loadValue(COMPLEX_TAG)) as number | ArrayLike<number>;
    const values = typeof raw === 'number' ? [raw] : Array.from(raw, Number);
    return {
      tileWidth: Number(await fd.loadValue(isTiled ? 'TileWidth' : 'ImageWidth')),
      tileHeight: Number(isTiled ? await fd.loadValue('TileLength') : ((await fd.loadValue('RowsPerStrip')) ?? (await fd.loadValue('ImageLength')))),
      planarConfiguration: 1,
      bitsPerSample: 32,
      predictor: 1,
      complexKind: values[0] as ComplexKind,
      ...(values.length > 1 ? { ampTable: values.slice(1) } : {}),
    } as ConstructorParameters<typeof BaseDecoder>[0];
  },
  // Cheap, and geotiff.js's worker pool would not know this decoder.
  false,
);
