import { ImageDataLike } from "../workers/src/image.js";
//#region src/openlayers/geotiff-writer.d.ts
/** Where the image goes on the map. */
export interface GeoTIFFPlacement {
  /** `[minX, minY, maxX, maxY]` of the image, in the units of `epsg`. */
  extent: readonly [number, number, number, number] | readonly number[];
  /** EPSG code of the coordinates: 4326 for degrees, anything else is a projected system (3857 by default). */
  epsg?: number;
  /** Tile size in pixels, a multiple of 16. Default 256. */
  tileSize?: number;
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
export declare function imageToGeoTIFF(image: ImageDataLike, placement: GeoTIFFPlacement): Blob;
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
export declare function rasterToGeoTIFF(raster: GeoTIFFRaster, options?: {
  tileSize?: number;
}): Blob;
//#endregion
//# sourceMappingURL=geotiff-writer.d.ts.map