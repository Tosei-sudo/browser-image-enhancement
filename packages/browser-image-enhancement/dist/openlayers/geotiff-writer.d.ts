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
//#endregion
//# sourceMappingURL=geotiff-writer.d.ts.map