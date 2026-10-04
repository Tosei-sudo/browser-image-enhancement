import { ColorMode, Histogram } from "../types.js";
import { Pipeline } from "../pipeline.js";
import { DraInfo } from "./enhanced-geotiff.js";
import Observable from "ol/Observable.js";
import OlMap from "ol/Map.js";
//#region src/openlayers/tile-correction.d.ts
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
  private pipeline_;
  private effective_;
  private stats_;
  private info_;
  private wanted_;
  private viewKey_;
  private locked_;
  constructor(options?: TileCorrectionOptions);
  /** The correction as set, before `autoStretch` is fixed from statistics. */
  getPipeline(): Pipeline;
  /** Replaces the correction; the layer redraws (no tile is reloaded). */
  setPipeline(p: Pipeline): void;
  /** The pipeline the map is corrected with now, with any `autoStretch` already fixed. */
  getEffectivePipeline(): Pipeline;
  /** Picture tiles are corrected as color. */
  getColorMode(): ColorMode;
  /** Always false: the layer corrects the drawn map, never the tiles. */
  correctsTiles(): boolean;
  /** Always 0: picture tiles have no bands to assign. */
  getValueBandCount(): number;
  /** Always null: picture tiles have no bands to assign. */
  getSelect(): [number, number, number] | null;
  /** Does nothing: picture tiles have no bands to assign. */
  setSelect(): Promise<void>;
  /** Always `ready`. */
  getState(): 'ready';
  /** What the current DRA statistics were taken from; null before the first statistics. */
  getDraInfo(): DraInfo | null;
  /** Whether the DRA range is locked (see {@link TileCorrection.setDraLocked}). */
  isDraLocked(): boolean;
  /**
   * Locks the DRA range: `updateDra` keeps the statistics it has instead of
   * following the view. DRA settings still apply to the kept statistics.
   * Unlocking lets the next `updateDra` take the view again.
   */
  setDraLocked(locked: boolean): void;
  /**
   * Asks the layer for new DRA statistics of what `map` shows: they are taken
   * from the next frame it draws, and again once the visible tiles have
   * loaded. Call it on the map's `moveend`. Does nothing when the pipeline has
   * no `autoStretch`, the view has not changed, or the range is locked
   * ({@link TileCorrection.setDraLocked}) and already has statistics.
   */
  updateDra(map: OlMap): Promise<void>;
  /** Whether the layer should take statistics from the frame it draws next. */
  wantsStats(): boolean;
  /** Called by the layer with the statistics of the frame it drew. */
  setStats(stats: Histogram, info: DraInfo): void;
}
//#endregion
//# sourceMappingURL=tile-correction.d.ts.map