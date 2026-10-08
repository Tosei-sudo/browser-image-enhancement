/**
 * OpenLayers integration (`browser-image-enhancement/openlayers`): a GeoTIFF
 * (COG) source that corrects its tiles, with DRA over the visible area and
 * seam-free sharpening, and a WebGL tile layer that corrects the drawn map on
 * the GPU (also over WMS, WMTS or XYZ picture tiles, with a
 * `TileCorrection`), plus map controls: a correction panel (`EnhanceControl`) and a
 * button that opens images and GeoTIFFs (`LoadImageControl`). Needs `ol`
 * (OpenLayers 10) installed next to this package.
 *
 * @example
 * ```ts
 * import { EnhancedGeoTIFF, GpuCorrectedTileLayer } from 'browser-image-enhancement/openlayers';
 *
 * const source = new EnhancedGeoTIFF({ sources: [{ url }], pipeline: pipeline().autoStretch(), correctTiles: false });
 * const layer = new GpuCorrectedTileLayer({ source });
 * map.on('moveend', () => source.updateDra(map));
 * slider.oninput = () => source.setPipeline(current());
 * ```
 *
 * @module
 */
export {
  default as EnhancedGeoTIFF,
  type DraInfo,
  type EnhancedGeoTIFFOptions,
  type TileStats,
} from './enhanced-geotiff.js';
export { default as GpuCorrectedTileLayer, type GpuCorrectedTileLayerOptions } from './gpu-layer.js';
export { default as TileCorrection, type TileCorrectionOptions } from './tile-correction.js';
export { cropMargin, withMargin, type NeighbourTile } from './margin.js';
export {
  default as EnhanceControl,
  defaultEnhanceSliders,
  enhanceLabelsEn,
  enhanceLabelsJa,
  type EnhanceControlOptions,
  type EnhanceDra,
  type EnhanceLabels,
  type EnhanceSlider,
  type EnhanceTarget,
  type SliderOp,
} from './enhance-control.js';
export {
  default as LoadImageControl,
  LoadImageEvent,
  loadImageLabelsEn,
  loadImageLabelsJa,
  placeOverView,
  type ImagePlacement,
  type LoadedImage,
  type LoadFileOptions,
  type LoadImageControlOptions,
  type LoadImageLabels,
} from './load-image-control.js';
export { imageToGeoTIFF, rasterToGeoTIFF, type GeoTIFFPlacement, type GeoTIFFRaster, type GeoTIFFSamples } from './geotiff-writer.js';
export {
  bandNamesFromGdalMetadata,
  parseGdalMetadata,
  readBandNames,
  readGdalMetadataXml,
  readTag,
  type GdalMetadataItem,
  type TiffImageLike,
} from './tiff-metadata.js';
