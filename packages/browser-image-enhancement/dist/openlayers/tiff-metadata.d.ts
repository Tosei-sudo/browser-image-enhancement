//#region src/openlayers/tiff-metadata.d.ts
/**
 * Reading the metadata GDAL writes into a GeoTIFF: the `GDAL_METADATA` tag
 * (an XML list of `<Item>`s, for the dataset or for one band) and the band
 * names in it (`DESCRIPTION`, as `gdal_translate` or QGIS write them, e.g.
 * `NIR`). Works on the images of geotiff.js without importing it.
 */
/** One `<Item>` of GDAL's metadata XML. */
export interface GdalMetadataItem {
  /** The item's name, e.g. `DESCRIPTION`, `STATISTICS_MEAN`, `AREA_OR_POINT`. */
  name: string;
  /** Its text, with XML entities decoded. */
  value: string;
  /** The band (0-based) the item is about; absent for the dataset. */
  sample?: number;
  /** `description`, `offset`, `scale`, `unittype` for the band's own properties; absent for plain metadata. */
  role?: string;
  /** The metadata domain (`IMAGERY`, `RPC`...); absent for the default one. */
  domain?: string;
}
/** The parts of a geotiff.js image read here (geotiff.js 2 and 3). */
export interface TiffImageLike {
  /** The number of bands. */
  getSamplesPerPixel(): number;
  /** The tags: an `ImageFileDirectory` (geotiff.js 3) or a plain object (geotiff.js 2). */
  fileDirectory: unknown;
}
/** The items of GDAL's metadata XML (`<GDALMetadata><Item name="…" sample="0">…</Item></GDALMetadata>`), in order. */
export declare function parseGdalMetadata(xml: string): GdalMetadataItem[];
/**
 * The name of each of `samples` bands in GDAL's metadata items: the band's
 * `DESCRIPTION` (what GDAL's `SetDescription` writes), else a `BAND_NAME`
 * item of the band; null for a band without one.
 */
export declare function bandNamesFromGdalMetadata(items: readonly GdalMetadataItem[], samples: number): Array<string | null>;
/**
 * The `GDAL_METADATA` XML of a geotiff.js image, or null when it has none.
 * Loads the tag when geotiff.js deferred it.
 */
export declare function readGdalMetadataXml(image: TiffImageLike): Promise<string | null>;
/** The band names of a geotiff.js image (see {@link bandNamesFromGdalMetadata}); null for unnamed bands. */
export declare function readBandNames(image: TiffImageLike): Promise<Array<string | null>>;
/**
 * A tag of a geotiff.js image by name or number, or undefined. geotiff.js 3
 * keeps tags in an `ImageFileDirectory` that loads big ones on demand;
 * geotiff.js 2 in a plain object.
 */
export declare function readTag(image: TiffImageLike, tag: string | number): Promise<unknown>;
//#endregion
//# sourceMappingURL=tiff-metadata.d.ts.map