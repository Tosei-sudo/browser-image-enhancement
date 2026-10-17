//#region src/openlayers/lzw.d.ts
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
/**
 * The bytes LZW-compressed in `input`. `expected` (the size the block
 * should have, when known) sizes the output; it grows when there is more.
 */
export declare function decodeLzw(input: Uint8Array, expected?: number): Uint8Array<ArrayBuffer>;
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
export declare function undoPredictor(block: ArrayBuffer, parameters: PredictorParameters): ArrayBuffer;
/** An LZW block of a TIFF decoded, its predictor undone: what geotiff.js's LZW decoder gives, much faster. */
export declare function decodeLzwBlock(buffer: ArrayBuffer, parameters: PredictorParameters): ArrayBuffer;
//#endregion
//# sourceMappingURL=lzw.d.ts.map