/**
 * OpenLayers GeoTIFF source that runs a browser-image-enhancement pipeline on
 * every tile before it is drawn.
 *
 * The source reads the COG exactly like `ol/source/GeoTIFF` (range requests,
 * overviews, nodata/mask handling, normalization to 0-255) and then corrects
 * the decoded tile. Raw tiles are kept in a small cache, so changing the
 * pipeline only re-runs the correction instead of fetching the COG again.
 */
import GeoTIFF, { type Options as GeoTIFFOptions } from 'ol/source/GeoTIFF.js';
import type { Loader, LoaderOptions } from 'ol/source/DataTile.js';
import type { Data } from 'ol/DataTile.js';
import { pipeline, type ColorMode, type Pipeline } from '../../src/index.js';

export interface EnhancedGeoTIFFOptions extends GeoTIFFOptions {
  /** Correction to apply. Default: an empty pipeline (no change). */
  pipeline?: Pipeline;
  /** Run corrections in Web Workers (default true). */
  worker?: boolean;
  /** Raw tiles kept for re-correction. Default 256 (about 64 MB for RGBA 256×256 tiles). */
  rawCacheSize?: number;
}

export interface TileStats {
  /** Tiles corrected since the last `resetStats()`. */
  tiles: number;
  /** Total time spent in the pipeline, in milliseconds. */
  ms: number;
  /** Tiles read from the COG (cache misses). Not reset by `resetStats()`. */
  reads: number;
}

export default class EnhancedGeoTIFF extends GeoTIFF {
  private pipeline_: Pipeline;
  private readonly worker_: boolean;
  private readonly rawCacheSize_: number;
  private readonly raw_ = new Map<string, Promise<Data>>();
  private generation_ = 0;
  readonly stats: TileStats = { tiles: 0, ms: 0, reads: 0 };

  constructor(options: EnhancedGeoTIFFOptions) {
    if (options.normalize === false) {
      throw new TypeError('EnhancedGeoTIFF needs normalize: true (the pipeline works on 8-bit values).');
    }
    super(options);
    this.pipeline_ = options.pipeline ?? pipeline();
    this.worker_ = options.worker ?? true;
    this.rawCacheSize_ = options.rawCacheSize ?? 256;
    this.setKey(this.keyFor_());
  }

  getPipeline(): Pipeline {
    return this.pipeline_;
  }

  /**
   * Replaces the correction. Tiles on screen stay visible until their
   * re-corrected versions are ready, then swap in.
   */
  setPipeline(p: Pipeline): void {
    this.pipeline_ = p;
    this.setKey(this.keyFor_());
  }

  resetStats(): void {
    this.stats.tiles = 0;
    this.stats.ms = 0;
  }

  private keyFor_(): string {
    return `enhanced:${++this.generation_}:${JSON.stringify(this.pipeline_.ops)}`;
  }

  /** Called by the GeoTIFF source once the COG's metadata is read; wraps its tile loader. */
  protected override setLoader(loader: Loader): void {
    super.setLoader((z, x, y, options) => this.loadEnhanced_(loader, z, x, y, options));
  }

  private async loadEnhanced_(loader: Loader, z: number, x: number, y: number, options: LoaderOptions): Promise<Data> {
    const raw = await this.rawTile_(loader, z, x, y, options);
    if (!(raw instanceof Uint8Array) && !(raw instanceof Uint8ClampedArray)) return raw;
    if (this.pipeline_.ops.length === 0) return raw;

    const [width, height] = this.getTileSize(z);
    const bands = raw.length / (width * height);
    if (!Number.isInteger(bands) || bands < 1 || bands > 4) return raw; // multispectral: left as is

    const t0 = performance.now();
    const rgba = toRGBA(raw, bands, width * height);
    const result = await this.pipeline_.run(
      { data: rgba, width, height },
      {
        // Decide per source, never per tile: `auto` could judge one tile gray
        // and its neighbour color, leaving a visible seam.
        colorMode: colorModeFor(bands),
        worker: this.worker_,
        signal: options.signal,
      },
    );
    this.stats.tiles++;
    this.stats.ms += performance.now() - t0;
    return fromRGBA(result.data, bands, width * height);
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
