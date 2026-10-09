/**
 * Reading a large image a window at a time and averaging it down, so its
 * overviews are made without the full-resolution pixels ever being in memory
 * at once. Used on the main thread and in `overview-worker.ts`.
 */
import { getDecoder, type BaseDecoder, type GeoTIFFImage } from 'geotiff';
import type { GeoTIFFSamples } from 'browser-image-enhancement/openlayers';
// SICD and complex NITF pixels read as amplitude, here and in the overview workers.
import './complex-decoder.js';

/** A rectangle of the full-resolution image, in pixels. */
export interface ReduceWindow {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A window averaged down by `f`: its place and size in reduced pixels, and each band's range in full resolution. */
export interface Reduced {
  x: number;
  y: number;
  w: number;
  h: number;
  data: GeoTIFFSamples;
  min: number[];
  max: number[];
}

type SampleArray = { new (n: number): GeoTIFFSamples; new (buffer: ArrayBufferLike): GeoTIFFSamples };

/** About this many samples are read per window. */
const WINDOW_SAMPLES = 4_000_000;

/**
 * Windows covering the image, each starting on a multiple of `f` and
 * following the file's tiles or strips, so every tile is decoded once.
 * Strips span the width, so a striped image is read in full-width bands.
 */
export function windowsOf(width: number, height: number, f: number, bands: number, tileWidth: number, tileHeight: number): ReduceWindow[] {
  const round = (n: number) => f * Math.ceil(n / f);
  const across = Math.min(round(tileWidth), round(width));
  let down = round(tileHeight);
  let w = across;
  if (across >= width) {
    // Full-width bands: as many rows as fit the budget.
    down = round(Math.max(down, Math.floor(WINDOW_SAMPLES / (width * bands))));
  } else {
    w = across * Math.max(1, Math.floor(WINDOW_SAMPLES / (across * down * bands)));
  }
  const windows: ReduceWindow[] = [];
  for (let y = 0; y < height; y += down) {
    for (let x = 0; x < width; x += w) windows.push({ x, y, w: Math.min(w, width - x), h: Math.min(down, height - y) });
  }
  return windows;
}

/**
 * The window of `image` averaged over `f` × `f` pixels per band, no-data and
 * NaN left out (a pixel with none left gets no-data, or NaN / 0). With a
 * `decoder` (see {@link tileDecoder}) the tiles are averaged as decoded,
 * without first being copied into a window sample by sample.
 */
export async function reduceWindow(image: GeoTIFFImage, win: ReduceWindow, f: number, noData: number | null, decoder: BaseDecoder | null = null): Promise<Reduced> {
  const bands = image.getSamplesPerPixel();
  if (!decoder) {
    const data = (await image.readRasters({ window: [win.x, win.y, win.x + win.w, win.y + win.h], interleave: true })) as unknown as GeoTIFFSamples;
    return reduceSamples(data, win, f, bands, noData);
  }
  const tileWidth = image.getTileWidth();
  const tileHeight = image.getTileHeight();
  const right = Math.min(win.x + win.w, image.getWidth());
  const bottom = Math.min(win.y + win.h, image.getHeight());
  const acc = new Accumulator(win, f, bands, noData);
  let Type: SampleArray | null = null;
  for (let ty = Math.floor(win.y / tileHeight); ty * tileHeight < bottom; ty++) {
    for (let tx = Math.floor(win.x / tileWidth); tx * tileWidth < right; tx++) {
      const tile = await image.getTileOrStrip(tx, ty, 0, decoder);
      Type ??= image.getArrayForSample(0, new ArrayBuffer(0)).constructor as SampleArray;
      const data = new Type(tile.data);
      const y0 = ty * tileHeight;
      const x0 = tx * tileWidth;
      const x1 = Math.min(right, x0 + tileWidth);
      for (let y = Math.max(win.y, y0), y1 = Math.min(bottom, y0 + image.getBlockHeight(ty)); y < y1; y++) {
        acc.add(data, ((y - y0) * tileWidth + Math.max(win.x, x0) - x0) * bands, Math.max(win.x, x0) - win.x, x1 - win.x, y - win.y);
      }
    }
  }
  return acc.result(Type ?? Uint8Array);
}

/**
 * A decoder for averaging `image` straight from its tiles, or null where the
 * window has to be read through `readRasters`: separate planes, big-endian
 * multi-byte samples, or a compression with parameters of its own.
 */
export async function tileDecoder(image: GeoTIFFImage): Promise<BaseDecoder | null> {
  const fd = image.fileDirectory;
  const compression = Number(fd.getValue('Compression') ?? 1);
  const bits = image.getBitsPerSample();
  if (![1, 5, 7, 8, 32773, 32946].includes(compression)) return null;
  if (image.planarConfiguration !== 1 || ![8, 16, 32, 64].includes(bits)) return null;
  if (bits > 8 && !image.littleEndian) return null;
  return getDecoder(compression, {
    tileWidth: image.getTileWidth(),
    tileHeight: image.getTileHeight(),
    planarConfiguration: 1,
    bitsPerSample: (await fd.loadValue('BitsPerSample')) as number[],
    predictor: Number((await fd.loadValue('Predictor')) ?? 1),
    ...(compression === 7 && fd.hasTag('JPEGTables') ? { JPEGTables: await fd.loadValue('JPEGTables') } : {}),
  } as ConstructorParameters<typeof BaseDecoder>[0]);
}

/** {@link reduceWindow} on samples already read. */
export function reduceSamples(data: GeoTIFFSamples, win: ReduceWindow, f: number, bands: number, noData: number | null): Reduced {
  const acc = new Accumulator(win, f, bands, noData);
  for (let y = 0; y < win.h; y++) acc.add(data, y * win.w * bands, 0, win.w, y);
  return acc.result(data.constructor as SampleArray);
}

/** Sums and counts of a window's reduced pixels, and each band's range. */
class Accumulator {
  private readonly ow: number;
  private readonly oh: number;
  private readonly sums: Float64Array;
  private readonly counts: Uint32Array;
  private readonly min: number[];
  private readonly max: number[];

  constructor(
    private readonly win: ReduceWindow,
    private readonly f: number,
    private readonly bands: number,
    private readonly noData: number | null,
  ) {
    this.ow = Math.ceil(win.w / f);
    this.oh = Math.ceil(win.h / f);
    this.sums = new Float64Array(this.ow * this.oh * bands);
    this.counts = new Uint32Array(this.ow * this.oh * bands);
    this.min = new Array<number>(bands).fill(Infinity);
    this.max = new Array<number>(bands).fill(-Infinity);
  }

  /** Adds the pixels of window row `y` from column `x0` to `x1`, read from `data` at `from`. */
  add(data: ArrayLike<number>, from: number, x0: number, x1: number, y: number): void {
    const { f, bands, noData, sums, counts, min, max } = this;
    const row = ((y / f) | 0) * this.ow * bands;
    let i = from;
    for (let x = x0; x < x1; x++) {
      const o = row + ((x / f) | 0) * bands;
      for (let b = 0; b < bands; b++, i++) {
        const v = data[i];
        if (v !== v || v === noData) continue;
        sums[o + b] += v;
        counts[o + b]++;
        if (v < min[b]) min[b] = v;
        if (v > max[b]) max[b] = v;
      }
    }
  }

  result(Type: SampleArray): Reduced {
    const { f, noData, sums, counts } = this;
    const out = new Type(sums.length);
    const float = out instanceof Float32Array || out instanceof Float64Array;
    const empty = noData ?? (float ? NaN : 0);
    for (let k = 0; k < sums.length; k++) {
      const n = counts[k];
      out[k] = n === 0 ? empty : float ? sums[k] / n : Math.round(sums[k] / n);
    }
    return { x: this.win.x / f, y: this.win.y / f, w: this.ow, h: this.oh, data: out, min: this.min, max: this.max };
  }
}
