/**
 * WebGL tile layer that corrects the drawn map on the GPU.
 *
 * OpenLayers draws the tiles as read (an `EnhancedGeoTIFF` with
 * `correctTiles: false`) into the layer's WebGL canvas; the layer then runs
 * the source's pipeline over that canvas with `createGpuRenderer`, GPU to GPU,
 * and shows the result instead. A new pipeline only redraws the map: no tile
 * is reloaded or corrected again, so the image follows a slider.
 *
 * The correction works on screen pixels, after OpenLayers has resampled and
 * reprojected the tiles. Per-pixel steps give the same result as correcting
 * the tiles; DRA uses the statistics the source collected from the image.
 * Sharpening, which looks at neighbouring pixels, works at screen resolution:
 * its radius is in screen pixels, so it looks the same at every zoom level.
 */
import WebGLTileLayer, { type Options } from 'ol/layer/WebGLTile.js';
import type { FrameState } from 'ol/Map.js';
import { createGpuRenderer, type GpuRenderer } from '../../src/index.js';
import EnhancedGeoTIFF from './enhanced-geotiff.js';

export interface GpuCorrectedTileLayerOptions extends Options {
  /** Set to false to draw the tiles as the source gives them, like a plain WebGLTile layer. Default true. */
  gpu?: boolean;
}

export default class GpuCorrectedTileLayer extends WebGLTileLayer {
  private readonly output_ = document.createElement('canvas');
  private gpu_: GpuRenderer | null;
  /** Frames corrected so far. */
  frames = 0;

  constructor(options: GpuCorrectedTileLayerOptions = {}) {
    // A class name of its own gives the layer its own WebGL canvas: OpenLayers
    // otherwise shares one canvas between neighbouring WebGL layers.
    super({ className: 'ol-layer gpu-corrected', ...options });
    this.gpu_ = options.gpu === false ? null : createGpuRenderer({ canvas: this.output_ });
    this.output_.addEventListener('webglcontextlost', () => {
      this.gpu_ = null;
      this.changed();
    });
  }

  /** Whether the layer can correct on the GPU (WebGL2 is available and the context was not lost). */
  hasGpu(): boolean {
    return this.gpu_ !== null;
  }

  /** The canvas the corrected map is shown on (for reading pixels in tests). */
  getOutputCanvas(): HTMLCanvasElement {
    return this.output_;
  }

  override render(frameState: FrameState | null, target: HTMLElement): HTMLElement {
    const drawn = super.render(frameState, target);
    const source = this.getSource();
    const gpu = this.gpu_;
    if (!(drawn instanceof HTMLCanvasElement) || !gpu || !(source instanceof EnhancedGeoTIFF) || source.correctsTiles()) return drawn;
    const pipeline = source.getEffectivePipeline();
    const colorMode = source.getColorMode();
    if (pipeline.ops.length === 0 || !colorMode) return drawn;
    if (drawn.width > gpu.maxSize || drawn.height > gpu.maxSize) return drawn;

    gpu.setImage(drawn, { colorMode });
    gpu.render(pipeline);
    this.frames++;
    // Shown in place of the WebGL canvas, with its position, size and opacity.
    const out = this.output_;
    out.className = drawn.className;
    out.style.cssText = drawn.style.cssText;
    return out;
  }

  protected override disposeInternal(): void {
    this.gpu_?.dispose();
    this.gpu_ = null;
    super.disposeInternal();
  }
}
