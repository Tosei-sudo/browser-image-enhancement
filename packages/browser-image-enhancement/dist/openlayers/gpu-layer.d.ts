import TileCorrection from "./tile-correction.js";
import WebGLTileLayer, { Options } from "ol/layer/WebGLTile.js";
import { FrameState } from "ol/Map.js";
//#region src/openlayers/gpu-layer.d.ts
/** Options for {@link GpuCorrectedTileLayer}: those of `ol/layer/WebGLTile`, plus `gpu`. */
export interface GpuCorrectedTileLayerOptions extends Options {
  /** Set to false to draw the tiles as the source gives them, like a plain WebGLTile layer. Default true. */
  gpu?: boolean;
  /**
   * The correction for a source that is not an {@link EnhancedGeoTIFF}
   * (an `ol/source/ImageTile` of WMS, WMTS or XYZ tiles). Ignored over an
   * `EnhancedGeoTIFF`, which keeps its own pipeline.
   */
  correction?: TileCorrection;
}
/**
 * `ol/layer/WebGLTile` that corrects the drawn map on the GPU with the
 * pipeline of its {@link EnhancedGeoTIFF} source (created with
 * `correctTiles: false`), or of its `correction` over any other tile source.
 * Without WebGL2 it draws the tiles as read.
 */
export default class GpuCorrectedTileLayer extends WebGLTileLayer {
  private readonly output_;
  private gpu_;
  private readonly correction_;
  private readonly correctionKey_;
  private readonly useGpu_;
  private disposed_;
  /** Small canvas the drawn map is read through for DRA statistics. */
  private sample_;
  /** The style given in the options, shown unless the shader stretches raw values. */
  private readonly userStyle_;
  /** Whether the raw-stretch style is set. */
  private stretching_;
  /** The raw-stretch style's variables, updated in place (the shader reads them on every draw). */
  private readonly stretch_;
  /** Frames corrected so far. */
  frames: number;
  constructor(options?: GpuCorrectedTileLayerOptions);
  /** Whether the layer can correct on the GPU (WebGL2 is available and the context is not lost right now). */
  hasGpu(): boolean;
  /** The `correction` given in the options, or null. */
  getCorrection(): TileCorrection | null;
  /** The canvas the corrected map is shown on (for reading pixels in tests). */
  getOutputCanvas(): HTMLCanvasElement;
  render(frameState: FrameState | null, target: HTMLElement): HTMLElement;
  /** Sets the raw-stretch style while the source hands raw float tiles, and its variables from the source's stretch. */
  private updateStretch_;
  /** DRA statistics of the map as drawn (before correction), read through a canvas of at most 512 px. */
  private sampleStats_;
  protected disposeInternal(): void;
}
//#endregion
//# sourceMappingURL=gpu-layer.d.ts.map