/**
 * OpenLayers integration (`browser-image-enhancement/openlayers`): a GeoTIFF
 * (COG) source that corrects its tiles, with DRA over the visible area and
 * seam-free sharpening, and a WebGL tile layer that corrects the drawn map on
 * the GPU. Needs `ol` (OpenLayers 10) installed next to this package.
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
export { cropMargin, withMargin, type NeighbourTile } from './margin.js';
