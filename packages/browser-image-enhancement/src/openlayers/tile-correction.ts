/**
 * The correction of a layer whose tiles are ordinary pictures (WMS, WMTS,
 * XYZ through `ol/source/ImageTile`), corrected on the GPU by a
 * {@link GpuCorrectedTileLayer}.
 *
 * An {@link EnhancedGeoTIFF} keeps its pipeline itself and reads DRA
 * statistics from the image data; a picture tile source has neither, so the
 * pipeline lives here and DRA takes its statistics from the map the layer
 * has drawn (before correcting it), once the visible tiles have loaded.
 */
import type OlMap from 'ol/Map.js';
import Observable from 'ol/Observable.js';
import { pipeline, type ColorMode, type Histogram, type Pipeline } from '../index.js';
import type { DraInfo } from './enhanced-geotiff.js';

/** Options for {@link TileCorrection}. */
export interface TileCorrectionOptions {
  /** The correction to start with. Default: none. */
  pipeline?: Pipeline;
}

/**
 * Pipeline and DRA statistics for a {@link GpuCorrectedTileLayer} over a
 * picture tile source. Pass it as the layer's `correction`, and to an
 * `EnhanceControl` (`setSource`) to drive it with the panel.
 *
 * @example
 * ```ts
 * const correction = new TileCorrection();
 * const layer = new GpuCorrectedTileLayer({ source: new ImageTile({ url, crossOrigin: 'anonymous' }), correction });
 * enhance.setSource(correction);
 * ```
 */
export default class TileCorrection extends Observable {
  private pipeline_: Pipeline;
  private effective_: Pipeline;
  private stats_: Histogram | null = null;
  private info_: DraInfo | null = null;
  private wanted_ = false;
  private viewKey_ = '';
  private locked_ = false;

  constructor(options: TileCorrectionOptions = {}) {
    super();
    this.pipeline_ = options.pipeline ?? pipeline();
    this.effective_ = this.pipeline_.resolve(null);
  }

  /** The correction as set, before `autoStretch` is fixed from statistics. */
  getPipeline(): Pipeline {
    return this.pipeline_;
  }

  /** Replaces the correction; the layer redraws (no tile is reloaded). */
  setPipeline(p: Pipeline): void {
    this.pipeline_ = p;
    this.effective_ = p.resolve(this.stats_);
    this.changed();
  }

  /** The pipeline the map is corrected with now, with any `autoStretch` already fixed. */
  getEffectivePipeline(): Pipeline {
    return this.effective_;
  }

  /** Picture tiles are corrected as color. */
  getColorMode(): ColorMode {
    return 'rgb';
  }

  /** Always false: the layer corrects the drawn map, never the tiles. */
  correctsTiles(): boolean {
    return false;
  }

  /** Always 0: picture tiles have no bands to assign. */
  getValueBandCount(): number {
    return 0;
  }

  /** Always empty: picture tiles have no bands to name. */
  async getBandNames(): Promise<Array<string | null>> {
    return [];
  }

  /** Always null: picture tiles have no bands to assign. */
  getSelect(): [number, number, number] | null {
    return null;
  }

  /** Does nothing: picture tiles have no bands to assign. */
  async setSelect(): Promise<void> {}

  /** Always `ready`. */
  getState(): 'ready' {
    return 'ready';
  }

  /** What the current DRA statistics were taken from; null before the first statistics. */
  getDraInfo(): DraInfo | null {
    return this.info_;
  }

  /** Whether the DRA range is locked (see {@link TileCorrection.setDraLocked}). */
  isDraLocked(): boolean {
    return this.locked_;
  }

  /**
   * Locks the DRA range: `updateDra` keeps the statistics it has instead of
   * following the view. DRA settings still apply to the kept statistics.
   * Unlocking lets the next `updateDra` take the view again.
   */
  setDraLocked(locked: boolean): void {
    if (locked === this.locked_) return;
    this.locked_ = locked;
    if (!locked) this.viewKey_ = '';
    this.changed();
  }

  /**
   * Asks the layer for new DRA statistics of what `map` shows: they are taken
   * from the next frame it draws, and again once the visible tiles have
   * loaded. Call it on the map's `moveend`. Does nothing when the pipeline has
   * no `autoStretch`, the view has not changed, or the range is locked
   * ({@link TileCorrection.setDraLocked}) and already has statistics.
   */
  async updateDra(map: OlMap): Promise<void> {
    if (!this.pipeline_.needsStats) return;
    if (this.locked_ && this.stats_) return;
    const view = map.getView();
    const key = `${view.getCenter()?.join(',')}:${view.getResolution()}:${view.getRotation()}:${map.getSize()?.join(',')}`;
    // Same view: statistics already taken, or already asked for.
    if (key === this.viewKey_ && (this.stats_ || this.wanted_)) return;
    this.viewKey_ = key;
    this.wanted_ = true;
    this.changed();
    map.once('rendercomplete', () => {
      this.wanted_ = true;
      this.changed();
    });
  }

  /** Whether the layer should take statistics from the frame it draws next. */
  wantsStats(): boolean {
    return this.wanted_ && this.pipeline_.needsStats;
  }

  /** Called by the layer with the statistics of the frame it drew. */
  setStats(stats: Histogram, info: DraInfo): void {
    this.wanted_ = false;
    this.stats_ = stats;
    this.info_ = info;
    this.effective_ = this.pipeline_.resolve(stats);
  }
}
