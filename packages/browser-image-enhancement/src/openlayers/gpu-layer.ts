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
 *
 * Over a source of ordinary pictures (`ol/source/ImageTile`: WMS, WMTS, XYZ
 * tiles, loaded with `crossOrigin` so WebGL may read them), the layer takes
 * its pipeline from a {@link TileCorrection} given as `correction`, and DRA
 * takes its statistics from the map the layer has drawn.
 */
import WebGLTileLayer, { type Options } from 'ol/layer/WebGLTile.js';
import type { FrameState } from 'ol/Map.js';
import { listen, unlistenByKey, type EventsKey } from 'ol/events.js';
import { getIntersection, isEmpty } from 'ol/extent.js';
import { createGpuRenderer, histogram, type GpuRenderer } from '../index.js';
import { warn } from '../warn.js';
import EnhancedGeoTIFF from './enhanced-geotiff.js';
import TileCorrection from './tile-correction.js';

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
  private readonly output_ = document.createElement('canvas');
  private gpu_: GpuRenderer | null;
  private readonly correction_: TileCorrection | null;
  private readonly correctionKey_: EventsKey | null;
  private readonly useGpu_: boolean;
  private disposed_ = false;
  /** Small canvas the drawn map is read through for DRA statistics. */
  private sample_: CanvasRenderingContext2D | null = null;
  /** Frames corrected so far. */
  frames = 0;

  constructor(options: GpuCorrectedTileLayerOptions = {}) {
    // A class name of its own gives the layer its own WebGL canvas: OpenLayers
    // otherwise shares one canvas between neighbouring WebGL layers.
    const { correction, ...layerOptions } = options;
    super({ className: 'ol-layer gpu-corrected', ...layerOptions });
    this.correction_ = correction ?? null;
    this.correctionKey_ = correction ? listen(correction, 'change', () => this.changed()) : null;
    this.useGpu_ = options.gpu !== false;
    this.gpu_ = this.useGpu_ ? createGpuRenderer({ canvas: this.output_ }) : null;
    // The browser drops WebGL contexts when the GPU resets or too many pages use
    // it. Until the context is back the map shows the tiles as read; then the
    // renderer is built again (its textures and programs died with the old
    // context) and the next frame is corrected as before.
    this.output_.addEventListener('webglcontextlost', (event) => {
      event.preventDefault(); // asks the browser to restore the context
      if (!this.gpu_) return;
      this.gpu_ = null;
      warn('GpuCorrectedTileLayer: the WebGL context was lost; showing the tiles uncorrected until it is restored.');
      this.changed();
    });
    this.output_.addEventListener('webglcontextrestored', () => {
      if (this.disposed_ || !this.useGpu_ || this.gpu_) return;
      this.gpu_ = createGpuRenderer({ canvas: this.output_ });
      this.changed();
    });
  }

  /** Whether the layer can correct on the GPU (WebGL2 is available and the context is not lost right now). */
  hasGpu(): boolean {
    return this.gpu_ !== null;
  }

  /** The `correction` given in the options, or null. */
  getCorrection(): TileCorrection | null {
    return this.correction_;
  }

  /** The canvas the corrected map is shown on (for reading pixels in tests). */
  getOutputCanvas(): HTMLCanvasElement {
    return this.output_;
  }

  override render(frameState: FrameState | null, target: HTMLElement): HTMLElement {
    const drawn = super.render(frameState, target);
    const source = this.getSource();
    const gpu = this.gpu_;
    if (!(drawn instanceof HTMLCanvasElement) || !gpu || !frameState) return drawn;
    const correcting = source instanceof EnhancedGeoTIFF ? (source.correctsTiles() ? null : source) : this.correction_;
    if (!correcting) return drawn;
    if (correcting instanceof TileCorrection && correcting.wantsStats()) this.sampleStats_(drawn, correcting, frameState);
    const pipeline = correcting.getEffectivePipeline();
    const colorMode = correcting.getColorMode();
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

  /** DRA statistics of the map as drawn (before correction), read through a canvas of at most 512 px. */
  private sampleStats_(drawn: HTMLCanvasElement, target: TileCorrection, frameState: FrameState): void {
    const scale = Math.min(1, 512 / Math.max(drawn.width, drawn.height));
    const width = Math.max(1, Math.round(drawn.width * scale));
    const height = Math.max(1, Math.round(drawn.height * scale));
    if (!this.sample_) this.sample_ = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const ctx = this.sample_;
    if (!ctx) return;
    ctx.canvas.width = width;
    ctx.canvas.height = height;
    ctx.drawImage(drawn, 0, 0, width, height);
    const stats = histogram(ctx.getImageData(0, 0, width, height), { colorMode: 'rgb' });
    const pixels = stats.count;
    if (pixels === 0) return; // nothing drawn yet: keep asking
    const extent = this.getExtent();
    const visible = frameState.extent ?? [0, 0, 0, 0];
    const area = extent ? getIntersection(visible, extent) : visible;
    target.setStats(stats, { extent: isEmpty(area) ? visible : area, z: frameState.viewState.zoom, tiles: 0, pixels });
  }

  protected override disposeInternal(): void {
    this.disposed_ = true;
    if (this.correctionKey_) unlistenByKey(this.correctionKey_);
    this.gpu_?.dispose();
    this.gpu_ = null;
    super.disposeInternal();
  }
}
