import { ImageInput } from "./workers/src/io.js";
import { ColorMode } from "./types.js";
import { Pipeline, RunOptions, RunResult } from "./pipeline.js";
//#region src/editor.d.ts
/** How an {@link Editor} shows the image: on the GPU (WebGL2) or with the JS engine. */
export type EditorEngine = 'gpu' | 'cpu';
/** Options for {@link createEditor}. */
export interface EditorOptions {
  /**
   * The canvas the corrected image is drawn on. Default: a new canvas
   * ({@link Editor.canvas}), for the caller to put in the page. Its pixel size
   * follows the image shown, so give it a CSS size.
   */
  canvas?: HTMLCanvasElement;
  /**
   * `auto` (default) uses the GPU when the browser has WebGL2 with float
   * render targets, else the JS engine. `gpu` and `cpu` force one; `gpu` still
   * falls back to `cpu` when WebGL2 is missing.
   */
  engine?: 'auto' | EditorEngine;
  /** Default `auto`. */
  colorMode?: ColorMode;
  /** JS engine: run in Web Workers (default true). */
  worker?: boolean;
  /**
   * JS engine: longest side, in pixels, of the preview drawn while the
   * pipeline keeps changing. Default 1280. The GPU always shows the full size
   * (shrunk only to what the GPU accepts).
   */
  previewSize?: number;
  /**
   * JS engine: once `render` has not been called for this many milliseconds,
   * the full-size image replaces the preview. Default 250. A negative value
   * keeps the preview.
   */
  settleDelay?: number;
  /** Called after each image drawn on the canvas. */
  onRender?: (info: EditorRenderInfo) => void;
}
/** What an {@link Editor} just drew. */
export interface EditorRenderInfo {
  /** The engine that drew it. */
  engine: EditorEngine;
  /** Width of the image drawn, in pixels. */
  width: number;
  /** Height of the image drawn, in pixels. */
  height: number;
  /** True when it is smaller than the image (a preview); the full-size result is still to come or not needed. */
  preview: boolean;
  /** Time from the `render` call to the draw, in milliseconds. */
  ms: number;
}
/** Created by {@link createEditor}. */
export interface Editor {
  /**
   * The canvas the image is drawn on. If the GPU is lost (the browser drops
   * the WebGL context), the editor switches to the JS engine on a new canvas,
   * which takes the old one's place in the page, class and style.
   */
  readonly canvas: HTMLCanvasElement;
  /** The engine in use now. */
  readonly engine: EditorEngine;
  /** The decoded image (sRGB, full size), or null before `setImage`. */
  readonly image: ImageData | null;
  /**
   * Decodes `input` (any {@link ImageInput}; a Blob is read with its EXIF
   * orientation) and makes it the image to correct. The last pipeline
   * rendered, if any, is drawn again on it.
   */
  setImage(input: ImageInput): Promise<void>;
  /**
   * Shows the image corrected by `p`. Call it on every slider move: calls are
   * coalesced, and only the latest pipeline is drawn. Resolves with true once
   * `p` is on the canvas, or false when a newer call superseded it.
   *
   * `autoStretch` takes its statistics from the full-size image, so the
   * preview has the same range as the final result.
   */
  render(p: Pipeline): Promise<boolean>;
  /**
   * The full-size result of `p` from the exact JS engine (in workers by
   * default), in the output type `options.output` asks for, as
   * {@link Pipeline.run} gives it.
   */
  export<O extends RunOptions | undefined = undefined>(p: Pipeline, options?: O): Promise<RunResult<O>>;
  /** Stops pending work and frees the GPU memory. The editor cannot be used afterwards. */
  dispose(): void;
}
/**
 * Creates an editor that shows corrections as fast as the browser allows.
 *
 * @example
 * ```ts
 * const editor = createEditor({ canvas: document.querySelector('canvas')! });
 * await editor.setImage(file);
 * slider.oninput = () => editor.render(pipeline().exposure(Number(slider.value)));
 * save.onclick = async () => download(await editor.export(current(), { output: 'blob' }));
 * ```
 */
export declare function createEditor(options?: EditorOptions): Editor;
//#endregion
//# sourceMappingURL=editor.d.ts.map