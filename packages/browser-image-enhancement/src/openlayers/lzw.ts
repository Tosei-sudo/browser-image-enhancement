/**
 * A fast decoder for TIFF's LZW compression (the usual one of GDAL and
 * ArcGIS exports), with TIFF's predictors undone.
 *
 * geotiff.js's own LZW decoder builds each tile in a plain array, one value
 * at a time, with a new array for every code read: about 6 MB/s, so a 12
 * megapixel RGB image takes seconds. This one writes straight into a byte
 * array, each dictionary string copied from where it was first written, and
 * reads codes from a bit buffer: tens of times faster, with the same output
 * (including geotiff.js's handling of a full 12-bit table without a clear
 * code, and of data that ends without an end code).
 */

const CLEAR = 256;
const END = 257;
const FIRST = 258;
const MAX_CODES = 4096;

/**
 * The bytes LZW-compressed in `input`. `expected` (the size the block
 * should have, when known) sizes the output; it grows when there is more.
 */
export function decodeLzw(input: Uint8Array, expected = 0): Uint8Array<ArrayBuffer> {
  // Each code's string: where its bytes were first written in the output, and how long it is.
  const start = new Int32Array(MAX_CODES);
  const length = new Uint16Array(MAX_CODES);
  let out: Uint8Array<ArrayBuffer> = new Uint8Array(Math.max(expected, input.length * 2, 1024));
  let pos = 0;
  let next = FIRST;
  let bits = 9;
  // The previous code (-1: none, after a clear code or once the table is full), and where its string was written.
  let previous = -1;
  let previousStart = 0;
  const end = input.length * 8;
  let acc = 0;
  let held = 0;
  let read = 0;

  for (;;) {
    // Data that ends without an end code ends there.
    if (read * 8 - held >= end) break;
    // The next code, most significant bit first (zeros past the end).
    while (held < bits) {
      acc = ((acc << 8) | (read < input.length ? input[read] : 0)) & 0xffffff;
      read++;
      held += 8;
    }
    held -= bits;
    const code = (acc >>> held) & ((1 << bits) - 1);
    if (code === END) break;
    if (code === CLEAR) {
      next = FIRST;
      bits = 9;
      previous = -1;
      continue;
    }
    const at = pos;
    if (code < next) {
      // A known string: a byte, or copied from where it was first written.
      if (code < CLEAR) {
        if (pos + 1 > out.length) out = grow(out, pos, pos + 1);
        out[pos++] = code;
      } else {
        const len = length[code];
        if (pos + len > out.length) out = grow(out, pos, pos + len);
        const from = start[code];
        // Most strings are a few bytes, for which a loop beats copyWithin.
        if (len < 32) for (let k = 0; k < len; k++) out[pos + k] = out[from + k];
        else out.copyWithin(pos, from, from + len);
        pos += len;
      }
    } else {
      // The string being defined: the previous one and its own first byte.
      if (previous < 0) throw new Error(`Invalid LZW code: ${code} with no previous code`);
      const len = previous < CLEAR ? 1 : length[previous];
      if (pos + len + 1 > out.length) out = grow(out, pos, pos + len + 1);
      if (len < 32) for (let k = 0; k < len; k++) out[pos + k] = out[previousStart + k];
      else out.copyWithin(pos, previousStart, previousStart + len);
      out[pos + len] = out[pos];
      pos += len + 1;
    }
    if (previous >= 0) {
      // The previous string and the first byte of this one, which follows it in the output.
      start[next] = previousStart;
      length[next] = (previous < CLEAR ? 1 : length[previous]) + 1;
      next++;
    }
    previous = code;
    previousStart = at;
    // Early change: the code size grows one code before the table needs it; a full table takes no more strings.
    if (next + 1 >= 1 << bits) {
      if (bits === 12) previous = -1;
      else bits++;
    }
  }
  return out.subarray(0, pos);
}

/** `out` with room for `need` bytes, its first `used` kept. */
function grow(out: Uint8Array<ArrayBuffer>, used: number, need: number): Uint8Array<ArrayBuffer> {
  let size = out.length * 2;
  while (size < need) size *= 2;
  const bigger = new Uint8Array(size);
  bigger.set(out.subarray(0, used));
  return bigger;
}

/** What a TIFF block needs to have its predictor undone (as geotiff.js passes to its decoders). */
export interface PredictorParameters {
  /** Pixels across a tile (the image width for strips). */
  tileWidth: number;
  /** Rows of a tile or strip (a last strip may have fewer). */
  tileHeight: number;
  /** 1 none, 2 horizontal differencing, 3 floating point. */
  predictor: number;
  /** Bits of each sample of a pixel. */
  bitsPerSample: number | ArrayLike<number>;
  /** 1 samples of a pixel together, 2 one band per block. */
  planarConfiguration: number;
}

/** Undoes the predictor of a decoded block, in place, as geotiff.js does (rows of the machine's byte order). */
export function undoPredictor(block: ArrayBuffer, parameters: PredictorParameters): ArrayBuffer {
  const { predictor, tileWidth: width, tileHeight: height, planarConfiguration } = parameters;
  if (!predictor || predictor === 1) return block;
  const bits = typeof parameters.bitsPerSample === 'number' ? [parameters.bitsPerSample] : Array.from(parameters.bitsPerSample);
  for (const b of bits) {
    if (b % 8 !== 0) throw new Error('When decoding with predictor, only multiple of 8 bits are supported.');
    if (b !== bits[0]) throw new Error('When decoding with predictor, all samples must have the same size.');
  }
  const bytes = bits[0] / 8;
  const stride = planarConfiguration === 2 ? 1 : bits.length;
  const rowBytes = stride * width * bytes;
  for (let i = 0; i < height; i++) {
    // A last strip may be cut short.
    if (i * rowBytes >= block.byteLength) break;
    if (predictor === 2) {
      const at = i * rowBytes;
      if (bits[0] === 8) accumulate(new Uint8Array(block, at, rowBytes), stride);
      else if (bits[0] === 16) accumulate(new Uint16Array(block, at, rowBytes / 2), stride);
      else if (bits[0] === 32) accumulate(new Uint32Array(block, at, rowBytes / 4), stride);
      else throw new Error(`Predictor 2 not allowed with ${bits[0]} bits per sample.`);
    } else if (predictor === 3) {
      floatingPoint(new Uint8Array(block, i * rowBytes, rowBytes), stride, bytes);
    }
  }
  return block;
}

function accumulate(row: Uint8Array | Uint16Array | Uint32Array, stride: number): void {
  for (let i = stride; i < row.length; i++) row[i] += row[i - stride];
}

function floatingPoint(row: Uint8Array, stride: number, bytes: number): void {
  for (let i = stride; i < row.length; i++) row[i] += row[i - stride];
  // The bytes of each value were stored a plane of most significant bytes first.
  const count = row.length / bytes;
  const copy = row.slice();
  for (let i = 0; i < count; i++) for (let b = 0; b < bytes; b++) row[bytes * i + b] = copy[(bytes - b - 1) * count + i];
}

/** An LZW block of a TIFF decoded, its predictor undone: what geotiff.js's LZW decoder gives, much faster. */
export function decodeLzwBlock(buffer: ArrayBuffer, parameters: PredictorParameters): ArrayBuffer {
  const bits = typeof parameters.bitsPerSample === 'number' ? [parameters.bitsPerSample] : Array.from(parameters.bitsPerSample);
  const samples = parameters.planarConfiguration === 2 ? 1 : bits.length;
  const expected = Math.ceil((parameters.tileWidth * parameters.tileHeight * samples * bits[0]) / 8);
  const out = decodeLzw(new Uint8Array(buffer), expected);
  const block = out.byteLength === out.buffer.byteLength ? out.buffer : out.slice().buffer;
  return undoPredictor(block, parameters);
}
