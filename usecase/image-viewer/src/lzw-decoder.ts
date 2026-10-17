/**
 * geotiff.js's LZW decoder replaced, where the viewer reads tiles itself
 * (RSET generation, processing, NITF), by the library's: the same output,
 * about ten times faster (see lzw.ts in browser-image-enhancement). Tiles
 * read for the map go through the library's workers already.
 */
import { addDecoder, BaseDecoder } from 'geotiff';
import { decodeLzwBlock, type PredictorParameters } from 'browser-image-enhancement/openlayers';

class LzwDecoder extends BaseDecoder {
  override async decode(buffer: ArrayBuffer): Promise<ArrayBuffer> {
    return decodeLzwBlock(buffer, this.parameters as unknown as PredictorParameters);
  }
}

addDecoder(5, () => Promise.resolve(LzwDecoder as unknown as typeof BaseDecoder));
