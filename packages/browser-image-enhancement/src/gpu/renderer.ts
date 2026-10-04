/**
 * WebGL2 renderer: the same corrections as the JS engine, computed on the GPU
 * at full resolution, fast enough to follow a slider. The image is uploaded
 * once; each `render` runs a few fullscreen passes and draws the result to a
 * canvas, without reading pixels back unless asked.
 *
 * Results match the JS engine to within one 8-bit level (float32 on the GPU
 * instead of float64). Use the pipeline's `run` for the final, exact output.
 */
import { assertImageData, createImageData } from '../core/image.js';
import { countPixels, needsStats, resolveOps } from '../core/histogram.js';
import { forGray, resolveMode, type ResolvedMode } from '../core/process.js';
import { warnColorOnly } from '../functional.js';
import { COLOR_ONLY_OPS, isIdentity, kernelRadius, normalizeOp } from '../ops/index.js';
import type { ColorOptions, Histogram, ImageDataLike, OpSpec, SharpenOptions } from '../types.js';
import { CURVE_SAMPLES, curveRow, DECODE, horizontalShader, opParams, pixelShader, PRESENT, verticalShader, VERTEX, type PixelOp } from './shaders.js';

/** Options for {@link createGpuRenderer}. */
export interface GpuRendererOptions {
  /**
   * Canvas to draw results on; it is resized to the image. Default: a new
   * `OffscreenCanvas` (or `<canvas>` where there is none).
   */
  canvas?: HTMLCanvasElement | OffscreenCanvas;
}

/**
 * Pictures the GPU can read directly, without copying pixels through memory:
 * another canvas (2D or WebGL), an `ImageBitmap`, a loaded `<img>`, or a
 * `<video>` frame.
 */
export type GpuImageSource = HTMLCanvasElement | OffscreenCanvas | ImageBitmap | HTMLImageElement | HTMLVideoElement;

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
   *
   * `image` can also be a {@link GpuImageSource} such as another canvas,
   * copied on the GPU, which is much faster for a picture that is already
   * there (a map drawn with WebGL, a video). Its pixels are not read back, so
   * `colorMode: 'auto'` means `rgb` and `autoStretch` cannot take statistics
   * from it: resolve it first (`pipeline.resolve(stats)`).
   */
  setImage(image: ImageDataLike | GpuImageSource, options?: ColorOptions): void;
  /**
   * Corrects the image with the steps of `steps` (a `Pipeline` or an array of
   * steps) and draws the result on {@link GpuRenderer.canvas}. `autoStretch`
   * takes its statistics from the image passed to `setImage`.
   */
  render(steps: { readonly ops: readonly OpSpec[] } | readonly OpSpec[]): void;
  /** The last rendered result as pixels (a GPU-to-memory copy, so slower than `render`). */
  read(): ImageData;
  /** Frees the GPU memory. The renderer cannot be used afterwards. */
  dispose(): void;
}

type Canvas = HTMLCanvasElement | OffscreenCanvas;

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
export function createGpuRenderer(options: GpuRendererOptions = {}): GpuRenderer | null {
  const canvas = options.canvas ?? newCanvas();
  if (!canvas) return null;
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    antialias: false,
    depth: false,
    stencil: false,
  }) as WebGL2RenderingContext | null;
  if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
  return new Renderer(gl, canvas);
}

function sourceSize(source: GpuImageSource): [number, number] {
  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) return [source.naturalWidth, source.naturalHeight];
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) return [source.videoWidth, source.videoHeight];
  return [source.width, source.height];
}

function newCanvas(): Canvas | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1);
  if (typeof document !== 'undefined') return document.createElement('canvas');
  return null;
}

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

interface Image {
  /** Null for a picture the GPU read directly. */
  data: Uint8ClampedArray | null;
  width: number;
  height: number;
  mode: ResolvedMode;
  stats: Histogram | null;
}

type TargetName = 'encoded0' | 'encoded1' | 'blur' | 'result';
const ENCODED = ['encoded0', 'encoded1'] as const;

type Step = { kind: 'pixel'; op: PixelOp } | { kind: 'sharpen'; op: Required<SharpenOptions> };

class Renderer implements GpuRenderer {
  readonly maxSize: number;
  private readonly programs = new Map<string, WebGLProgram>();
  private readonly vertex: WebGLShader;
  private readonly lut: WebGLTexture;
  private readonly kernel: WebGLTexture;
  /** Samples of the curves of the `curve` steps being rendered, one row each. */
  private readonly curves: WebGLTexture;
  /** Row of {@link Renderer.curves} of each `curve` step being rendered. */
  private curveRows = new Map<PixelOp, number>();
  private source: WebGLTexture | null = null;
  /** Whether `source` holds a {@link GpuImageSource} (and can be overwritten in place). */
  private sourceFromPicture = false;
  private image: Image | null = null;
  /**
   * Render targets, allocated when first needed: encoded values between
   * sharpens (RGBA32F, two for ping-pong), the horizontal blur (RG32F) and the
   * result (RGBA8). At 12 MP the float ones take about 100-200 MB each.
   */
  private targets = new Map<TargetName, Target>();
  private params = new Float32Array(8);
  private readonly vao: WebGLVertexArrayObject | null;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly canvas: Canvas,
  ) {
    this.maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, ...(gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array));
    this.vertex = this.shader(gl.VERTEX_SHADER, VERTEX);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    this.lut = this.texture(gl.R32F, 256, 1, gl.RED, gl.FLOAT, DECODE);
    this.kernel = this.texture(gl.R32F, 1, 1, gl.RED, gl.FLOAT, new Float32Array(1));
    this.curves = this.texture(gl.RGBA32F, 1, 1, gl.RGBA, gl.FLOAT, new Float32Array(4));
  }

  setImage(image: ImageDataLike | GpuImageSource, options: ColorOptions = {}): void {
    const pixels = 'data' in image ? image : null;
    if (pixels) assertImageData(pixels);
    const [width, height] = pixels ? [pixels.width, pixels.height] : sourceSize(image as GpuImageSource);
    if (width > this.maxSize || height > this.maxSize) {
      throw new RangeError(`${width}x${height} is larger than this GPU accepts (${this.maxSize} pixels per side).`);
    }
    const gl = this.gl;
    const sameSize = this.image?.width === width && this.image.height === height;
    const mode: ResolvedMode = pixels ? resolveMode(pixels.data, options.colorMode) : options.colorMode === 'gray' ? 'gray' : 'rgb';
    this.image = { data: pixels?.data ?? null, width, height, mode, stats: null };
    if (pixels) {
      if (this.source) gl.deleteTexture(this.source);
      const bytes = new Uint8Array(pixels.data.buffer, pixels.data.byteOffset, pixels.data.byteLength);
      this.source = this.texture(gl.RGBA8UI, width, height, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, bytes);
    } else if (this.source && sameSize && this.sourceFromPicture) {
      // Same size as the last picture (a canvas redrawn every frame): reuse the texture.
      gl.bindTexture(gl.TEXTURE_2D, this.source);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, image as GpuImageSource);
    } else {
      if (this.source) gl.deleteTexture(this.source);
      this.source = this.texture(gl.RGBA8UI, width, height, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, null);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, image as GpuImageSource);
    }
    this.sourceFromPicture = !pixels;
    if (!sameSize) {
      this.freeTargets();
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  render(steps: { readonly ops: readonly OpSpec[] } | readonly OpSpec[]): void {
    const image = this.image;
    if (!image || !this.source) throw new Error('Call setImage before render.');
    const gl = this.gl;
    const gray = image.mode === 'gray';
    let ops = ('ops' in steps ? steps.ops : (steps as readonly OpSpec[])).map(normalizeOp);
    if (needsStats(ops)) {
      if (!image.data) throw new TypeError('autoStretch needs the pixels of the image; resolve it before rendering a picture the GPU reads directly.');
      image.stats ??= countPixels(image.data, image.width, image.mode);
      ops = resolveOps(ops, image.stats);
    }
    if (gray) warnColorOnly(ops);
    const plan: Step[] = ops
      .filter((op) => !isIdentity(op) && !(gray && COLOR_ONLY_OPS.has(op.op)))
      .map((op) => (gray ? forGray(op) : op))
      .map((op) => (op.op === 'sharpen' ? { kind: 'sharpen', op } : { kind: 'pixel', op: op as PixelOp }));

    this.setCurves(plan);
    gl.viewport(0, 0, image.width, image.height);
    const firstSharpen = plan.findIndex((s) => s.kind === 'sharpen');
    const head = pixelOps(plan, 0);
    let input = 0;
    this.pass(pixelShader(head, gray, firstSharpen < 0), this.use(firstSharpen < 0 ? 'result' : 'encoded0'), [['u_src', this.source], ['u_lut', this.lut]], head);
    for (let i = firstSharpen; i >= 0 && i < plan.length; ) {
      const { amount, radius, threshold } = (plan[i] as Extract<Step, { kind: 'sharpen' }>).op;
      const after = pixelOps(plan, i + 1);
      const next = plan.findIndex((s, j) => j > i && s.kind === 'sharpen');
      const r = this.setKernel(radius);
      const src = this.use(ENCODED[input]).texture;
      const blur = this.use('blur');
      this.pass(horizontalShader(gray), blur, [['u_src', src], ['u_kernel', this.kernel]], [], { u_r: r });
      const out = this.use(next < 0 ? 'result' : ENCODED[1 - input]);
      this.pass(verticalShader(after, gray, next < 0), out, [['u_src', src], ['u_blur', blur.texture], ['u_kernel', this.kernel]], after, {
        u_r: r,
        u_amount: amount,
        u_threshold: threshold,
      });
      input = 1 - input;
      i = next;
    }
    // Draw the result on the canvas.
    this.pass(PRESENT, null, [['u_src', this.use('result').texture]], []);
  }

  read(): ImageData {
    const image = this.image;
    const result = this.targets.get('result');
    if (!image || !result) throw new Error('Call render before read.');
    const gl = this.gl;
    const out = new Uint8ClampedArray(image.width * image.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, result.framebuffer);
    gl.readPixels(0, 0, image.width, image.height, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(out.buffer));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return createImageData(out, image.width, image.height);
  }

  dispose(): void {
    const gl = this.gl;
    this.freeTargets();
    if (this.source) gl.deleteTexture(this.source);
    gl.deleteTexture(this.lut);
    gl.deleteTexture(this.kernel);
    gl.deleteTexture(this.curves);
    for (const p of this.programs.values()) gl.deleteProgram(p);
    this.programs.clear();
    gl.deleteShader(this.vertex);
    gl.deleteVertexArray(this.vao);
    this.source = null;
    this.image = null;
  }

  /** Uploads the curves of the plan's `curve` steps, one row each. */
  private setCurves(plan: readonly Step[]): void {
    const curves = plan.flatMap((s) => (s.kind === 'pixel' && s.op.op === 'curve' ? [s.op] : []));
    this.curveRows = new Map(curves.map((op, row) => [op, row]));
    if (curves.length === 0) return;
    const data = new Float32Array(CURVE_SAMPLES * 4 * curves.length);
    curves.forEach((op, row) => curveRow(op as Extract<PixelOp, { op: 'curve' }>, data, row));
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.curves);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, CURVE_SAMPLES, curves.length, 0, gl.RGBA, gl.FLOAT, data);
  }

  /** Uploads the Gaussian weights for offsets -r..r (as in core/filter.ts) and returns r. */
  private setKernel(radius: number): number {
    const gl = this.gl;
    const r = kernelRadius(radius);
    const k = new Float32Array(2 * r + 1);
    const s = 2 * radius * radius;
    for (let i = -r; i <= r; i++) k[i + r] = Math.exp(-(i * i) / s);
    gl.bindTexture(gl.TEXTURE_2D, this.kernel);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, k.length, 1, 0, gl.RED, gl.FLOAT, k);
    return r;
  }

  /** Runs one fullscreen pass of `fragment` into `target` (null: the canvas). */
  private pass(
    fragment: string,
    target: Target | null,
    textures: ReadonlyArray<[string, WebGLTexture]>,
    ops: readonly PixelOp[],
    scalars: Record<string, number> = {},
  ): void {
    const gl = this.gl;
    const program = this.program(fragment);
    gl.useProgram(program);
    if (ops.some((op) => op.op === 'curve')) textures = [...textures, ['u_curves', this.curves]];
    textures.forEach(([name, texture], unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(gl.getUniformLocation(program, name), unit);
    });
    if (ops.length > 0) {
      if (this.params.length < 8 * ops.length) this.params = new Float32Array(8 * ops.length);
      ops.forEach((op, i) => opParams(op, this.params, i, this.curveRows.get(op)));
      gl.uniform4fv(gl.getUniformLocation(program, 'u_op'), this.params, 0, 8 * ops.length);
    }
    for (const [name, value] of Object.entries(scalars)) {
      const at = gl.getUniformLocation(program, name);
      if (name === 'u_r') gl.uniform1i(at, value);
      else gl.uniform1f(at, value);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private program(fragment: string): WebGLProgram {
    let p = this.programs.get(fragment);
    if (p) return p;
    const gl = this.gl;
    p = gl.createProgram();
    const f = this.shader(gl.FRAGMENT_SHADER, fragment);
    gl.attachShader(p, this.vertex);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    gl.deleteShader(f);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`WebGL program failed to link: ${gl.getProgramInfoLog(p) ?? ''}`);
    this.programs.set(fragment, p);
    return p;
  }

  private shader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const s = gl.createShader(type) as WebGLShader;
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`WebGL shader failed to compile: ${gl.getShaderInfoLog(s) ?? ''}`);
    return s;
  }

  private texture(internal: number, width: number, height: number, format: number, type: number, data: ArrayBufferView | null): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, data);
    return t;
  }

  private target(internal: number, width: number, height: number, format: number, type: number): Target {
    const gl = this.gl;
    const texture = this.texture(internal, width, height, format, type, null);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`WebGL framebuffer is incomplete (0x${status.toString(16)}).`);
    return { texture, framebuffer };
  }

  private use(name: TargetName): Target {
    let t = this.targets.get(name);
    if (t) return t;
    const gl = this.gl;
    const { width, height } = this.image as Image;
    if (name === 'result') t = this.target(gl.RGBA8, width, height, gl.RGBA, gl.UNSIGNED_BYTE);
    else if (name === 'blur') t = this.target(gl.RG32F, width, height, gl.RG, gl.FLOAT);
    else t = this.target(gl.RGBA32F, width, height, gl.RGBA, gl.FLOAT);
    this.targets.set(name, t);
    return t;
  }

  private freeTargets(): void {
    for (const { texture, framebuffer } of this.targets.values()) {
      this.gl.deleteTexture(texture);
      this.gl.deleteFramebuffer(framebuffer);
    }
    this.targets.clear();
  }
}

/** The per-pixel ops from `plan[from]` up to the next sharpen. */
function pixelOps(plan: readonly Step[], from: number): PixelOp[] {
  const out: PixelOp[] = [];
  for (let i = from; i < plan.length && plan[i].kind === 'pixel'; i++) out.push(plan[i].op as PixelOp);
  return out;
}
