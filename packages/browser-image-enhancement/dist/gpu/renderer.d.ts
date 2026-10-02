import { ImageDataLike } from "../workers/src/image.js";
import { ColorOptions, OpSpec } from "../types.js";
//#region src/gpu/renderer.d.ts
/** Options for {@link createGpuRenderer}. */
export interface GpuRendererOptions {
  /**
   * Canvas to draw results on; it is resized to the image. Default: a new
   * `OffscreenCanvas` (or `<canvas>` where there is none).
   */
  canvas?: HTMLCanvasElement | OffscreenCanvas;
}
/** Corrections on the GPU, created by {@link createGpuRenderer}. */
export interface GpuRenderer {
  /** The canvas results are drawn on. */
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  /** Largest width or height this GPU accepts. */
  readonly maxSize: number;
  /**
   * Uploads the image to correct. Call once per image; `render` can then run
   * any number of times. Throws a RangeError for an image wider or taller
   * than {@link GpuRenderer.maxSize}.
   */
  setImage(image: ImageDataLike, options?: ColorOptions): void;
  /**
   * Corrects the image with the steps of `steps` (a `Pipeline` or an array of
   * steps) and draws the result on {@link GpuRenderer.canvas}. `autoStretch`
   * takes its statistics from the image passed to `setImage`.
   */
  render(steps: {
    readonly ops: readonly OpSpec[];
  } | readonly OpSpec[]): void;
  /** The last rendered result as pixels (a GPU-to-memory copy, so slower than `render`). */
  read(): ImageData;
  /** Frees the GPU memory. The renderer cannot be used afterwards. */
  dispose(): void;
}
/**
 * Creates a WebGL2 renderer, or returns `null` when the browser cannot run
 * one (no WebGL2, or no rendering to float textures), so callers can fall
 * back to the pipeline's `run`.
 *
 * @example
 * ```ts
 * const gpu = createGpuRenderer({ canvas: view });
 * if (gpu) {
 *   gpu.setImage(img);
 *   slider.oninput = () => gpu.render(current()); // full size, every move
 * }
 * ```
 */
export declare function createGpuRenderer(options?: GpuRendererOptions): GpuRenderer | null;
//#endregion
//# sourceMappingURL=renderer.d.ts.map