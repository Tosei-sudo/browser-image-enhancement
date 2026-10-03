/**
 * OpenLayers GeoTIFF source that runs a browser-image-enhancement pipeline on
 * every tile before it is drawn.
 *
 * The source reads the COG exactly like `ol/source/GeoTIFF` (range requests,
 * overviews, nodata/mask handling, normalization to 0-255) and then corrects
 * the decoded tile. Raw tiles are kept in a small cache, so changing the
 * pipeline only re-runs the correction instead of fetching the COG again.
 *
 * DRA (dynamic range adjustment): when the pipeline has an `autoStretch` step,
 * `updateDra(map)` collects the statistics of the area the map shows and fixes
 * the stretch from them. Every tile then gets the same range, so there are no
 * seams; tiles are never stretched on their own statistics.
 *
 * Sharpening reads neighbouring pixels, so each tile is corrected with
 * `pipeline.margin` pixels of its neighbour tiles around it (read through the
 * same raw cache) and cropped back: tile edges match the whole image exactly.
 *
 * With `normalize: false` the source reads the raw values (16-bit, float)
 * and stretches them to 0-255 itself, from statistics of the raw values:
 * those of the whole image until the first `updateDra`, then those of the
 * visible area. Tiles are then corrected as usual.
 *
 * With `correctTiles: false` tiles are left as read and only the pipeline is
 * kept (DRA included): `GpuCorrectedTileLayer` then corrects the drawn map on
 * the GPU, so a new pipeline needs no tile to be reloaded.
 *
 * Band assignment: `select` (or `setSelect`) picks the bands R, G and B show,
 * for example `[3, 2, 1]` for a false-color composite of a 4-band image.
 * Tiles are then rebuilt from the raw cache with those bands in the first
 * three places (and alpha in the fourth), which is what OpenLayers draws.
 * Images with more than 4 bands show bands 0, 1, 2 unless told otherwise.
 */
import GeoTIFF, { type Options as GeoTIFFOptions } from 'ol/source/GeoTIFF.js';
import type { Loader, LoaderOptions } from 'ol/source/DataTile.js';
import type { Data } from 'ol/DataTile.js';
import type OlMap from 'ol/Map.js';
import { getHeight, getIntersection, getWidth, isEmpty, type Extent } from 'ol/extent.js';
import { transformExtent } from 'ol/proj.js';
import { isGraySelection, type BandSelection } from '../bands.js';
import { histogram, mergeHistograms, pipeline, type AutoStretchOptions, type ColorMode, type Histogram, type Rect, type OpSpec, type Pipeline } from '../index.js';
import {
  computeRasterStretch,
  mergeRasterHistograms,
  rasterHistogram,
  rasterRange,
  rasterToImageData,
  type Raster,
  type RasterHistogram,
  type RasterStretch,
  type RasterStretchRange,
} from '../raster.js';
import { warn } from '../warn.js';
import { cropMargin, withMargin } from './margin.js';

/** Options for {@link EnhancedGeoTIFF}: those of `ol/source/GeoTIFF`, plus the correction. */
export interface EnhancedGeoTIFFOptions extends GeoTIFFOptions {
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
   * (default `{}`: percentClip, 0.5 % at each end) applied to the statistics
   * of the whole image and, after each `updateDra`, of the visible area.
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
  private pipeline_: Pipeline;
  /** The pipeline tiles are corrected with: `pipeline_` with `autoStretch` fixed from the DRA statistics. */
  private effective_: Pipeline;
  private readonly worker_: boolean;
  private readonly correctTiles_: boolean;
  private readonly rawCacheSize_: number;
  private readonly draSampleSize_: number;
  private readonly draMaxTiles_: number;
  private readonly raw_ = new Map<string, Promise<Data>>();
  private rawLoader_: Loader | null = null;
  private draStats_: Histogram | null = null;
  private draInfo_: DraInfo | null = null;
  private draKey_ = '';
  private draRequest_ = 0;
  /** The key tiles were last corrected (or drawn) for. */
  private appliedKey_ = '';
  /** True with `normalize: false`: tiles hold raw values that are stretched here. */
  private readonly rawValues_: boolean;
  private readonly rawStretchOption_: RasterStretch | AutoStretchOptions;
  /** The raw stretch in use; null until the first statistics are read. */
  private rawStretch_: RasterStretch | null = null;
  private rawStretchReady_: Promise<void> | null = null;
  /** The bands R, G and B show, as set; null: as read. */
  private select_: readonly [number, number, number] | null;
  /** How many tiles were read and corrected, and the time it took. */
  readonly stats: TileStats = { tiles: 0, ms: 0, reads: 0 };

  constructor(options: EnhancedGeoTIFFOptions) {
    if (options.normalize === false && options.correctTiles === false) {
      throw new TypeError('EnhancedGeoTIFF with normalize: false corrects tiles itself; it cannot be used with correctTiles: false.');
    }
    super(options);
    this.rawValues_ = options.normalize === false;
    this.rawStretchOption_ = options.rawStretch ?? {};
    if ('black' in this.rawStretchOption_ && 'white' in this.rawStretchOption_) this.rawStretch_ = this.rawStretchOption_;
    this.select_ = options.select ? toRgb(options.select) : null;
    this.pipeline_ = options.pipeline ?? pipeline();
    this.worker_ = options.worker ?? true;
    this.correctTiles_ = options.correctTiles ?? true;
    this.rawCacheSize_ = options.rawCacheSize ?? 256;
    this.draSampleSize_ = options.draSampleSize ?? 1024;
    this.draMaxTiles_ = options.draMaxTiles ?? 64;
    this.effective_ = this.pipeline_.resolve(null);
    this.appliedKey_ = this.tileKey_();
    if (this.correctTiles_) this.setKey(this.appliedKey_);
  }

  /** The tile key: changes whenever tiles must be corrected again. */
  private tileKey_(): string {
    const select = this.remap_();
    return `${keyFor(this.effective_)}${select ? `:bands${select.join(',')}` : ''}${this.rawValues_ ? `:raw${JSON.stringify(this.rawStretch_)}` : ''}`;
  }

  /** True when the raw stretch is computed from statistics (normalize: false without a fixed stretch). */
  private get autoRaw_(): boolean {
    return this.rawValues_ && !('black' in this.rawStretchOption_ && 'white' in this.rawStretchOption_);
  }

  /** Whether tiles are corrected as they load (false: the layer corrects the drawn map). */
  correctsTiles(): boolean {
    return this.correctTiles_;
  }

  /** How the image is corrected: decided by its band count, the same for every tile. Null before the COG is read. */
  getColorMode(): ColorMode | null {
    return this.getState() === 'ready' ? this.colorMode_() : null;
  }

  private colorMode_(): ColorMode {
    const select = this.remap_();
    return select ? (isGraySelection(select) ? 'gray' : 'rgb') : colorModeFor(this.bandCount);
  }

  /** Bands that hold values (the alpha band OpenLayers adds for nodata not counted); 0 before the COG is read. */
  getValueBandCount(): number {
    return this.getState() === 'ready' ? this.bandCount - (this.hasAlpha ? 1 : 0) : 0;
  }

  /** The bands R, G and B show now (0-based), or null when tiles are drawn as read. */
  getSelect(): [number, number, number] | null {
    const select = this.remap_();
    return select ? [...select] : null;
  }

  /**
   * Shows other bands as R, G and B (see the `select` option); null draws the
   * bands as read. Tiles are rebuilt from the raw cache, without reading the
   * COG again. DRA statistics are taken again over the last DRA area, for the
   * new bands; the promise resolves once they are.
   */
  async setSelect(select: BandSelection | null): Promise<void> {
    const next = select ? toRgb(select) : null;
    if (this.getState() === 'ready') this.checkSelect_(next);
    this.select_ = next;
    // Statistics of the old bands no longer apply.
    this.draKey_ = '';
    if (this.autoRaw_) {
      this.rawStretch_ = null;
      this.rawStretchReady_ = null;
    }
    this.reload_();
    const info = this.draInfo_;
    if (!info || !this.rawLoader_ || this.getState() !== 'ready' || (!this.pipeline_.needsStats && !this.autoRaw_)) return;
    const request = ++this.draRequest_;
    const stats = await this.collectStats_(info.extent, info.z);
    if (request !== this.draRequest_) return;
    this.draKey_ = `${info.z}:${info.extent.join(',')}`;
    this.applyStats_(stats);
  }

  /** The selection tiles are rebuilt with; null when they are drawn as read. */
  private remap_(): readonly [number, number, number] | null {
    if (this.getValueBandCount() < 3) return null;
    return this.select_ ?? (this.bandCount > 4 ? [0, 1, 2] : null);
  }

  private checkSelect_(select: readonly number[] | null): void {
    if (!select) return;
    const n = this.getValueBandCount();
    if (n < 3) throw new RangeError(`Band assignment needs an image with at least 3 bands; this one has ${n}.`);
    if (select.some((b) => !Number.isInteger(b) || b < 0 || b >= n)) {
      throw new RangeError(`Bands must be 0 to ${n - 1} (0-based), got ${JSON.stringify(select)}.`);
    }
  }

  /** The correction as set, before `autoStretch` is fixed from statistics. */
  getPipeline(): Pipeline {
    return this.pipeline_;
  }

  /**
   * Replaces the correction. Tiles on screen stay visible until their
   * re-corrected versions are ready, then swap in.
   */
  setPipeline(p: Pipeline): void {
    this.pipeline_ = p;
    this.refresh_();
  }

  /** The pipeline tiles are corrected with now, with any `autoStretch` already fixed. */
  getEffectivePipeline(): Pipeline {
    return this.effective_;
  }

  /** What the current DRA statistics were taken from; null before the first `updateDra`. */
  getDraInfo(): DraInfo | null {
    return this.draInfo_;
  }

  /**
   * Collects the statistics of the area `map` shows and fixes the pipeline's
   * `autoStretch` steps from them. Call it on the map's `moveend`. Does nothing
   * when the pipeline has no `autoStretch` or the visible area has not changed.
   * Tiles are re-corrected only when the resulting range changes.
   */
  async updateDra(map: OlMap): Promise<void> {
    if (!this.pipeline_.needsStats && !this.autoRaw_) return;
    const request = ++this.draRequest_;
    const grid = this.getTileGrid();
    const projection = this.getProjection();
    const size = map.getSize();
    if (!this.rawLoader_ || !grid || !projection || !size || this.getState() !== 'ready') return;

    const view = map.getView();
    const visible = transformExtent(view.calculateExtent(size), view.getProjection(), projection);
    const area = getIntersection(visible, grid.getExtent());
    if (isEmpty(area)) return; // the image is off screen: keep the last range

    const z = this.draZoom_(area);
    const key = `${z}:${area.join(',')}`;
    if (key === this.draKey_ && (this.draStats_ || !this.pipeline_.needsStats)) return;

    const stats = await this.collectStats_(area, z);
    if (request !== this.draRequest_) return; // a newer view superseded this one
    this.draKey_ = key;
    this.applyStats_(stats);
  }

  /** Statistics of `area` read at level `z`: the raw stretch (normalize: false) and the 8-bit histogram. */
  private async collectStats_(area: Extent, z: number): Promise<{ info: DraInfo; rawStretch: RasterStretch | null; histogram: Histogram }> {
    const loader = this.rawLoader_!;
    const grid = this.getTileGrid()!;
    const parts: Array<Promise<{ raw: Data; rect: Rect; width: number; height: number } | null>> = [];
    grid.forEachTileCoord(area, z, ([tz, x, y]) => {
      const tileExtent = grid.getTileCoordExtent([tz, x, y]);
      const res = grid.getResolution(tz);
      const [width, height] = this.getTileSize(tz);
      // The part of the tile inside the area, in tile pixels.
      const rect = {
        x: (area[0] - tileExtent[0]) / res,
        y: (tileExtent[3] - area[3]) / res,
        width: (area[2] - area[0]) / res,
        height: (area[3] - area[1]) / res,
      };
      parts.push(
        this.rawTile_(loader, tz, x, y, { signal: neverAborted, crossOrigin: 'anonymous' }).then(
          (raw) => ({ raw, rect, width, height }),
          () => null, // a tile that fails to load is left out of the statistics
        ),
      );
    });
    const tiles = (await Promise.all(parts)).filter((t) => t !== null);

    let rawStretch = this.rawStretch_;
    let rawInfo: DraInfo['rawStretch'];
    if (this.autoRaw_) {
      // One range for every tile, so their histograms can be added.
      const rasters = tiles.flatMap((t) => {
        const r = this.raster_(t.raw, t.width, t.height);
        return r ? [{ r, rect: t.rect }] : [];
      });
      let lo = Infinity;
      let hi = -Infinity;
      for (const { r, rect } of rasters) {
        const range = rasterRange(r, rect);
        if (range) [lo, hi] = [Math.min(lo, range[0]), Math.max(hi, range[1])];
      }
      if (lo <= hi) {
        const merged: RasterHistogram = mergeRasterHistograms(rasters.map(({ r, rect }) => rasterHistogram(r, { range: [lo, hi], rect })));
        rawInfo = computeRasterStretch(merged, this.rawStretchOption_ as AutoStretchOptions);
        rawStretch = rawInfo;
      }
    }

    const histograms: Histogram[] = [];
    let pixels = 0;
    for (const t of tiles) {
      const rgba = this.tileRGBA_(t.raw, t.width, t.height, rawStretch);
      if (!rgba) continue;
      const h = histogram({ data: rgba, width: t.width, height: t.height }, { rect: t.rect, colorMode: this.colorMode_() });
      histograms.push(h);
      pixels += h.count;
    }
    return {
      info: { extent: area, z, tiles: histograms.length, pixels, ...(rawInfo ? { rawStretch: rawInfo } : {}) },
      rawStretch,
      histogram: mergeHistograms(histograms),
    };
  }

  private applyStats_(stats: { info: DraInfo; rawStretch: RasterStretch | null; histogram: Histogram }): void {
    this.draStats_ = stats.histogram;
    this.draInfo_ = stats.info;
    if (this.autoRaw_ && stats.rawStretch) this.rawStretch_ = stats.rawStretch;
    this.refresh_();
  }

  /** Normalize: false: waits for the first raw stretch, from the statistics of the whole image. */
  private rawReady_(): Promise<void> {
    if (!this.rawValues_ || this.rawStretch_) return Promise.resolve();
    this.rawStretchReady_ ??= (async () => {
      const grid = this.getTileGrid()!;
      const area = grid.getExtent();
      const stats = await this.collectStats_(area, this.draZoom_(area));
      // updateDra may have set a stretch for the visible area in the meantime; keep that one.
      if (!this.rawStretch_) {
        this.rawStretch_ = stats.rawStretch ?? { black: 0, white: 1 };
        this.draInfo_ ??= stats.info;
        this.draStats_ ??= stats.histogram;
        // The tiles waiting for this read the new stretch and pipeline when they continue; no reload needed.
        this.effective_ = this.pipeline_.resolve(this.draStats_);
        this.appliedKey_ = this.tileKey_();
      }
    })();
    return this.rawStretchReady_;
  }

  /** The raw tile as a {@link Raster} (normalize: false), or null when its band layout is not gray or RGB. */
  private raster_(raw: Data, width: number, height: number): Raster | null {
    if (!(raw instanceof Float32Array)) return null;
    const bands = raw.length / (width * height);
    const color = bands - (this.hasAlpha ? 1 : 0);
    if (!Number.isInteger(bands)) return null;
    const select = this.remap_();
    if (select) return { data: raw, width, height, bands, alpha: this.hasAlpha, select };
    if (color !== 1 && color !== 3) return null;
    return { data: raw, width, height, bands, alpha: this.hasAlpha };
  }

  /**
   * The tile's pixels as RGBA (the selected bands), or null for tiles the
   * pipeline cannot take (multispectral without a selection). Raw tiles are
   * stretched with `rawStretch`.
   */
  private tileRGBA_(raw: Data, width: number, height: number, rawStretch: RasterStretch | null = this.rawStretch_): Uint8ClampedArray | null {
    if (this.rawValues_) {
      const r = this.raster_(raw, width, height);
      if (!r || !rawStretch) return null;
      return rasterToImageData(r, { stretch: rawStretch }).data;
    }
    if (!(raw instanceof Uint8Array) && !(raw instanceof Uint8ClampedArray)) return null;
    const bands = raw.length / (width * height);
    if (!Number.isInteger(bands) || bands < 1) return null;
    const select = this.remap_();
    if (select) return selectRGBA(raw, bands, select, this.hasAlpha ? bands - 1 : -1, width * height);
    if (bands > 4) return null;
    return toRGBA(raw, bands, width * height);
  }

  /** RGBA pixels back in the tile layout OpenLayers expects (`bandCount` bands). */
  private toTile_(rgba: Uint8ClampedArray, pixels: number): Uint8Array {
    return this.remap_() ? toSelectedTile(rgba, this.bandCount, this.hasAlpha, pixels) : fromRGBA(rgba, this.bandCount, pixels);
  }

  /** The finest level that is no finer than the sample size, coarsened until the tile count fits. */
  private draZoom_(area: Extent): number {
    const grid = this.getTileGrid()!;
    const target = Math.max(getWidth(area), getHeight(area)) / this.draSampleSize_;
    let z = grid.getMinZoom();
    for (let k = grid.getMaxZoom(); k >= grid.getMinZoom(); k--) {
      if (grid.getResolution(k) >= target) {
        z = k;
        break;
      }
    }
    const count = (k: number) => {
      let n = 0;
      grid.forEachTileCoord(area, k, () => n++);
      return n;
    };
    while (z > grid.getMinZoom() && count(z) > this.draMaxTiles_) z--;
    return z;
  }

  /** Re-resolves the pipeline and reloads every tile (from the raw cache), also when the layer corrects the map. */
  private reload_(): void {
    this.effective_ = this.pipeline_.resolve(this.draStats_);
    this.appliedKey_ = this.tileKey_();
    this.setKey(this.appliedKey_);
  }

  /** Re-resolves the pipeline; tiles are re-corrected only if the result changed. */
  private refresh_(): void {
    const next = this.pipeline_.resolve(this.draStats_);
    this.effective_ = next;
    const key = this.tileKey_();
    if (key === this.appliedKey_) return;
    this.appliedKey_ = key;
    // Reload the tiles with the new correction, or only redraw them when the layer corrects the map.
    if (this.correctTiles_) this.setKey(key);
    else this.changed();
  }

  /** Sets the tile count and time in {@link EnhancedGeoTIFF.stats} back to zero. */
  resetStats(): void {
    this.stats.tiles = 0;
    this.stats.ms = 0;
  }

  /** Called by the GeoTIFF source once the COG's metadata is read; wraps its tile loader. */
  protected override setLoader(loader: Loader): void {
    this.rawLoader_ = loader;
    // The band count is known now (OpenLayers sets the source ready right after this).
    if (this.select_) {
      const n = this.bandCount - (this.hasAlpha ? 1 : 0);
      if (n < 3 || this.select_.some((b) => b >= n)) {
        warn(`select ${JSON.stringify(this.select_)} does not fit an image with ${n} value bands; the bands are drawn as read.`);
        this.select_ = null;
      }
    }
    super.setLoader((z, x, y, options) => this.loadEnhanced_(loader, z, x, y, options));
  }

  private async loadEnhanced_(loader: Loader, z: number, x: number, y: number, options: LoaderOptions): Promise<Data> {
    const [raw] = await Promise.all([this.rawTile_(loader, z, x, y, options), this.rawReady_()]);
    const p = this.effective_;
    const remap = this.remap_() !== null;
    if (!remap && ((p.ops.length === 0 && !this.rawValues_) || !this.correctTiles_)) return raw;

    const [width, height] = this.getTileSize(z);
    const rgba = this.tileRGBA_(raw, width, height);
    if (!rgba) return raw; // multispectral: left as is
    if (p.ops.length === 0 || !this.correctTiles_) return this.toTile_(rgba, width * height);

    const t0 = performance.now();
    const margin = p.margin;
    const input =
      margin > 0
        ? { data: await this.withNeighbours_(loader, z, x, y, rgba, margin), width: width + 2 * margin, height: height + 2 * margin }
        : { data: rgba, width, height };
    const result = await p.run(
      input,
      {
        // Decide per source, never per tile: `auto` could judge one tile gray
        // and its neighbour color, leaving a visible seam.
        colorMode: this.colorMode_(),
        worker: this.worker_,
        signal: options.signal,
      },
    );
    this.stats.tiles++;
    this.stats.ms += performance.now() - t0;
    return this.toTile_(cropMargin(result.data, width, height, margin), width * height);
  }

  /** The tile's pixels with `margin` pixels of its neighbour tiles around it; transparent where there are none. */
  private async withNeighbours_(loader: Loader, z: number, x: number, y: number, rgba: Uint8ClampedArray, margin: number): Promise<Uint8ClampedArray> {
    const [width, height] = this.getTileSize(z);
    const range = this.getTileGrid()?.getFullTileRange(z);
    const nx = Math.ceil(margin / width);
    const ny = Math.ceil(margin / height);
    const tiles = new Map<string, Uint8ClampedArray | null>();
    const reads: Array<Promise<void>> = [];
    for (let dy = -ny; dy <= ny; dy++) {
      for (let dx = -nx; dx <= nx; dx++) {
        const key = `${dx},${dy}`;
        if (dx === 0 && dy === 0) {
          tiles.set(key, rgba);
          continue;
        }
        if (!range || !range.containsXY(x + dx, y + dy)) continue;
        reads.push(
          this.rawTile_(loader, z, x + dx, y + dy, { signal: neverAborted, crossOrigin: 'anonymous' }).then(
            (raw) => {
              const t = this.tileRGBA_(raw, width, height);
              if (t) tiles.set(key, t);
            },
            () => {}, // a neighbour that fails to load is left transparent
          ),
        );
      }
    }
    await Promise.all(reads);
    return withMargin((dx, dy) => tiles.get(`${dx},${dy}`) ?? null, width, height, margin);
  }

  private rawTile_(loader: Loader, z: number, x: number, y: number, options: LoaderOptions): Promise<Data> {
    const key = `${z}/${x}/${y}`;
    const cached = this.raw_.get(key);
    if (cached) {
      // Refresh its position so the least recently used tile is evicted first.
      this.raw_.delete(key);
      this.raw_.set(key, cached);
      return cached;
    }
    // The raw read is shared by every pipeline version of this tile, so it must
    // not be cancelled when one of those versions is discarded.
    this.stats.reads++;
    const promise = Promise.resolve(loader(z, x, y, { ...options, signal: neverAborted }));
    this.raw_.set(key, promise);
    promise.catch(() => {
      if (this.raw_.get(key) === promise) this.raw_.delete(key);
    });
    while (this.raw_.size > this.rawCacheSize_) {
      this.raw_.delete(this.raw_.keys().next().value!);
    }
    return promise;
  }
}

const neverAborted = new AbortController().signal;

const keyFor = (p: Pipeline) => `enhanced:${JSON.stringify(p.ops satisfies readonly OpSpec[])}`;

/** 1 band = gray, 2 = gray + alpha, 3 = RGB, 4 = RGB + alpha (OpenLayers adds alpha for nodata). */
function colorModeFor(bands: number): ColorMode {
  return bands <= 2 ? 'gray' : 'rgb';
}

export function toRGBA(src: ArrayLike<number>, bands: number, pixels: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels * 4);
  for (let p = 0, i = 0, o = 0; p < pixels; p++, i += bands, o += 4) {
    if (bands <= 2) {
      out[o] = out[o + 1] = out[o + 2] = src[i];
      out[o + 3] = bands === 2 ? src[i + 1] : 255;
    } else {
      out[o] = src[i];
      out[o + 1] = src[i + 1];
      out[o + 2] = src[i + 2];
      out[o + 3] = bands === 4 ? src[i + 3] : 255;
    }
  }
  return out;
}

export function fromRGBA(rgba: Uint8ClampedArray, bands: number, pixels: number): Uint8Array {
  if (bands === 4) return new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.length);
  const out = new Uint8Array(pixels * bands);
  for (let p = 0, i = 0, o = 0; p < pixels; p++, i += 4, o += bands) {
    for (let b = 0; b < bands; b++) out[o + b] = bands <= 2 && b === 1 ? rgba[i + 3] : rgba[i + b];
  }
  return out;
}

/** Three band indexes from a selection (one index means that band in all three). */
function toRgb(select: BandSelection): readonly [number, number, number] {
  return select.length === 1 ? [select[0], select[0], select[0]] : [select[0], select[1], select[2]];
}

/** RGBA from three bands of a tile; alpha from the alpha band (`alpha` index, -1 for none) or opaque. */
export function selectRGBA(src: ArrayLike<number>, bands: number, select: readonly number[], alpha: number, pixels: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels * 4);
  const [r, g, b] = select;
  for (let p = 0, i = 0, o = 0; p < pixels; p++, i += bands, o += 4) {
    out[o] = src[i + r];
    out[o + 1] = src[i + g];
    out[o + 2] = src[i + b];
    out[o + 3] = alpha >= 0 ? src[i + alpha] : 255;
  }
  return out;
}

/**
 * A tile of `bands` bands that OpenLayers draws as the RGBA pixels: R, G, B
 * in the first three bands, alpha in the fourth (its first texture), and
 * alpha again in the last band when that is the nodata band it discards on.
 */
export function toSelectedTile(rgba: Uint8ClampedArray, bands: number, hasAlpha: boolean, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels * bands);
  const n = Math.min(bands, 4);
  for (let p = 0, i = 0, o = 0; p < pixels; p++, i += 4, o += bands) {
    for (let c = 0; c < n; c++) out[o + c] = rgba[i + c];
    if (hasAlpha) out[o + bands - 1] = rgba[i + 3];
  }
  return out;
}
