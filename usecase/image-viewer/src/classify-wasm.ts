/**
 * The classification's per-pixel loop in WebAssembly (wasm/classify.c, SIMD,
 * four pixels at a time): pixels in classes by minimum distance or maximum
 * likelihood, their colors and the pixels per class. It computes in float32
 * where classify.ts uses float64, so a pixel almost exactly between two
 * classes may go either way. Null where WebAssembly cannot run (then
 * classify.ts does the work).
 */
import type { ClassModel } from './classify.js';
import { CLASSIFY_WASM_BASE64 } from './classify-wasm-bytes.js';

interface Exports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  classify_distance(bands: number, n: number, dims: number, means: number, k: number, out: number, counts: number): void;
  classify_ml(bands: number, n: number, dims: number, means: number, inverses: number, constants: number, k: number, out: number, counts: number): void;
  color_classes(classes: number, n: number, palette: number, rgba: number): void;
}

/** Most bands the kernel takes (MAX_DIMS in classify.c). */
export const WASM_MAX_DIMS = 32;

let exports: Exports | null | undefined;

/** The compiled kernel (compiled once, synchronously: this runs in workers and Node). */
function kernel(): Exports | null {
  if (exports !== undefined) return exports;
  try {
    const bytes = Uint8Array.from(atob(CLASSIFY_WASM_BASE64), (c) => c.charCodeAt(0));
    exports = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports as unknown as Exports;
  } catch {
    exports = null;
  }
  return exports;
}

/** Whether the WebAssembly kernel can run here. */
export function wasmAvailable(): boolean {
  return kernel() !== null;
}

export interface ClassifiedBlock {
  /** 1-based classes, 0 where a band has no value. */
  classes: Uint8Array;
  /** RGBA, transparent where there is no class. */
  rgba: Uint8Array;
  /** Pixels per class (index: class - 1). */
  counts: Float64Array;
}

/** Classifies `n` pixels of planar `bands` with `model`, colored by `colors`; null when WebAssembly cannot run or the model has too many bands. */
export function classifyWasm(bands: readonly Float32Array[], n: number, model: ClassModel, colors: ReadonlyArray<readonly [number, number, number]>): ClassifiedBlock | null {
  const k = kernel();
  const dims = model.dims;
  if (!k || dims > WASM_MAX_DIMS || bands.length !== dims) return null;
  const classes = model.means.length / dims;
  // Memory: bands, model, palette, classes, counts, colors; each 16-byte aligned.
  let at = (k.__heap_base.value as number + 15) & ~15;
  const take = (bytes: number) => {
    const p = at;
    at = (at + bytes + 15) & ~15;
    return p;
  };
  const pBands = take(4 * n * dims);
  const pMeans = take(4 * model.means.length);
  const pInv = take(4 * (model.inverses?.length ?? 0));
  const pConst = take(4 * (model.constants?.length ?? 0));
  const pPalette = take(3 * classes);
  const pOut = take(n);
  const pCounts = take(4 * (classes + 1));
  const pRgba = take(4 * n);
  const need = at - k.memory.buffer.byteLength;
  if (need > 0) k.memory.grow(Math.ceil(need / 65536));
  const buffer = k.memory.buffer;
  const f32 = new Float32Array(buffer);
  bands.forEach((band, d) => f32.set(band.subarray(0, n), pBands / 4 + d * n));
  f32.set(model.means, pMeans / 4);
  if (model.inverses) f32.set(model.inverses, pInv / 4);
  if (model.constants) f32.set(model.constants, pConst / 4);
  const u8 = new Uint8Array(buffer);
  colors.forEach((c, i) => u8.set(c, pPalette + 3 * i));
  new Uint32Array(buffer, pCounts, classes + 1).fill(0);
  if (model.kind === 'likelihood') k.classify_ml(pBands, n, dims, pMeans, pInv, pConst, classes, pOut, pCounts);
  else k.classify_distance(pBands, n, dims, pMeans, classes, pOut, pCounts);
  k.color_classes(pOut, n, pPalette, pRgba);
  return {
    classes: u8.slice(pOut, pOut + n),
    rgba: u8.slice(pRgba, pRgba + 4 * n),
    counts: Float64Array.from(new Uint32Array(buffer, pCounts + 4, classes)),
  };
}
