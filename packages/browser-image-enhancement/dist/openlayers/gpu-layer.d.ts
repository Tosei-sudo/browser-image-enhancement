import WebGLTileLayer, { Options } from "ol/layer/WebGLTile.js";
import { FrameState } from "ol/Map.js";
//#region src/openlayers/gpu-layer.d.ts
/** Options for {@link GpuCorrectedTileLayer}: those of `ol/layer/WebGLTile`, plus `gpu`. */
export interface GpuCorrectedTileLayerOptions extends Options {
  /** Set to false to draw the tiles as the source gives them, like a plain WebGLTile layer. Default true. */
  gpu?: boolean;
}
/**
 * `ol/layer/WebGLTile` that corrects the drawn map on the GPU with the
 * pipeline of its {@link EnhancedGeoTIFF} source (created with
 * `correctTiles: false`). Without WebGL2 it draws the tiles as read.
 */
export default class GpuCorrectedTileLayer extends WebGLTileLayer {
  private readonly output_;
  private gpu_;
  /** Frames corrected so far. */
  frames: number;
  constructor(options?: GpuCorrectedTileLayerOptions);
  /** Whether the layer can correct on the GPU (WebGL2 is available and the context was not lost). */
  hasGpu(): boolean;
  /** The canvas the corrected map is shown on (for reading pixels in tests). */
  getOutputCanvas(): HTMLCanvasElement;
  render(frameState: FrameState | null, target: HTMLElement): HTMLElement;
  protected disposeInternal(): void;
}
//#endregion
//# sourceMappingURL=gpu-layer.d.ts.map