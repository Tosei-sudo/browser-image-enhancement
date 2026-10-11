/**
 * Fixes how geotiff.js reads a big-endian TIFF's large arrays (tile and strip
 * offsets and byte counts past the first few kilobytes of the directory): it
 * defers them and then reads them as little-endian, so a tile's offset comes
 * out as a huge number and the tile is not read. NITF images are opened as
 * big-endian TIFFs (see nitf-tiff.ts), and big ones have such arrays.
 *
 * Here such an array is read whole, in the TIFF's byte order, the first time
 * it is asked for. Import this module (for its side effect) before reading.
 */
import { globals, ImageFileDirectory } from 'geotiff';

interface DeferredArray {
  source: { fetch(slices: Array<{ offset: number; length: number }>): Promise<ArrayBufferLike[]> };
  arrayOffset: number;
  littleEndian: boolean;
  fieldType: number;
  length: number;
}

const SHORT = 3;
const LONG = 4;
const LONG8 = 16;
const SIZES: Record<number, number> = { [SHORT]: 2, [LONG]: 4, [LONG8]: 8 };

/** The values of a big-endian array, read whole. */
async function readBigEndian(array: DeferredArray): Promise<number[]> {
  const size = SIZES[array.fieldType];
  const [bytes] = await array.source.fetch([{ offset: array.arrayOffset, length: size * array.length }]);
  const view = new DataView(bytes);
  return Array.from({ length: array.length }, (_, k) =>
    size === 2 ? view.getUint16(k * 2) : size === 4 ? view.getUint32(k * 4) : Number(view.getBigUint64(k * 8)),
  );
}

type Directory = {
  deferredArrays: Map<number, DeferredArray>;
  actualizedFields: Map<number, unknown>;
  pending?: Map<number, Promise<void>>;
};

/** Makes a big-endian deferred array of `tag` an ordinary value, read correctly. */
async function settle(directory: Directory, tagIdentifier: number | string): Promise<void> {
  const tag = globals.resolveTag(tagIdentifier as never) as number;
  const array = directory.deferredArrays.get(tag);
  if (!array || array.littleEndian || !SIZES[array.fieldType]) return;
  directory.pending ??= new Map();
  let promise = directory.pending.get(tag);
  if (!promise) {
    promise = readBigEndian(array).then((values) => {
      directory.actualizedFields.set(tag, values);
      directory.deferredArrays.delete(tag);
    });
    directory.pending.set(tag, promise);
  }
  await promise;
}

const proto = ImageFileDirectory.prototype as unknown as {
  loadValue(tag: number | string): Promise<unknown>;
  loadValueIndexed(tag: number | string, index: number): Promise<unknown>;
  __bigEndianArrays?: boolean;
};
if (!proto.__bigEndianArrays) {
  proto.__bigEndianArrays = true;
  const { loadValue, loadValueIndexed } = proto;
  proto.loadValue = async function (this: Directory, tag) {
    await settle(this, tag);
    return loadValue.call(this, tag);
  };
  proto.loadValueIndexed = async function (this: Directory, tag, index) {
    await settle(this, tag);
    return loadValueIndexed.call(this, tag, index);
  };
}
