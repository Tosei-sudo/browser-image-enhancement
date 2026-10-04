/**
 * Writes an image as a small tiled GeoTIFF with overviews, so an ordinary
 * picture (PNG, JPEG, ...) placed on the map can go through the same
 * `EnhancedGeoTIFF` source, DRA and GPU layer as a COG.
 *
 * The file is uncompressed and 8-bit: gray (1 band), gray + alpha (2), RGB (3)
 * or RGBA (4), whichever is the smallest that keeps the image. Overviews halve
 * the size until the image fits one tile, so OpenLayers reads a coarse level
 * when zoomed out instead of the full image.
 */
import type { ImageDataLike } from '../types.js';

/** Where the image goes on the map. */
export interface GeoTIFFPlacement {
  /** `[minX, minY, maxX, maxY]` of the image, in the units of `epsg`. */
  extent: readonly [number, number, number, number] | readonly number[];
  /** EPSG code of the coordinates: 4326 for degrees, anything else is a projected system (3857 by default). */
  epsg?: number;
  /** Tile size in pixels, a multiple of 16. Default 256. */
  tileSize?: number;
}

const ASCII = 2;
const SHORT = 3;
const LONG = 4;
const DOUBLE = 12;
const TYPE_SIZE: Record<number, number> = { [ASCII]: 1, [SHORT]: 2, [LONG]: 4, [DOUBLE]: 8 };

interface Entry {
  tag: number;
  type: number;
  values: readonly number[];
}

/**
 * The image as a tiled GeoTIFF (with overviews) covering `placement.extent`.
 *
 * @example
 * ```ts
 * const blob = imageToGeoTIFF(await toImageData(file), { extent: [x0, y0, x1, y1], epsg: 3857 });
 * const source = new EnhancedGeoTIFF({ sources: [{ blob }] });
 * ```
 */
export function imageToGeoTIFF(image: ImageDataLike, placement: GeoTIFFPlacement): Blob {
  const { width, height, data } = image;
  if (!(width > 0 && height > 0)) throw new RangeError('The image is empty.');
  const tileSize = placement.tileSize ?? 256;
  if (tileSize % 16 !== 0 || tileSize <= 0) throw new RangeError('tileSize must be a positive multiple of 16.');
  const epsg = placement.epsg ?? 3857;
  const [minX, minY, maxX, maxY] = placement.extent;
  if (!(maxX > minX && maxY > minY)) throw new RangeError('The extent is empty.');

  const { gray, alpha } = inspect(data);
  const bands = (gray ? 1 : 3) + (alpha ? 1 : 0);

  // Full size first, then each overview half the size of the one before.
  const levels: Array<{ width: number; height: number; data: Uint8ClampedArray | ArrayLike<number> }> = [{ width, height, data }];
  while (Math.max(levels[levels.length - 1].width, levels[levels.length - 1].height) > tileSize) {
    levels.push(halve(levels[levels.length - 1]));
  }

  const ifds = levels.map((level, i) => {
    const across = Math.ceil(level.width / tileSize);
    const down = Math.ceil(level.height / tileSize);
    const tiles: Uint8Array[] = [];
    for (let ty = 0; ty < down; ty++) {
      for (let tx = 0; tx < across; tx++) tiles.push(tile(level, tx * tileSize, ty * tileSize, tileSize, bands, gray));
    }
    const entries: Entry[] = [
      { tag: 254, type: LONG, values: [i === 0 ? 0 : 1] }, // NewSubfileType: 1 = reduced-resolution image
      { tag: 256, type: LONG, values: [level.width] },
      { tag: 257, type: LONG, values: [level.height] },
      { tag: 258, type: SHORT, values: new Array(bands).fill(8) },
      { tag: 259, type: SHORT, values: [1] }, // no compression
      { tag: 262, type: SHORT, values: [gray ? 1 : 2] }, // BlackIsZero or RGB
      { tag: 277, type: SHORT, values: [bands] },
      { tag: 284, type: SHORT, values: [1] }, // interleaved
      { tag: 322, type: LONG, values: [tileSize] },
      { tag: 323, type: LONG, values: [tileSize] },
      { tag: 324, type: LONG, values: new Array(tiles.length).fill(0) }, // offsets, filled in below
      { tag: 325, type: LONG, values: tiles.map((t) => t.length) },
    ];
    if (alpha) entries.push({ tag: 338, type: SHORT, values: [2] }); // unassociated alpha
    entries.push({ tag: 339, type: SHORT, values: new Array(bands).fill(1) }); // unsigned
    if (i === 0) {
      const geographic = epsg === 4326;
      entries.push(
        { tag: 33550, type: DOUBLE, values: [(maxX - minX) / width, (maxY - minY) / height, 0] },
        { tag: 33922, type: DOUBLE, values: [0, 0, 0, minX, maxY, 0] },
        {
          tag: 34735,
          type: SHORT,
          values: [
            1, 1, 0, 3,
            1024, 0, 1, geographic ? 2 : 1, // GTModelType: geographic or projected
            1025, 0, 1, 1, // GTRasterType: PixelIsArea
            geographic ? 2048 : 3072, 0, 1, epsg, // GeographicType or ProjectedCSType
          ],
        },
      );
    }
    return { entries, tiles };
  });

  return serialize(ifds);
}

/** Pixel values {@link rasterToGeoTIFF} can write. */
export type GeoTIFFSamples = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;

/** A raster for {@link rasterToGeoTIFF}: any number of bands of one sample type, and its georeferencing. */
export interface GeoTIFFRaster {
  width: number;
  height: number;
  /** Samples per pixel. */
  bands: number;
  /** The samples, pixel-interleaved: `bands` values for each pixel, row by row. */
  data: GeoTIFFSamples;
  /** The value of pixels with no data; left out of the overview averages. */
  noData?: number | null;
  /** PhotometricInterpretation (1 = gray, 2 = RGB). Default: 2 for 3 or more bands, else 1. */
  photometric?: number;
  /** ExtraSamples, one per band beyond the color ones (2 = unassociated alpha). */
  extraSamples?: readonly number[];
  /**
   * Georeferencing tags, copied as they are from the original file:
   * ModelPixelScale, ModelTiepoint or ModelTransformation, and the GeoKey
   * directory with its double and ASCII parameters.
   */
  geo: {
    modelPixelScale?: readonly number[];
    modelTiepoint?: readonly number[];
    modelTransformation?: readonly number[];
    geoKeyDirectory?: readonly number[];
    geoDoubleParams?: readonly number[];
    geoAsciiParams?: string;
  };
}

/**
 * A raster as a tiled GeoTIFF with overviews, keeping its sample type, band
 * count, no-data value and georeferencing. Use it to give a GeoTIFF that has
 * no overviews (a plain, non-cloud-optimized one) the levels OpenLayers reads
 * when zoomed out: without them every view is drawn from the full image and
 * looks jagged when zoomed out. Overviews average 2×2 pixels per band,
 * leaving out no-data and NaN.
 *
 * @example
 * ```ts
 * const image = await (await fromBlob(file)).getImage();
 * const data = (await image.readRasters({ interleave: true })) as Uint16Array;
 * const fd = image.fileDirectory;
 * const blob = rasterToGeoTIFF({
 *   width: image.getWidth(), height: image.getHeight(), bands: image.getSamplesPerPixel(), data,
 *   noData: image.getGDALNoData(),
 *   geo: { modelPixelScale: fd.ModelPixelScale, modelTiepoint: fd.ModelTiepoint, geoKeyDirectory: fd.GeoKeyDirectory },
 * });
 * ```
 */
export function rasterToGeoTIFF(raster: GeoTIFFRaster, options: { tileSize?: number } = {}): Blob {
  const { width, height, bands, data } = raster;
  if (!(width > 0 && height > 0 && bands > 0)) throw new RangeError('The raster is empty.');
  if (data.length !== width * height * bands) throw new RangeError('data must hold width × height × bands samples.');
  const tileSize = options.tileSize ?? 256;
  if (tileSize % 16 !== 0 || tileSize <= 0) throw new RangeError('tileSize must be a positive multiple of 16.');
  const { bits, format } = sampleType(data);
  const noData = raster.noData ?? null;

  const levels: Array<{ width: number; height: number; data: GeoTIFFSamples }> = [{ width, height, data }];
  while (Math.max(levels[levels.length - 1].width, levels[levels.length - 1].height) > tileSize) {
    levels.push(halveRaster(levels[levels.length - 1], bands, noData));
  }

  const ifds = levels.map((level, i) => {
    const across = Math.ceil(level.width / tileSize);
    const down = Math.ceil(level.height / tileSize);
    const tiles: Uint8Array[] = [];
    for (let ty = 0; ty < down; ty++) {
      for (let tx = 0; tx < across; tx++) tiles.push(rasterTile(level, tx * tileSize, ty * tileSize, tileSize, bands, noData));
    }
    const entries: Entry[] = [
      { tag: 254, type: LONG, values: [i === 0 ? 0 : 1] },
      { tag: 256, type: LONG, values: [level.width] },
      { tag: 257, type: LONG, values: [level.height] },
      { tag: 258, type: SHORT, values: new Array(bands).fill(bits) },
      { tag: 259, type: SHORT, values: [1] },
      { tag: 262, type: SHORT, values: [raster.photometric ?? (bands >= 3 ? 2 : 1)] },
      { tag: 277, type: SHORT, values: [bands] },
      { tag: 284, type: SHORT, values: [1] },
      { tag: 322, type: LONG, values: [tileSize] },
      { tag: 323, type: LONG, values: [tileSize] },
      { tag: 324, type: LONG, values: new Array(tiles.length).fill(0) },
      { tag: 325, type: LONG, values: tiles.map((t) => t.length) },
    ];
    if (raster.extraSamples?.length) entries.push({ tag: 338, type: SHORT, values: [...raster.extraSamples] });
    entries.push({ tag: 339, type: SHORT, values: new Array(bands).fill(format) });
    if (i === 0) {
      const g = raster.geo;
      if (g.modelPixelScale) entries.push({ tag: 33550, type: DOUBLE, values: [...g.modelPixelScale] });
      if (g.modelTiepoint) entries.push({ tag: 33922, type: DOUBLE, values: [...g.modelTiepoint] });
      if (g.modelTransformation) entries.push({ tag: 34264, type: DOUBLE, values: [...g.modelTransformation] });
      if (g.geoKeyDirectory) entries.push({ tag: 34735, type: SHORT, values: [...g.geoKeyDirectory] });
      if (g.geoDoubleParams) entries.push({ tag: 34736, type: DOUBLE, values: [...g.geoDoubleParams] });
      if (g.geoAsciiParams) entries.push({ tag: 34737, type: ASCII, values: ascii(g.geoAsciiParams) });
    }
    if (noData !== null) entries.push({ tag: 42113, type: ASCII, values: ascii(String(noData)) }); // GDAL_NODATA
    // TIFF wants the tags in ascending order.
    entries.sort((a, b) => a.tag - b.tag);
    return { entries, tiles };
  });
  return serialize(ifds);
}

function ascii(text: string): number[] {
  const codes = Array.from(text, (c) => c.charCodeAt(0) & 0x7f);
  if (codes[codes.length - 1] !== 0) codes.push(0);
  return codes;
}

function sampleType(data: GeoTIFFSamples): { bits: number; format: number } {
  const bits = data.BYTES_PER_ELEMENT * 8;
  if (data instanceof Float32Array || data instanceof Float64Array) return { bits, format: 3 };
  if (data instanceof Int8Array || data instanceof Int16Array || data instanceof Int32Array) return { bits, format: 2 };
  return { bits, format: 1 };
}

/** One tile of a raster, as little-endian bytes; no-data (or zero) past the raster's edge. */
function rasterTile(level: { width: number; height: number; data: GeoTIFFSamples }, x0: number, y0: number, size: number, bands: number, noData: number | null): Uint8Array {
  const Type = level.data.constructor as new (n: number) => GeoTIFFSamples;
  const out = new Type(size * size * bands);
  if (noData !== null && noData !== 0) out.fill(noData);
  const w = Math.min(size, level.width - x0);
  const h = Math.min(size, level.height - y0);
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * level.width + x0) * bands;
    out.set(level.data.subarray(from, from + w * bands), y * size * bands);
  }
  return littleEndian(out);
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function littleEndian(a: GeoTIFFSamples): Uint8Array {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  if (LITTLE_ENDIAN || a.BYTES_PER_ELEMENT === 1) return bytes;
  const out = new Uint8Array(bytes.length);
  const n = a.BYTES_PER_ELEMENT;
  for (let i = 0; i < bytes.length; i += n) for (let k = 0; k < n; k++) out[i + k] = bytes[i + n - 1 - k];
  return out;
}

/** The raster at half the size (rounded up), each sample the mean of up to 2×2, without no-data and NaN. */
function halveRaster(level: { width: number; height: number; data: GeoTIFFSamples }, bands: number, noData: number | null): { width: number; height: number; data: GeoTIFFSamples } {
  const { width, height, data } = level;
  const w = Math.ceil(width / 2);
  const h = Math.ceil(height / 2);
  const Type = data.constructor as new (n: number) => GeoTIFFSamples;
  const out = new Type(w * h * bands);
  const float = data instanceof Float32Array || data instanceof Float64Array;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let b = 0; b < bands; b++) {
        let sum = 0;
        let n = 0;
        for (let dy = 0; dy < 2; dy++) {
          const sy = 2 * y + dy;
          if (sy >= height) continue;
          for (let dx = 0; dx < 2; dx++) {
            const sx = 2 * x + dx;
            if (sx >= width) continue;
            const v = data[(sy * width + sx) * bands + b];
            if (v !== v || v === noData) continue;
            sum += v;
            n++;
          }
        }
        out[(y * w + x) * bands + b] = n === 0 ? (noData ?? (float ? NaN : 0)) : float ? sum / n : Math.round(sum / n);
      }
    }
  }
  return { width: w, height: h, data: out };
}

/** The TIFF file: header, then each IFD with its out-of-line values, then the tiles. */
function serialize(ifds: Array<{ entries: Entry[]; tiles: Uint8Array[] }>): Blob {
  const ifdSize = (entries: Entry[]) => 2 + entries.length * 12 + 4 + outOfLineSize(entries);
  let offset = 8;
  const ifdOffsets = ifds.map(({ entries }) => {
    const at = offset;
    offset += ifdSize(entries);
    offset += offset & 1; // word alignment
    return at;
  });
  for (const ifd of ifds) {
    const offsets = ifd.entries.find((e) => e.tag === 324)!.values as number[];
    ifd.tiles.forEach((t, k) => {
      offsets[k] = offset;
      offset += t.length;
    });
  }
  if (offset > 0xffffffff) throw new RangeError('The image is too large for a GeoTIFF of this kind (over 4 GB).');

  const buffer = new ArrayBuffer(offset);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  view.setUint16(0, 0x4949); // "II": little-endian
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffsets[0], true);
  ifds.forEach(({ entries, tiles }, i) => {
    let at = ifdOffsets[i];
    let extra = at + 2 + entries.length * 12 + 4;
    view.setUint16(at, entries.length, true);
    at += 2;
    for (const e of entries) {
      const size = TYPE_SIZE[e.type] * e.values.length;
      view.setUint16(at, e.tag, true);
      view.setUint16(at + 2, e.type, true);
      view.setUint32(at + 4, e.values.length, true);
      if (size <= 4) writeValues(view, at + 8, e);
      else {
        view.setUint32(at + 8, extra, true);
        writeValues(view, extra, e);
        extra += size + (size & 1);
      }
      at += 12;
    }
    view.setUint32(at, i + 1 < ifds.length ? ifdOffsets[i + 1] : 0, true);
    const offsets = entries.find((e) => e.tag === 324)!.values;
    tiles.forEach((t, k) => bytes.set(t, offsets[k]));
  });
  return new Blob([buffer], { type: 'image/tiff' });
}

function outOfLineSize(entries: Entry[]): number {
  let n = 0;
  for (const e of entries) {
    const size = TYPE_SIZE[e.type] * e.values.length;
    if (size > 4) n += size + (size & 1);
  }
  return n;
}

function writeValues(view: DataView, at: number, e: Entry): void {
  const step = TYPE_SIZE[e.type];
  e.values.forEach((v, k) => {
    if (e.type === ASCII) view.setUint8(at + k, v);
    else if (e.type === SHORT) view.setUint16(at + k * step, v, true);
    else if (e.type === LONG) view.setUint32(at + k * step, v, true);
    else view.setFloat64(at + k * step, v, true);
  });
}

/** Whether every visible pixel is gray, and whether any pixel is not fully opaque. */
function inspect(data: ArrayLike<number>): { gray: boolean; alpha: boolean } {
  let gray = true;
  let alpha = false;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a !== 255) alpha = true;
    if (gray && a !== 0 && (data[i] !== data[i + 1] || data[i] !== data[i + 2])) gray = false;
    if (alpha && !gray) break;
  }
  return { gray, alpha };
}

/** One tile, `size`×`size` pixels, with the image's bands; transparent (zero) past the image's edge. */
function tile(
  level: { width: number; height: number; data: ArrayLike<number> },
  x0: number,
  y0: number,
  size: number,
  bands: number,
  gray: boolean,
): Uint8Array {
  const out = new Uint8Array(size * size * bands);
  const w = Math.min(size, level.width - x0);
  const h = Math.min(size, level.height - y0);
  const src = level.data;
  for (let y = 0; y < h; y++) {
    let i = ((y0 + y) * level.width + x0) * 4;
    let o = y * size * bands;
    for (let x = 0; x < w; x++, i += 4) {
      if (gray) out[o++] = src[i];
      else {
        out[o++] = src[i];
        out[o++] = src[i + 1];
        out[o++] = src[i + 2];
      }
      if (bands === 2 || bands === 4) out[o++] = src[i + 3];
    }
  }
  return out;
}

/** The image at half the size (rounded up), each pixel the alpha-weighted mean of up to 2×2. */
function halve(level: { width: number; height: number; data: ArrayLike<number> }): { width: number; height: number; data: Uint8ClampedArray } {
  const { width, height, data } = level;
  const w = Math.ceil(width / 2);
  const h = Math.ceil(height / 2);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let dy = 0; dy < 2; dy++) {
        const sy = 2 * y + dy;
        if (sy >= height) continue;
        for (let dx = 0; dx < 2; dx++) {
          const sx = 2 * x + dx;
          if (sx >= width) continue;
          const i = (sy * width + sx) * 4;
          const wa = data[i + 3];
          r += data[i] * wa;
          g += data[i + 1] * wa;
          b += data[i + 2] * wa;
          a += wa;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: w, height: h, data: out };
}
