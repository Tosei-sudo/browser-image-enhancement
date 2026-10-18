/**
 * The per-tile work of making a COG (cog.ts): halving a 2 × 2 block of tiles
 * into one tile of the next overview, and compressing a tile (the TIFF
 * predictor, then Deflate). Plain functions, run in cog-worker.ts.
 */
import type { TileSamples } from './tiff-stream.js';

/** The sample types a tile can hold, by name (structured-clone friendly). */
export type SampleKind = 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32' | 'f64';

const TYPES: Record<SampleKind, new (n: number | ArrayBuffer) => TileSamples> = {
  u8: Uint8Array,
  i8: Int8Array,
  u16: Uint16Array,
  i16: Int16Array,
  u32: Uint32Array,
  i32: Int32Array,
  f32: Float32Array,
  f64: Float64Array,
};

/** The typed array of `kind`. */
export function typeOf(kind: SampleKind): new (n: number | ArrayBuffer) => TileSamples {
  return TYPES[kind];
}

/** The kind of `samples`. */
export function kindOf(samples: TileSamples): SampleKind {
  return (Object.keys(TYPES) as SampleKind[]).find((k) => samples instanceof TYPES[k])!;
}

/** Whether `kind` holds floating point values. */
export function isFloat(kind: SampleKind): boolean {
  return kind === 'f32' || kind === 'f64';
}

export interface ReduceTask {
  /** 2·size × 2·size pixels, `bands` interleaved samples each. */
  quad: TileSamples;
  size: number;
  bands: number;
  /** Pixels of the block inside the image (the rest is padding). */
  validWidth: number;
  validHeight: number;
  /** A value that marks no data, left out of averages. */
  noData: number | null;
  /** `average` of the pixels with data, or `nearest` (the top-left one, for classes). */
  mode: 'average' | 'nearest';
}

/** One tile of the next overview from a 2 × 2 block: `size` × `size` pixels; outside the image, the no-data value (or 0). */
export function reduceQuad({ quad, size, bands, validWidth, validHeight, noData, mode }: ReduceTask): TileSamples {
  const Type = quad.constructor as new (n: number) => TileSamples;
  const out = new Type(size * size * bands);
  const fill = noData ?? 0;
  const integer = !(quad instanceof Float32Array || quad instanceof Float64Array);
  const w = Math.ceil(validWidth / 2);
  const h = Math.ceil(validHeight / 2);
  const row = 2 * size * bands;
  const nan = noData !== null && Number.isNaN(noData);
  if (fill !== 0) out.fill(fill);
  for (let y = 0; y < h; y++) {
    const y0 = 2 * y;
    const y1 = Math.min(y0 + 1, validHeight - 1);
    for (let x = 0; x < w; x++) {
      const x0 = 2 * x;
      const x1 = Math.min(x0 + 1, validWidth - 1);
      const o = (y * size + x) * bands;
      if (mode === 'nearest') {
        const i = y0 * row + x0 * bands;
        for (let b = 0; b < bands; b++) out[o + b] = quad[i + b];
        continue;
      }
      for (let b = 0; b < bands; b++) {
        let sum = 0;
        let n = 0;
        // The four pixels, each once (an odd edge repeats a pixel; it is counted once).
        for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            const v = quad[yy * row + xx * bands + b];
            if (noData !== null && (nan ? Number.isNaN(v) : v === noData)) continue;
            if (Number.isNaN(v)) continue;
            sum += v;
            n++;
          }
        }
        out[o + b] = n ? (integer ? Math.round(sum / n) : sum / n) : fill;
      }
    }
  }
  return out;
}

/** The TIFF predictor for `kind`: 2 (horizontal differencing) for integers, 3 (floating point) for floats. */
export function predictorOf(kind: SampleKind): 2 | 3 {
  return isFloat(kind) ? 3 : 2;
}

/**
 * Applies the TIFF predictor to a tile in place (`samples` of `width`
 * pixels a row, `bands` each): 2 subtracts each sample's left neighbour,
 * 3 splits each row's values into byte planes (most significant first) and
 * subtracts each byte's left neighbour. Little-endian; the bytes it returns
 * are the tile as written.
 */
export function predict(samples: TileSamples, width: number, bands: number, predictor: 1 | 2 | 3): Uint8Array {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  if (predictor === 1) return bytes;
  const rowSamples = width * bands;
  const rows = samples.length / rowSamples;
  if (predictor === 2) {
    for (let r = 0; r < rows; r++) {
      const start = r * rowSamples;
      for (let i = start + rowSamples - 1; i >= start + bands; i--) samples[i] = samples[i] - samples[i - bands];
    }
    return bytes;
  }
  const size = samples.BYTES_PER_ELEMENT;
  const rowBytes = rowSamples * size;
  const out = new Uint8Array(bytes.length);
  for (let r = 0; r < rows; r++) {
    const from = r * rowBytes;
    // Byte planes, most significant first (the samples are little-endian).
    for (let i = 0; i < rowSamples; i++) for (let k = 0; k < size; k++) out[from + k * rowSamples + i] = bytes[from + i * size + (size - 1 - k)];
    for (let i = from + rowBytes - 1; i >= from + bands; i--) out[i] = (out[i] - out[i - bands]) & 0xff;
  }
  return out;
}

/** `bytes` compressed as zlib (TIFF compression 8, Deflate). */
export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface EncodeTask {
  tile: TileSamples;
  size: number;
  bands: number;
  compress: boolean;
}

/** A tile as written into the file: as it is, or predicted and compressed (it may change `tile`). */
export async function encodeTile({ tile, size, bands, compress }: EncodeTask): Promise<Uint8Array> {
  if (!compress) return new Uint8Array(tile.buffer, tile.byteOffset, tile.byteLength);
  return deflate(predict(tile, size, bands, predictorOf(kindOf(tile))));
}
