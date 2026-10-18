import { ColorScale, ColorScaleOptions } from "../color-scale.js";
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
  /** A color scale for a monochrome image (see {@link GpuCorrectedTileLayer.setColorScale}). Default none. */
  colorScale?: LayerColorScale | null;
  /** How the layer is blended with the layers under it (see {@link GpuCorrectedTileLayer.setBlendMode}). Default `normal`. */
  blendMode?: LayerBlendMode;
}
/** A color scale with its options, as {@link GpuCorrectedTileLayer.setColorScale} takes it. */
export interface LayerColorScale extends ColorScaleOptions {
  /** A preset's name (`'red'`, `'inferno'`…) or the scale's stops. */
  scale: ColorScale;
}
/**
 * How a layer is laid over the layers under it, as CSS `mix-blend-mode`:
 * `screen` adds light (red over cyan shows white where both are bright),
 * `difference` shows where two images differ, `multiply` darkens.
 */
export type LayerBlendMode = 'normal' | 'screen' | 'lighten' | 'darken' | 'multiply' | 'difference';
/**
 * `ol/layer/WebGLTile` that corrects the drawn map on the GPU with the
 * pipeline of its {@link EnhancedGeoTIFF} source (created with
 * `correctTiles: false`), or of its `correction` over any other tile source.
 * Without WebGL2 it draws the tiles as read.
 */
export default class GpuCorrectedTileLayer extends WebGLTileLayer {
  private readonly output_;
  /** Made the first time a frame is corrected or colored, so a layer that does neither holds no WebGL context of its own. */
  private gpu_;
  /** Whether WebGL2 could not be had (no use trying again), or the context is lost until the browser restores it. */
  private noGpu_;
  private lost_;
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
  private colorScale_;
  private palette_;
  private blendMode_;
  /** The class name that gives the layer a WebGL canvas of its own (see {@link GpuCorrectedTileLayer.getClassName}). */
  private readonly ownClass_;
  constructor(options?: GpuCorrectedTileLayerOptions);
  /** The renderer, made when first needed; null without WebGL2 (or while the context is lost). */
  private gpu;
  /**
   * OpenLayers draws neighbouring WebGL layers of the same class name on one
   * canvas, so a layer that colors, corrects or blends what it drew would do
   * it to the layers under it too. Such a layer gets a class name of its own,
   * hence a canvas of its own; the others keep sharing one (a WebGL context
   * fewer each).
   */
  getClassName(): string;
  /**
   * Whether the layer does something to its frame (see {@link GpuCorrectedTileLayer.getClassName}):
   * not an image left as it is, so many of those share one canvas (and WebGL context).
   */
  private ownsCanvas_;
  /** Whether the layer can correct on the GPU (WebGL2 is available and the context is not lost right now). */
  hasGpu(): boolean;
  /** The `correction` given in the options, or null. */
  getCorrection(): TileCorrection | null;
  /**
   * Colors the corrected map with a color scale (pseudo-color): each pixel
   * by its gray value, black at one end of the scale and white at the other.
   * Meant for monochrome images (a SAR scene, one band); a colored image is
   * colored by its luminance. Null shows the image as corrected. Done on the
   * GPU after the correction, so a new scale only redraws the map; without
   * WebGL2 the map is shown uncolored.
   */
  setColorScale(colorScale: LayerColorScale | null): void;
  /** The color scale set with {@link GpuCorrectedTileLayer.setColorScale}, or null. */
  getColorScale(): LayerColorScale | null;
  /**
   * Sets how the layer is laid over the layers under it (CSS
   * `mix-blend-mode` of its canvas). With `screen`, two scenes in red and
   * in cyan show white where both are bright and their own color where only
   * one is: a two-date color composite, without resampling either.
   */
  setBlendMode(mode: LayerBlendMode): void;
  /** The blend mode set with {@link GpuCorrectedTileLayer.setBlendMode} (`normal` by default). */
  getBlendMode(): LayerBlendMode;
  /** The canvas the corrected map is shown on (for reading pixels in tests). */
  getOutputCanvas(): HTMLCanvasElement;
  render(frameState: FrameState | null, target: HTMLElement): HTMLElement;
  /** Sets the blend mode on the element shown (OpenLayers may return none, for a frame it does not draw). */
  private blend_;
  private correct_;
  /** Sets the raw-stretch style while the source hands raw float tiles, and its variables from the source's stretch. */
  private updateStretch_;
  /** DRA statistics of the map as drawn (before correction), read through a canvas of at most 512 px. */
  private sampleStats_;
  protected disposeInternal(): void;
}
//#endregion
//# sourceMappingURL=gpu-layer.d.ts.map