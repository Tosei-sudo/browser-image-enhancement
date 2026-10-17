import { describe, expect, it } from 'vitest';
import { getDecoder } from 'geotiff';
import { decodeLzw, decodeLzwBlock } from '../../src/openlayers/lzw.js';
import { lzwDecoderFor } from '../../src/openlayers/lzw-worker.js';

/** TIFF LZW, as GDAL and libtiff write it: MSB first, early change, a clear code before the table fills (unless `clear` is false). */
function encodeLzw(data: Uint8Array, { clear = true, end = true } = {}): ArrayBuffer {
  const out: number[] = [];
  let acc = 0;
  let held = 0;
  let bits = 9;
  const put = (code: number) => {
    acc = (acc << bits) | code;
    held += bits;
    while (held >= 8) {
      held -= 8;
      out.push((acc >>> held) & 0xff);
    }
    acc &= (1 << held) - 1;
  };
  // What the decoder will have after each code, to write the next one at its width.
  let decoded = 0;
  let decoderNext = 258;
  const emit = (code: number) => {
    put(code);
    if (decoded++ > 0 && decoderNext < 4096) decoderNext++;
    if (decoderNext + 1 >= 1 << bits && bits < 12) bits++;
  };
  let dict = new Map<number, number>();
  let next = 258;
  const reset = () => {
    put(256);
    bits = 9;
    dict = new Map();
    next = 258;
    decoded = 0;
    decoderNext = 258;
  };
  reset();
  let w = data[0];
  for (let i = 1; i < data.length; i++) {
    const c = data[i];
    const key = w * 256 + c;
    const known = dict.get(key);
    if (known !== undefined) {
      w = known;
      continue;
    }
    emit(w);
    if (next < 4094) dict.set(key, next++);
    else if (clear) reset();
    w = c;
  }
  emit(w);
  if (end) put(257);
  if (held) out.push((acc << (8 - held)) & 0xff);
  return Uint8Array.from(out).buffer;
}

let seed = 3;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const samples = {
  noise: () => Uint8Array.from({ length: 100_000 }, () => rnd() * 256),
  smooth: () => Uint8Array.from({ length: 150_000 }, (_, i) => 128 + 100 * Math.sin(i / 300) + rnd() * 3),
  runs: () => Uint8Array.from({ length: 100_000 }, (_, i) => (i >> 9) & 1 ? 7 : 200),
  tiny: () => Uint8Array.from([1, 1, 1, 1, 1]),
};

async function geotiffLzw(buffer: ArrayBuffer, parameters: object): Promise<Uint8Array> {
  const decoder = await getDecoder(5, parameters as never);
  return new Uint8Array(await decoder.decode(buffer.slice(0)));
}

describe('decodeLzw', () => {
  for (const [name, make] of Object.entries(samples)) {
    it(`decodes what was encoded (${name})`, () => {
      const data = make();
      expect(Buffer.from(decodeLzw(new Uint8Array(encodeLzw(data)), data.length)).equals(Buffer.from(data))).toBe(true);
    });
  }

  it('keeps decoding once the table is full without a clear code', () => {
    const data = samples.noise();
    expect(Buffer.from(decodeLzw(new Uint8Array(encodeLzw(data, { clear: false })))).equals(Buffer.from(data))).toBe(true);
  });

  it('gives what geotiff.js gives for data without an end code, from a small output guess', async () => {
    const params = { tileWidth: 1000, tileHeight: 100, planarConfiguration: 1, bitsPerSample: [8], predictor: 1 };
    for (const make of [samples.noise, samples.smooth]) {
      const encoded = encodeLzw(make().subarray(0, 100_000), { end: false });
      const ours = decodeLzw(new Uint8Array(encoded), 16);
      expect(Buffer.from(ours).equals(Buffer.from(await geotiffLzw(encoded, params)))).toBe(true);
    }
  });
});

describe('decodeLzwBlock', () => {
  it('undoes the predictors as geotiff.js does', async () => {
    const width = 300;
    const height = 40;
    for (const [bits, predictor, samplesPerPixel] of [
      [8, 2, 3],
      [16, 2, 1],
      [32, 2, 2],
      [32, 3, 1],
      [64, 3, 1],
    ]) {
      const raw = Uint8Array.from({ length: (width * height * samplesPerPixel * bits) / 8 }, (_, i) => (i * 7 + (rnd() * 4) | 0) & 0xff);
      const encoded = encodeLzw(raw);
      const params = { tileWidth: width, tileHeight: height, planarConfiguration: 1, bitsPerSample: Array(samplesPerPixel).fill(bits), predictor };
      const ours = new Uint8Array(decodeLzwBlock(encoded.slice(0), params));
      expect(Buffer.from(ours).equals(Buffer.from(await geotiffLzw(encoded, params)))).toBe(true);
    }
  });
});

describe('lzwDecoderFor', () => {
  const image = (compression: number) => ({
    planarConfiguration: 1,
    getTileWidth: () => 4,
    getTileHeight: () => 2,
    fileDirectory: { getValue: (tag: string) => ({ Compression: compression, BitsPerSample: [8], Predictor: 1 })[tag] },
  });

  it('leaves other compressions to geotiff.js', () => {
    const fallback = { decode: () => new ArrayBuffer(0) };
    expect(lzwDecoderFor(image(8), fallback)).toBe(fallback);
  });

  it('decodes LZW itself (here without workers)', async () => {
    const data = Uint8Array.from([1, 2, 3, 4, 1, 2, 3, 4]);
    const decoder = lzwDecoderFor(image(5), null) as { decode(b: ArrayBuffer): Promise<ArrayBuffer> };
    expect([...new Uint8Array(await decoder.decode(encodeLzw(data)))]).toEqual([...data]);
  });
});
