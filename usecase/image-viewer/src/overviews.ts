/**
 * Overviews for local GeoTIFFs that have none. Such a file has one resolution
 * only, so a zoomed-out view reads and decodes every full-resolution tile:
 * slow, rough-looking, and for a large image more memory than the page has.
 *
 * The overviews are averaged from the file a window at a time (in workers
 * where there are any) and appended after it: the result is a Blob made of
 * the untouched file followed by the overview levels, with the header
 * pointing at a copy of the first image's directory that leads on to them.
 * The full-resolution pixels are still read from the file, tile by tile,
 * only when shown, so even a file of many gigabytes opens with little memory.
 */
import { fromArrayBuffer, fromBlob, type GeoTIFF, type GeoTIFFImage } from 'geotiff';
import type { GeoTIFFRaster, GeoTIFFSamples } from 'browser-image-enhancement/openlayers';
import { reduceWindow, tileDecoder, windowsOf, type Reduced } from './reduce.js';
import type { OverviewJob, OverviewReply } from './overview-worker.js';

/** Images up to this size are shown well without overviews. */
const SMALL = 512;
/** The most samples read into memory at once (about 50 million RGB pixels), for orthorectification. */
export const MAX_OVERVIEW_SAMPLES = 150_000_000;
/** The largest overview level kept, in bytes; finer levels are left out, and the full image is read there instead. */
export const MAX_OVERVIEW_BYTES = 128 * 1024 * 1024;
/** Tile size of the overview levels. */
const TILE = 256;

export interface OverviewOptions {
  /**
   * Georeferencing to give the image instead of its own. The overviews are
   * then made whatever the image's size, with each band's range as
   * statistics so its 11 to 16-bit values are not crushed into a few gray
   * levels (for a satellite image placed by its RPC model, see `sensorGeo`).
   */
  geo?: GeoTIFFRaster['geo'];
  /** Called as the image is read, with the part done (0 to 1). */
  onProgress?: (done: number) => void;
}

/**
 * The GeoTIFF `file` with overviews appended, or null when it needs none (it
 * has overviews already, or is small) or they cannot be made (a palette or an
 * odd bit depth): then open the file as it is.
 */
export async function withOverviews(file: Blob, options: OverviewOptions = {}): Promise<Blob | null> {
  const plan = await planOverviews(file, options);
  return plan ? plan.build(options.onProgress) : null;
}

/** Overviews to make for a GeoTIFF, and the file to show until they are made. */
export interface OverviewPlan {
  /**
   * The file as it can be shown right away, at its full resolution only: the
   * file itself, or with `geo` in place of its georeferencing.
   */
  raw: Blob;
  /** The image's size in pixels. */
  width: number;
  height: number;
  /** Makes the overviews: the file with them appended (see {@link withOverviews}). */
  build(onProgress?: (done: number) => void): Promise<Blob>;
}

/**
 * What {@link withOverviews} would do for `file`, without doing it yet; null
 * when the file needs no overviews or they cannot be made.
 */
export async function planOverviews(file: Blob, options: Pick<OverviewOptions, 'geo'> = {}): Promise<OverviewPlan | null> {
  const tiff = await openBlob(file);
  const forced = !!options.geo;
  if (!forced && (await tiff.getImageCount()) > 1) return null;
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const bands = image.getSamplesPerPixel();
  if (!forced && Math.max(width, height) <= SMALL) return null;
  const bits = image.getBitsPerSample();
  if (![8, 16, 32, 64].includes(bits)) return null;

  const fd = image.fileDirectory;
  const tag = async (id: number) => (fd.hasTag(id) ? await fd.loadValue(id) : undefined);
  const numbers = (v: unknown) => (v === undefined ? undefined : Array.from(v as ArrayLike<number>, Number));
  // JPEG (YCbCr) is decoded to RGB; palettes and other models are left as they are.
  let photometric = Number(await tag(262));
  if (photometric === 6) photometric = 2;
  if (![0, 1, 2].includes(photometric)) return null;
  const format = numbers(await tag(339))?.[0] ?? 1;
  const Type = sampleArray(bits, format);
  if (!Type) return null;
  const extraSamples = numbers(await tag(338));
  const noData = image.getGDALNoData();
  const layout = await readLayout(file);
  const raw = options.geo ? compose(file, layout, geoEntries(options.geo), []) : file;
  const build = (onProgress?: (done: number) => void) =>
    buildOverviews(file, image, layout, { bands, bits, photometric, format, Type, extraSamples, noData, geo: options.geo, onProgress });
  return { raw, width, height, build };
}

/** What {@link planOverviews} found out about the image, for making its overviews. */
interface ImageFacts {
  bands: number;
  bits: number;
  photometric: number;
  format: number;
  Type: SampleArray;
  extraSamples: number[] | undefined;
  noData: number | null;
  geo?: GeoTIFFRaster['geo'];
  onProgress?: (done: number) => void;
}

async function buildOverviews(file: Blob, image: GeoTIFFImage, layout: Layout, facts: ImageFacts): Promise<Blob> {
  const { bands, bits, photometric, format, Type, extraSamples, noData, onProgress } = facts;
  const width = image.getWidth();
  const height = image.getHeight();

  // The first overview: half the size, or smaller when that would not fit in memory.
  let f = 2;
  while (Math.ceil(width / f) * Math.ceil(height / f) * bands * (bits / 8) > MAX_OVERVIEW_BYTES) f *= 2;
  const first = await reduceImage(file, image, { f, bands, noData, Type, onProgress });
  const levels: Level[] = [first];
  while (Math.max(levels[levels.length - 1].width, levels[levels.length - 1].height) > TILE) {
    levels.push(halve(levels[levels.length - 1], bands, noData));
  }

  const offsetType = layout.big ? LONG8 : LONG;
  const ifds = levels.map((level) => {
    const tiles: Uint8Array[] = [];
    for (let ty = 0; ty < Math.ceil(level.height / TILE); ty++) {
      for (let tx = 0; tx < Math.ceil(level.width / TILE); tx++) tiles.push(fileBytes(tileOf(level, tx * TILE, ty * TILE, bands, noData), layout.le));
    }
    const entries: Entry[] = [
      { tag: 254, type: LONG, values: [1] }, // NewSubfileType: reduced-resolution image
      { tag: 256, type: LONG, values: [level.width] },
      { tag: 257, type: LONG, values: [level.height] },
      { tag: 258, type: SHORT, values: new Array(bands).fill(bits) },
      { tag: 259, type: SHORT, values: [1] }, // no compression
      { tag: 262, type: SHORT, values: [photometric] },
      { tag: 277, type: SHORT, values: [bands] },
      { tag: 284, type: SHORT, values: [1] },
      { tag: 322, type: LONG, values: [TILE] },
      { tag: 323, type: LONG, values: [TILE] },
      { tag: 324, type: offsetType, values: new Array(tiles.length).fill(0) }, // set in compose()
      { tag: 325, type: LONG, values: tiles.map((t) => t.length) },
    ];
    if (extraSamples?.length) entries.push({ tag: 338, type: SHORT, values: extraSamples });
    entries.push({ tag: 339, type: SHORT, values: new Array(bands).fill(format) });
    if (noData !== null) entries.push({ tag: 42113, type: ASCII, values: ascii(String(noData)) });
    return { entries, tiles };
  });

  // New georeferencing and statistics replace the image's own.
  const replace = facts.geo ? geoEntries(facts.geo) : [];
  if (facts.geo) {
    const statistics = gdalStatistics(first.min, first.max);
    if (statistics) replace.push({ tag: 42112, type: ASCII, values: ascii(statistics) });
  }
  const blob = compose(file, layout, replace, ifds);
  made.set(blob, { levels: levels.length, factor: f });
  return blob;
}

/**
 * The georeferencing tags for `geo`, to replace the image's own. Values as
 * numbers: SHORT, DOUBLE or ASCII (character codes, ending in 0).
 */
export function geoEntries(g: NonNullable<GeoTIFFRaster['geo']>): Array<{ tag: number; type: number; values: number[] }> {
  const entries: Entry[] = [];
  if (g.modelPixelScale) entries.push({ tag: 33550, type: DOUBLE, values: [...g.modelPixelScale] });
  if (g.modelTiepoint) entries.push({ tag: 33922, type: DOUBLE, values: [...g.modelTiepoint] });
  if (g.modelTransformation) entries.push({ tag: 34264, type: DOUBLE, values: [...g.modelTransformation] });
  if (g.geoKeyDirectory) entries.push({ tag: 34735, type: SHORT, values: [...g.geoKeyDirectory] });
  if (g.geoDoubleParams) entries.push({ tag: 34736, type: DOUBLE, values: [...g.geoDoubleParams] });
  if (g.geoAsciiParams) entries.push({ tag: 34737, type: ASCII, values: ascii(g.geoAsciiParams) });
  return entries;
}

/**
 * The overviews an opened file was given: how many levels, and the reduction
 * of the finest (2 = half size); `external` names the .ovr file they came
 * from, when they are not ones {@link withOverviews} made.
 */
export interface MadeOverviews {
  levels: number;
  factor: number;
  external?: string;
}

const made = new WeakMap<Blob, MadeOverviews>();

/** Notes that `blob` is a file joined with overviews (see external-overviews.ts). */
export function recordOverviews(blob: Blob, overviews: MadeOverviews): void {
  made.set(blob, overviews);
}

/** The overviews joined to `blob`, if it was made by {@link withOverviews} or {@link recordOverviews}. */
export function madeOverviews(blob: Blob): MadeOverviews | undefined {
  return made.get(blob);
}

/** Whether `file` starts like a TIFF or BigTIFF. */
export async function isTiff(file: Blob): Promise<boolean> {
  const b = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const le = b[0] === 0x49 && b[1] === 0x49 && (b[2] === 42 || b[2] === 43) && b[3] === 0;
  const be = b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && (b[3] === 42 || b[3] === 43);
  return le || be;
}

/** Only the header is read until the pixels are needed (whole files where there is no FileReader). */
async function openBlob(file: Blob): Promise<GeoTIFF> {
  return typeof FileReader === 'undefined' ? fromArrayBuffer(await file.arrayBuffer()) : fromBlob(file);
}

interface Level {
  width: number;
  height: number;
  data: GeoTIFFSamples;
}

type SampleArray = new (n: number) => GeoTIFFSamples;

function sampleArray(bits: number, format: number): SampleArray | null {
  if (format === 3) return bits === 32 ? Float32Array : bits === 64 ? Float64Array : null;
  const types: Record<number, [SampleArray, SampleArray]> = { 8: [Uint8Array, Int8Array], 16: [Uint16Array, Int16Array], 32: [Uint32Array, Int32Array] };
  return types[bits]?.[format === 2 ? 1 : 0] ?? null;
}

/**
 * The image averaged over `f` × `f` pixels, with each band's range, read a
 * window at a time: in workers when the browser has them, else here.
 */
async function reduceImage(
  file: Blob,
  image: GeoTIFFImage,
  { f, bands, noData, Type, onProgress }: { f: number; bands: number; noData: number | null; Type: SampleArray; onProgress?: (done: number) => void },
): Promise<Level & { min: number[]; max: number[] }> {
  const width = Math.ceil(image.getWidth() / f);
  const height = Math.ceil(image.getHeight() / f);
  const data = new Type(width * height * bands);
  const min = new Array<number>(bands).fill(Infinity);
  const max = new Array<number>(bands).fill(-Infinity);
  const windows = windowsOf(image.getWidth(), image.getHeight(), f, bands, image.getTileWidth(), image.getTileHeight());
  let done = 0;
  const place = (r: Reduced) => {
    for (let y = 0; y < r.h; y++) data.set(r.data.subarray(y * r.w * bands, (y + 1) * r.w * bands), ((r.y + y) * width + r.x) * bands);
    for (let b = 0; b < bands; b++) {
      if (r.min[b] < min[b]) min[b] = r.min[b];
      if (r.max[b] > max[b]) max[b] = r.max[b];
    }
    onProgress?.(++done / windows.length);
  };
  if (typeof Worker === 'undefined' || typeof FileReader === 'undefined') {
    const decoder = await tileDecoder(image);
    for (const win of windows) place(await reduceWindow(image, win, f, noData, decoder));
  } else {
    const count = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 2) - 1, windows.length));
    await Promise.all(
      Array.from({ length: count }, (_, i) => runWorker({ file, windows: windows.filter((_, k) => k % count === i), f, noData }, place)),
    );
  }
  return { width, height, data, min, max };
}

function runWorker(job: OverviewJob, onWindow: (r: Reduced) => void): Promise<void> {
  const worker = new Worker(new URL('./overview-worker.ts', import.meta.url), { type: 'module' });
  return new Promise<void>((resolve, reject) => {
    worker.onmessage = ({ data }: MessageEvent<OverviewReply>) => {
      if (data.type === 'window') onWindow(data.reduced);
      else if (data.type === 'done') resolve();
      else reject(new Error(data.message));
    };
    worker.onerror = (e) => reject(new Error(e.message || 'The overview worker failed.'));
    worker.postMessage(job);
  }).finally(() => worker.terminate());
}

/** The level at half the size (rounded up), each sample the mean of up to 2×2, without no-data and NaN. */
function halve({ width, height, data }: Level, bands: number, noData: number | null): Level {
  const w = Math.ceil(width / 2);
  const h = Math.ceil(height / 2);
  const out = new (data.constructor as SampleArray)(w * h * bands);
  const float = data instanceof Float32Array || data instanceof Float64Array;
  const empty = noData ?? (float ? NaN : 0);
  const row = width * bands;
  for (let y = 0; y < h; y++) {
    const top = 2 * y * row;
    const below = 2 * y + 1 < height ? row : 0; // the last odd row pairs with itself
    for (let x = 0; x < w; x++) {
      const right = 2 * x + 1 < width ? bands : 0;
      const at = top + 2 * x * bands;
      for (let b = 0; b < bands; b++) {
        const i = at + b;
        const a = data[i];
        const c = data[i + right];
        const d = data[i + below];
        const e = data[i + below + right];
        let sum = 0;
        let n = 0;
        if (a === a && a !== noData) {
          sum += a;
          n++;
        }
        if (c === c && c !== noData) {
          sum += c;
          n++;
        }
        if (d === d && d !== noData) {
          sum += d;
          n++;
        }
        if (e === e && e !== noData) {
          sum += e;
          n++;
        }
        out[(y * w + x) * bands + b] = n === 0 ? empty : float ? sum / n : Math.round(sum / n);
      }
    }
  }
  return { width: w, height: h, data: out };
}

/** One tile of a level; no-data (or zero) past its edge. */
function tileOf(level: Level, x0: number, y0: number, bands: number, noData: number | null): GeoTIFFSamples {
  const out = new (level.data.constructor as SampleArray)(TILE * TILE * bands);
  if (noData !== null && noData !== 0) out.fill(noData);
  const w = Math.min(TILE, level.width - x0);
  const h = Math.min(TILE, level.height - y0);
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * level.width + x0) * bands;
    out.set(level.data.subarray(from, from + w * bands), y * TILE * bands);
  }
  return out;
}

const HOST_LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** The samples as bytes in the file's byte order. */
function fileBytes(a: GeoTIFFSamples, le: boolean): Uint8Array {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const n = a.BYTES_PER_ELEMENT;
  if (n === 1 || le === HOST_LE) return bytes;
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += n) for (let k = 0; k < n; k++) out[i + k] = bytes[i + n - 1 - k];
  return out;
}

/** GDAL metadata XML with each band's lowest and highest value, or null when every sample is no-data. */
function gdalStatistics(min: number[], max: number[]): string | null {
  if (!(min[0] <= max[0])) return null;
  const items = min.flatMap((_, b) =>
    min[b] <= max[b] ? [`<Item name="STATISTICS_MINIMUM" sample="${b}">${min[b]}</Item>`, `<Item name="STATISTICS_MAXIMUM" sample="${b}">${max[b]}</Item>`] : [],
  );
  return `<GDALMetadata>${items.join('')}</GDALMetadata>`;
}

function ascii(text: string): number[] {
  const codes = Array.from(text, (c) => c.charCodeAt(0) & 0x7f);
  if (codes[codes.length - 1] !== 0) codes.push(0);
  return codes;
}

// ---- Appending image directories to a TIFF ----

const ASCII = 2;
const SHORT = 3;
const LONG = 4;
const DOUBLE = 12;
const LONG8 = 16;
const TYPE_SIZE: Record<number, number> = { [ASCII]: 1, [SHORT]: 2, [LONG]: 4, [DOUBLE]: 8, [LONG8]: 8 };

interface Entry {
  tag: number;
  type: number;
  values: number[];
}

/** An entry of the file's first directory, as its bytes: its values, or where they are in the file, stay valid. */
interface RawEntry {
  tag: number;
  raw: Uint8Array;
}

/** What is needed to append directories: byte order, TIFF or BigTIFF, and the first directory's entries. */
interface Layout {
  le: boolean;
  big: boolean;
  headerLength: number;
  entries: RawEntry[];
}

async function readLayout(file: Blob): Promise<Layout> {
  const read = async (from: number, length: number) => new DataView(await file.slice(from, from + length).arrayBuffer());
  const head = await read(0, 16);
  const le = head.getUint8(0) === 0x49;
  const big = head.getUint16(2, le) === 43;
  const first = big ? Number(head.getBigUint64(8, le)) : head.getUint32(4, le);
  const countView = await read(first, big ? 8 : 2);
  const count = big ? Number(countView.getBigUint64(0, le)) : countView.getUint16(0, le);
  const size = big ? 20 : 12;
  const body = new Uint8Array((await read(first + (big ? 8 : 2), count * size)).buffer);
  const entries = Array.from({ length: count }, (_, i) => {
    const raw = body.slice(i * size, (i + 1) * size);
    return { tag: le ? raw[0] | (raw[1] << 8) : (raw[0] << 8) | raw[1], raw };
  });
  return { le, big, headerLength: big ? 16 : 8, entries };
}

/**
 * The file with `levels` appended as reduced-resolution images. The header
 * points at a copy of the first directory, with `replace` entries in place of
 * the ones with their tags, which leads on to the appended ones; nothing in
 * the file itself moves, so every offset in it stays valid.
 */
function compose(file: Blob, layout: Layout, replace: Entry[], levels: Array<{ entries: Entry[]; tiles: Uint8Array[] }>): Blob {
  const { le, big } = layout;
  const entrySize = big ? 20 : 12;
  const countSize = big ? 8 : 2;
  const pointerSize = big ? 8 : 4;
  const outOfLine = (entries: Entry[]) => entries.reduce((n, e) => {
    const size = TYPE_SIZE[e.type] * e.values.length;
    return size > pointerSize ? n + size + (size & 1) : n;
  }, 0);
  const replaced = new Set(replace.map((e) => e.tag));
  const first: Array<RawEntry | Entry> = [...layout.entries.filter((e) => !replaced.has(e.tag)), ...replace].sort((a, b) => a.tag - b.tag);

  // Where everything goes: the directories after the file, then the tiles.
  const base = file.size + (file.size & 1);
  let at = base;
  const place = (count: number, extra: number) => {
    const p = at;
    at += countSize + count * entrySize + pointerSize + extra;
    at += at & 1;
    return p;
  };
  const firstAt = place(first.length, outOfLine(replace));
  const levelAt = levels.map((l) => place(l.entries.length, outOfLine(l.entries)));
  const directoriesEnd = at;
  for (const level of levels) {
    const offsets = level.entries.find((e) => e.tag === 324)!.values;
    level.tiles.forEach((t, k) => {
      offsets[k] = at;
      at += t.length;
    });
  }
  if (!big && at > 0xffffffff) throw new RangeError('The overviews would take the file over 4 GB, which a (non-Big) TIFF cannot address.');

  const buffer = new ArrayBuffer(directoriesEnd - base);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const pointer = (p: number, value: number) => (big ? view.setBigUint64(p - base, BigInt(value), le) : view.setUint32(p - base, value, le));
  const write = (p: number, entries: Array<RawEntry | Entry>, next: number) => {
    if (big) view.setBigUint64(p - base, BigInt(entries.length), le);
    else view.setUint16(p - base, entries.length, le);
    let e = p + countSize;
    let extra = e + entries.length * entrySize + pointerSize;
    for (const entry of entries) {
      if ('raw' in entry) {
        bytes.set(entry.raw, e - base);
      } else {
        view.setUint16(e - base, entry.tag, le);
        view.setUint16(e - base + 2, entry.type, le);
        if (big) view.setBigUint64(e - base + 4, BigInt(entry.values.length), le);
        else view.setUint32(e - base + 4, entry.values.length, le);
        const valueAt = e + (big ? 12 : 8);
        const size = TYPE_SIZE[entry.type] * entry.values.length;
        if (size <= pointerSize) writeValues(view, valueAt - base, entry, le);
        else {
          pointer(valueAt, extra);
          writeValues(view, extra - base, entry, le);
          extra += size + (size & 1);
        }
      }
      e += entrySize;
    }
    pointer(e, next);
  };
  write(firstAt, first, levelAt[0] ?? 0);
  levels.forEach((level, i) => write(levelAt[i], level.entries, levelAt[i + 1] ?? 0));

  const header = new DataView(new ArrayBuffer(layout.headerLength));
  header.setUint16(0, le ? 0x4949 : 0x4d4d);
  header.setUint16(2, big ? 43 : 42, le);
  if (big) {
    header.setUint16(4, 8, le);
    header.setUint16(6, 0, le);
    header.setBigUint64(8, BigInt(firstAt), le);
  } else {
    header.setUint32(4, firstAt, le);
  }
  return new Blob(
    [header.buffer, file.slice(layout.headerLength), new Uint8Array(base - file.size), buffer, ...levels.flatMap((l) => l.tiles as BlobPart[])],
    { type: 'image/tiff' },
  );
}

function writeValues(view: DataView, at: number, e: Entry, le: boolean): void {
  const step = TYPE_SIZE[e.type];
  e.values.forEach((v, k) => {
    const p = at + k * step;
    if (e.type === ASCII) view.setUint8(p, v);
    else if (e.type === SHORT) view.setUint16(p, v, le);
    else if (e.type === LONG) view.setUint32(p, v, le);
    else if (e.type === LONG8) view.setBigUint64(p, BigInt(v), le);
    else view.setFloat64(p, v, le);
  });
}
