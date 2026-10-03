import { ColorMode } from "../types.js";
import { Pipeline } from "../pipeline.js";
import GeoTIFF, { Options } from "ol/source/GeoTIFF.js";
import { Extent } from "ol/extent.js";
import { Loader } from "ol/source/DataTile.js";
import OlMap from "ol/Map.js";
//#region src/openlayers/enhanced-geotiff.d.ts
/** Options for {@link EnhancedGeoTIFF}: those of `ol/source/GeoTIFF`, plus the correction. */
export interface EnhancedGeoTIFFOptions extends Options {
  /** Correction to apply. Default: an empty pipeline (no change). */
  pipeline?: Pipeline;
  /** Run corrections in Web Workers (default true). */
  worker?: boolean;
  /**
   * Correct each tile as it loads (default true). With false, tiles are drawn
   * as read and the pipeline is applied when the map is drawn, by a
   * `GpuCorrectedTileLayer`.
   */
  correctTiles?: boolean;
  /** Raw tiles kept for re-correction. Default 256 (about 64 MB for RGBA 256×256 tiles). */
  rawCacheSize?: number;
  /**
   * DRA statistics are read from the overview level where the visible area is
   * about this many pixels on its longer side. Default 1024.
   */
  draSampleSize?: number;
  /** At most this many tiles are read for DRA statistics; a coarser level is used if needed. Default 64. */
  draMaxTiles?: number;
}
/** What the last DRA statistics were taken from. */
export interface DraInfo {
  /** The area counted, in the source projection (the visible area clipped to the image). */
  extent: Extent;
  /** Zoom level of the tile grid the statistics were read from. */
  z: number;
  /** Tiles read for the statistics. */
  tiles: number;
  /** Pixels counted (transparent nodata pixels are not). */
  pixels: number;
}
/** Counters for measuring tile correction ({@link EnhancedGeoTIFF.stats}). */
export interface TileStats {
  /** Tiles corrected since the last `resetStats()`. */
  tiles: number;
  /** Total time spent in the pipeline, in milliseconds. */
  ms: number;
  /** Tiles read from the COG (cache misses). Not reset by `resetStats()`. */
  reads: number;
}
/**
 * `ol/source/GeoTIFF` that corrects its tiles with a pipeline. Needs
 * `normalize: true` (the default). Call {@link EnhancedGeoTIFF.updateDra} on the
 * map's `moveend` when the pipeline has `autoStretch`.
 */
export default class EnhancedGeoTIFF extends GeoTIFF {
  private pipeline_;
  /** The pipeline tiles are corrected with: `pipeline_` with `autoStretch` fixed from the DRA statistics. */
  private effective_;
  private readonly worker_;
  private readonly correctTiles_;
  private readonly rawCacheSize_;
  private readonly draSampleSize_;
  private readonly draMaxTiles_;
  private readonly raw_;
  private rawLoader_;
  private draStats_;
  private draInfo_;
  private draKey_;
  private draRequest_;
  /** How many tiles were read and corrected, and the time it took. */
  readonly stats: TileStats;
  constructor(options: EnhancedGeoTIFFOptions);
  /** Whether tiles are corrected as they load (false: the layer corrects the drawn map). */
  correctsTiles(): boolean;
  /** How the image is corrected: decided by its band count, the same for every tile. Null before the COG is read. */
  getColorMode(): ColorMode | null;
  /** The correction as set, before `autoStretch` is fixed from statistics. */
  getPipeline(): Pipeline;
  /**
   * Replaces the correction. Tiles on screen stay visible until their
   * re-corrected versions are ready, then swap in.
   */
  setPipeline(p: Pipeline): void;
  /** The pipeline tiles are corrected with now, with any `autoStretch` already fixed. */
  getEffectivePipeline(): Pipeline;
  /** What the current DRA statistics were taken from; null before the first `updateDra`. */
  getDraInfo(): DraInfo | null;
  /**
   * Collects the statistics of the area `map` shows and fixes the pipeline's
   * `autoStretch` steps from them. Call it on the map's `moveend`. Does nothing
   * when the pipeline has no `autoStretch` or the visible area has not changed.
   * Tiles are re-corrected only when the resulting range changes.
   */
  updateDra(map: OlMap): Promise<void>;
  /** The finest level that is no finer than the sample size, coarsened until the tile count fits. */
  private draZoom_;
  /** Re-resolves the pipeline; tiles are re-corrected only if the result changed. */
  private refresh_;
  /** Sets the tile count and time in {@link EnhancedGeoTIFF.stats} back to zero. */
  resetStats(): void;
  /** Called by the GeoTIFF source once the COG's metadata is read; wraps its tile loader. */
  protected setLoader(loader: Loader): void;
  private loadEnhanced_;
  /** The tile's pixels with `margin` pixels of its neighbour tiles around it; transparent where there are none. */
  private withNeighbours_;
  private rawTile_;
}
//#endregion
//# sourceMappingURL=enhanced-geotiff.d.ts.map