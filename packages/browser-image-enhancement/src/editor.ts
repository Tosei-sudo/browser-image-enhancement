/**
 * An editor for slider-driven corrections: it picks the fastest way to show
 * the image (WebGL2 at full size, or a shrunk preview in workers) and keeps the
 * exact JS engine for the final result, so callers need not combine
 * `createGpuRenderer`, `createPreviewRunner` and `run` themselves.
 */
import { createGpuRenderer, type GpuRenderer } from './gpu/renderer.js';
import { toImageData, type ImageInput } from './io.js';
import { createPreviewRunner, type Pipeline, type PreviewRunner, type RunOptions, type RunResult } from './pipeline.js';
import { downscale } from './preview.js';
import { histogram } from './stats.js';
import { createImageData } from './core/image.js';
import type { ColorMode, Histogram, ImageDataLike } from './types.js';

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
export function createEditor(options: EditorOptions = {}): Editor {
  return new EditorImpl(options);
}

const DEFAULT_PREVIEW_SIZE = 1280;
const DEFAULT_SETTLE_DELAY = 250;

class EditorImpl implements Editor {
  canvas: HTMLCanvasElement;
  engine: EditorEngine;
  image: ImageData | null = null;
  private gpu: GpuRenderer | null = null;
  /** Scale of the image uploaded to the GPU (1 unless the GPU limits its size). */
  private gpuScale = 1;
  private stats: Histogram | null = null;
  private last: Pipeline | null = null;
  private generation = 0;
  private frame = 0;
  private pendingFrame: { p: Pipeline; t0: number; done: (drawn: boolean) => void } | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly preview: PreviewRunner<RunOptions>;
  private readonly full: PreviewRunner<RunOptions>;
  private disposed = false;

  constructor(private readonly options: EditorOptions) {
    this.canvas = options.canvas ?? document.createElement('canvas');
    const runOptions: RunOptions = { colorMode: options.colorMode, worker: options.worker };
    this.preview = createPreviewRunner({ ...runOptions, maxSize: options.previewSize ?? DEFAULT_PREVIEW_SIZE });
    this.full = createPreviewRunner(runOptions);
    this.engine = 'cpu';
    if (options.engine !== 'cpu') {
      this.gpu = createGpuRenderer({ canvas: this.canvas });
      if (this.gpu) {
        this.engine = 'gpu';
        this.canvas.addEventListener('webglcontextlost', this.onContextLost);
      }
    }
  }

  async setImage(input: ImageInput): Promise<void> {
    this.check();
    const decoded = await toImageData(input);
    this.check();
    this.image = decoded instanceof ImageData ? decoded : createImageData(decoded.data, decoded.width, decoded.height);
    this.stats = null;
    this.uploadToGpu();
    if (this.last) void this.render(this.last);
  }

  render(p: Pipeline): Promise<boolean> {
    this.check();
    if (!this.image) return Promise.reject(new Error('Call setImage before render.'));
    this.last = p;
    const mine = ++this.generation;
    clearTimeout(this.settleTimer);
    const t0 = performance.now();
    if (this.engine === 'gpu') return this.renderGpu(p, t0);
    return this.renderCpu(p, mine, t0);
  }

  export<O extends RunOptions | undefined = undefined>(p: Pipeline, options?: O): Promise<RunResult<O>> {
    this.check();
    if (!this.image) return Promise.reject(new Error('Call setImage before export.'));
    const opts = { colorMode: this.options.colorMode, worker: this.options.worker, ...options } as O;
    return p.run(this.image, opts);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    clearTimeout(this.settleTimer);
    cancelAnimationFrame(this.frame);
    this.pendingFrame?.done(false);
    this.pendingFrame = null;
    this.preview.cancel();
    this.full.cancel();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.gpu?.dispose();
    this.gpu = null;
    this.image = null;
  }

  /** `p` with `autoStretch` fixed from the full-size image, so every preview size gets the same range. */
  private resolved(p: Pipeline): Pipeline {
    if (!p.needsStats) return p;
    this.stats ??= histogram(this.image as ImageData, { colorMode: this.options.colorMode });
    return p.resolve(this.stats);
  }

  private uploadToGpu(): void {
    if (!this.gpu || !this.image) return;
    const { image, scale } = downscale(this.image, this.gpu.maxSize);
    this.gpuScale = scale;
    this.gpu.setImage(image, { colorMode: this.options.colorMode });
  }

  /** Draws on the next animation frame; a newer call before it replaces `p`. */
  private renderGpu(p: Pipeline, t0: number): Promise<boolean> {
    return new Promise((resolve) => {
      this.pendingFrame?.done(false);
      this.pendingFrame = { p, t0, done: resolve };
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        const job = this.pendingFrame;
        this.pendingFrame = null;
        if (!job || this.disposed) return job?.done(false);
        const gpu = this.gpu;
        if (!gpu) {
          // The GPU was lost after this call: draw it with the JS engine instead.
          void this.renderCpu(job.p, this.generation, job.t0).then(job.done);
          return;
        }
        gpu.render(this.resolved(job.p).scaled(this.gpuScale));
        this.notify('gpu', gpu.canvas.width, gpu.canvas.height, job.t0);
        job.done(true);
      });
    });
  }

  private async renderCpu(p: Pipeline, mine: number, t0: number): Promise<boolean> {
    this.full.cancel();
    const image = this.image as ImageData;
    const resolved = this.resolved(p);
    const result = await this.preview.run(resolved, image);
    if (!result || mine !== this.generation) return false;
    this.draw(result);
    const preview = result.width < image.width;
    this.notify('cpu', result.width, result.height, t0, preview);
    const delay = this.options.settleDelay ?? DEFAULT_SETTLE_DELAY;
    if (preview && delay >= 0) {
      this.settleTimer = setTimeout(() => {
        const start = performance.now();
        void this.full.run(resolved, image).then((full) => {
          if (!full || mine !== this.generation) return;
          this.draw(full);
          this.notify('cpu', full.width, full.height, start, false);
        }, () => {}); // a failed full-size draw leaves the preview on screen
      }, delay);
    }
    return true;
  }

  private draw(image: ImageDataLike): void {
    const c = this.canvas;
    if (c.width !== image.width) c.width = image.width;
    if (c.height !== image.height) c.height = image.height;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('The editor canvas has no 2D context.');
    ctx.putImageData(image instanceof ImageData ? image : createImageData(image.data, image.width, image.height), 0, 0);
  }

  private notify(engine: EditorEngine, width: number, height: number, t0: number, preview = width < (this.image?.width ?? width)): void {
    this.options.onRender?.({ engine, width, height, preview, ms: performance.now() - t0 });
  }

  private readonly onContextLost = (): void => {
    // A canvas that had a WebGL context cannot get a 2D one: continue on a new canvas in its place.
    const old = this.canvas;
    old.removeEventListener('webglcontextlost', this.onContextLost);
    const next = document.createElement('canvas');
    next.className = old.className;
    next.style.cssText = old.style.cssText;
    old.replaceWith(next);
    this.canvas = next;
    this.gpu = null;
    this.engine = 'cpu';
    if (this.last && this.image) void this.render(this.last);
  };

  private check(): void {
    if (this.disposed) throw new Error('The editor was disposed.');
  }
}
