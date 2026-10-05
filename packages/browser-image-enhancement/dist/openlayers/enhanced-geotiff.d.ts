import { AutoStretchOptions, ColorMode } from "../types.js";
import { Pipeline } from "../pipeline.js";
import { RasterStretch, RasterStretchRange } from "../raster.js";
import { BandSelection } from "../bands.js";
import GeoTIFF, { Options } from "ol/source/GeoTIFF.js";
import { Extent } from "ol/extent.js";
import { Loader } from "ol/source/DataTile.js";
import OlMap from "ol/Map.js";
//#region src/openlayers/enhanced-geotiff.d.ts
/** Options for {@link EnhancedGeoTIFF}: those of `ol/source/GeoTIFF`, plus the correction. */
export interface EnhancedGeoTIFFOptions extends Omit<Options, 'normalize'> {
  /**
   * `true` (default): OpenLayers scales values to 0-255 over the data type's
   * range (or the `min`/`max` given). `false`: raw values are stretched here,
   * from their own statistics (see `rawStretch`). `'auto'`: 8-bit images as
   * with `true`, deeper ones (16-bit, float) as with `false`.
   */
  normalize?: boolean | 'auto';
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
  /**
   * With `normalize: false`: how raw values become 0-255 before the
   * pipeline. A fixed {@link RasterStretch}, or automatic stretch options
   * (default `{}`: percentClip, 0.5 % at each end, band by band) applied to
   * the statistics of the whole image. When the pipeline has `autoStretch`,
   * its options are used instead, on the visible area (see `updateDra`).
   */
  rawStretch?: RasterStretch | AutoStretchOptions;
  /**
   * The bands (0-based, alpha not counted) that R, G and B show: `[3, 2, 1]`
   * shows band 3 as red, 2 as green and 1 as blue; one index shows that band
   * in gray. Not to be confused with `sources[].bands`, which picks (1-based)
   * the bands that are read at all. Default: the bands as read (bands 0, 1, 2
   * for images with more than 4 bands). Needs an image with at least 3 bands.
   */
  select?: BandSelection;
  /**
   * Names of the bands (0-based, alpha not counted), shown by the band
   * selects of `EnhanceControl`. Default: read from the file
   * (`DESCRIPTION` in GDAL's metadata, e.g. `NIR`); see `getBandNames`.
   */
  bandNames?: ReadonlyArray<string | null>;
  /** Raw tiles kept for re-correction. Default 256 (about 64 MB for RGBA 256×256 tiles). */
  rawCacheSize?: number;
  /**
   * DRA statistics are read from the overview level where the visible area is
   * about this many pixels on its longer side. Default 1024.
   */
  draSampleSize?: number;
  /** At most this many tiles are read for DRA statistics; a coarser level is used if needed. Default 64. */
  draMaxTiles?: number;
  /**
   * Reproject tiles on the CPU when the map's projection differs from the
   * image's (default true). OpenLayers' own reprojection draws every tile in
   * a WebGL context of its own and reads it back, which stalls the main
   * thread far longer than the JS that replaces it. False: OpenLayers' way.
   */
  cpuReprojection?: boolean;
  /** How long a new tile fades in, in milliseconds; 0 for none. Default 100 (OpenLayers' own is 250). */
  transition?: number;
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
  /** With `normalize: false`: the raw values that became black and white (one per picture band). */
  rawStretch?: RasterStretchRange;
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
  private draLocked_;
  private draRequest_;
  /** The key tiles were last corrected (or drawn) for. */
  private appliedKey_;
  /** The part of `appliedKey_` that changes the tiles as read (see `contentKey_`). */
  private appliedContent_;
  /** True with `normalize: false` (or `'auto'` on a deeper than 8-bit image): tiles hold raw values that are stretched here. */
  private rawValues_;
  /** Bands of a tile as OpenLayers reads it (the value bands, then its alpha band for no data if any); 0 before the COG is read. */
  private rawBands_;
  /** Whether OpenLayers adds an alpha band for no data to the tiles it reads (the last band). */
  private rawAlpha_;
  /** True when tiles are handed to the layer as 4 bands (RGB + alpha) instead of the bands as read (see `packTiles_`). */
  private packed_;
  /** A float32 no-data value OpenLayers cannot match by itself (see floatNoData); null for none. */
  private isNoData_;
  private readonly autoNormalize_;
  private readonly rawStretchOption_;
  /** The raw stretch in use; null until the first statistics are read. */
  private rawStretch_;
  private rawStretchReady_;
  /** Raw-value histograms: of the whole image, and of the last DRA area. */
  private wholeRaw_;
  private viewRaw_;
  /** The bands R, G and B show, as set; null: as read. */
  private select_;
  private readonly bandNamesOption_;
  private bandNames_;
  /** How many tiles were read and corrected, and the time it took. */
  readonly stats: TileStats;
  constructor(options: EnhancedGeoTIFFOptions);
  /** The tile key: changes whenever tiles must be corrected again. */
  private tileKey_;
  /** The part of the tile key that changes the tiles as read (bands, raw stretch), before the pipeline. */
  private contentKey_;
  /** True when the raw stretch is computed from statistics (normalize: false without a fixed stretch). */
  private get autoRaw_();
  /** The pipeline's `autoStretch` options, when it has one. */
  private autoStretch_;
  /** How the raw stretch is computed now: the pipeline's `autoStretch` options, else `rawStretch`. */
  private rawOptions_;
  /**
   * The pipeline with `autoStretch` fixed from the 8-bit statistics, or
   * removed when it already stretched the raw values.
   */
  private resolved_;
  /** The raw stretch from the kept histograms: the visible area's with `autoStretch`, else the whole image's. */
  private rawFromStats_;
  /** Whether tiles are corrected as they load (false: the layer corrects the drawn map). */
  correctsTiles(): boolean;
  /** How the image is corrected: decided by its band count, the same for every tile. Null before the COG is read. */
  getColorMode(): ColorMode | null;
  private colorMode_;
  /** Bands that hold values (the alpha band OpenLayers adds for nodata not counted); 0 before the COG is read. */
  getValueBandCount(): number;
  /** The bands R, G and B show now (0-based), or null when tiles are drawn as read. */
  getSelect(): [number, number, number] | null;
  /**
   * The name of each value band (0-based, alpha not counted), null for a band
   * without one: the `bandNames` option, else the band's `DESCRIPTION` in
   * GDAL's metadata (`GDAL_METADATA`), as `gdal_translate`, QGIS or
   * rasterio write it. Empty before the COG is read.
   */
  getBandNames(): Promise<Array<string | null>>;
  /** Band names of each source, in the order the bands are read (`sources[].bands` picks them). */
  private readBandNames_;
  /**
   * The geotiff.js images (`GeoTIFFImage`) OpenLayers opened, for reading
   * their tags: one list per source, the full-resolution image first, then
   * the overviews from finest to coarsest. Empty before the COG is read.
   */
  getTiffImages(): unknown[][];
  /**
   * Shows other bands as R, G and B (see the `select` option); null draws the
   * bands as read. Tiles are rebuilt from the raw cache, without reading the
   * COG again. DRA statistics are taken again over the last DRA area, for the
   * new bands; the promise resolves once they are.
   */
  setSelect(select: BandSelection | null): Promise<void>;
  /** The selection tiles are rebuilt with; null when they are drawn as read. */
  private remap_;
  private checkSelect_;
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
  /** Whether the DRA range is locked (see {@link EnhancedGeoTIFF.setDraLocked}). */
  isDraLocked(): boolean;
  /**
   * Locks the DRA range: `updateDra` keeps the statistics it has (of the area
   * shown when they were taken) instead of following the view, so panning and
   * zooming no longer change the colors. DRA settings still apply to the kept
   * statistics. Unlocking lets the next `updateDra` take the view again.
   */
  setDraLocked(locked: boolean): void;
  /**
   * Collects the statistics of the area `map` shows and fixes the pipeline's
   * `autoStretch` steps from them. Call it on the map's `moveend`. Does nothing
   * when the pipeline has no `autoStretch`, the visible area has not changed,
   * or the range is locked ({@link EnhancedGeoTIFF.setDraLocked}) and already
   * has statistics. Tiles are re-corrected only when the resulting range changes.
   */
  updateDra(map: OlMap): Promise<void>;
  /** Statistics of `area` read at level `z`: the raw stretch (normalize: false) and the 8-bit histogram. */
  private collectStats_;
  private applyStats_;
  /** Normalize: false: waits for the first raw stretch, from the statistics of the whole image. */
  private rawReady_;
  /** The raw tile as a {@link Raster} (normalize: false), or null when its band layout is not gray or RGB. */
  private raster_;
  /**
   * The tile's pixels as RGBA (the selected bands), or null for tiles the
   * pipeline cannot take (multispectral without a selection). Raw tiles are
   * stretched with `rawStretch`.
   */
  private tileRGBA_;
  /** RGBA pixels back in the tile layout the layer expects (`bandCount` bands). */
  private toTile_;
  /** The finest level that is no finer than the sample size, coarsened until the tile count fits. */
  private draZoom_;
  /** Re-resolves the pipeline and reloads every tile (from the raw cache), also when the layer corrects the map. */
  private reload_;
  /** Re-resolves the pipeline (and the raw stretch); tiles are re-corrected only if the result changed. */
  private refresh_;
  /** Sets the tile count and time in {@link EnhancedGeoTIFF.stats} back to zero. */
  resetStats(): void;
  /** Called by the GeoTIFF source once the COG's metadata is read; wraps its tile loader. */
  protected setLoader(loader: Loader): void;
  /**
   * Hands the layer 4-band tiles (R, G, B, alpha) when the bands as read
   * would make more. OpenLayers' WebGL layer uploads every band of a tile:
   * past 4 it splits each tile into several textures, pixel by pixel in JS,
   * and samples all of them for every pixel drawn. A 4-band image without
   * an alpha band for no data gets a fifth (coverage) band whenever it is
   * reprojected, and an image with an alpha band for no data one more than
   * its value bands. Only R, G, B and alpha are ever drawn, so the tiles are
   * cut to those: the source tells the layer it has 4 bands with alpha last
   * (`bandCount`, `hasAlpha`, `nodataBandIndex`), while OpenLayers still
   * reads every band (see `composeTile_`) for band assignment and statistics.
   */
  private packTiles_;
  /**
   * Reads the tile offsets and byte counts of every level of a local file in
   * one go. geotiff.js otherwise reads both (8 bytes each) on their own before
   * each tile, one after the other: three reads of the file per tile instead
   * of one. Remote COGs read them through a block cache already.
   */
  private preloadTileIndex_;
  private loadEnhanced_;
  /** The tile's pixels with `margin` pixels of its neighbour tiles around it; transparent where there are none. */
  private withNeighbours_;
  private rawTile_;
}
//#endregion
//# sourceMappingURL=enhanced-geotiff.d.ts.map