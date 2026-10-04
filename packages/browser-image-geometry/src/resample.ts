/**
 * The per-pixel work: for each output pixel, find where it comes from in the
 * source (inverse mapping) and interpolate there. Pure functions on typed
 * arrays, shared by the main thread and the workers.
 */
import { pointFunction } from './transform.js';
import type { AffineMatrix, RGBA, Resample, Transform } from './types.js';

/**
 * Where each output pixel comes from. Plain data, so it can be sent to workers.
 *
 * - `transform`: output pixel → target with the affine `output`, then target →
 *   source with `inverse`.
 * - `grid`: source positions precomputed every `step` output pixels and
 *   interpolated bilinearly in between (for coordinate transforms that cannot
 *   be sent to a worker, such as proj4).
 *
 * Source positions are divided by `divisor` (a power of two) when the source
 * was shrunk beforehand.
 */
export type Mapping =
  | { kind: 'transform'; inverse: Transform; output: AffineMatrix; divisor: number }
  | { kind: 'grid'; step: number; columns: number; rows: number; points: Float64Array; divisor: number };

/** A rectangle of the source image, positioned at `(x0, y0)`. Pixels outside it are transparent. */
export interface SourceWindow {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  x0: number;
  y0: number;
}

/** How many pixels around a sample position each method may read. */
export const KERNEL_MARGIN: Readonly<Record<Resample, number>> = { nearest: 1, bilinear: 1, bicubic: 2 };

/** Writes the source positions of output row `y`, pixels `[0, width)`, into `out` as x, y pairs. */
export type RowMapper = (y: number, width: number, out: Float64Array) => void;

export function rowMapper(mapping: Mapping): RowMapper {
  const k = 1 / mapping.divisor;
  if (mapping.kind === 'grid') {
    const { step, columns, rows, points } = mapping;
    return (y, width, out) => {
      const fy = Math.min((y + 0.5) / step, rows - 1);
      const j = Math.max(0, Math.min(Math.floor(fy), rows - 2));
      const ty = fy - j;
      for (let x = 0; x < width; x++) {
        const fx = Math.min((x + 0.5) / step, columns - 1);
        const i = Math.max(0, Math.min(Math.floor(fx), columns - 2));
        const tx = fx - i;
        const p00 = (j * columns + i) * 2;
        const p10 = p00 + 2;
        const p01 = p00 + columns * 2;
        const p11 = p01 + 2;
        for (let c = 0; c < 2; c++) {
          const top = points[p00 + c] + (points[p10 + c] - points[p00 + c]) * tx;
          const bottom = points[p01 + c] + (points[p11 + c] - points[p01 + c]) * tx;
          out[x * 2 + c] = (top + (bottom - top) * ty) * k;
        }
      }
    };
  }
  const [a, b, c, d, e, f] = mapping.output;
  const { inverse } = mapping;
  if (inverse.type === 'affine') {
    // Both steps are affine: fold them into one.
    const [p, q, r, s, t, u] = inverse.matrix;
    const A = (p * a + q * d) * k;
    const B = (p * b + q * e) * k;
    const C = (p * c + q * f + r) * k;
    const D = (s * a + t * d) * k;
    const E = (s * b + t * e) * k;
    const F = (s * c + t * f + u) * k;
    return (y, width, out) => {
      const v = y + 0.5;
      for (let x = 0; x < width; x++) {
        const w = x + 0.5;
        out[x * 2] = A * w + B * v + C;
        out[x * 2 + 1] = D * w + E * v + F;
      }
    };
  }
  const apply = pointFunction(inverse);
  const p = [0, 0];
  return (y, width, out) => {
    const v = y + 0.5;
    for (let x = 0; x < width; x++) {
      const w = x + 0.5;
      apply(a * w + b * v + c, d * w + e * v + f, p);
      out[x * 2] = p[0] * k;
      out[x * 2 + 1] = p[1] * k;
    }
  };
}

/** Keys cubic convolution (a = -0.5, Catmull-Rom). */
function cubic(t: number): number {
  const x = Math.abs(t);
  if (x < 1) return (1.5 * x - 2.5) * x * x + 1;
  if (x < 2) return ((-0.5 * x + 2.5) * x - 4) * x + 2;
  return 0;
}

/**
 * Renders output rows `[y0, y1)` of an image `width` pixels wide into `out`
 * (RGBA, `(y1 - y0) × width`). Interpolation is on premultiplied alpha, so
 * transparent pixels do not darken their neighbours; samples outside the
 * source are transparent and then composited over `background`. With
 * `clampEdges`, taps beyond the window's edge read its edge pixels instead
 * (the window must then end where the source ends wherever samples get near it).
 */
export function renderRows(
  src: SourceWindow,
  mapping: Mapping,
  width: number,
  y0: number,
  y1: number,
  resample: Resample,
  background: RGBA,
  out: Uint8ClampedArray,
  clampEdges = false,
): void {
  const map = rowMapper(mapping);
  const pos = new Float64Array(width * 2);
  const { data, width: sw, height: sh, x0: ox, y0: oy } = src;
  const [bgR, bgG, bgB, bgA255] = background;
  const bgA = bgA255 / 255;
  const wx = new Float64Array(4);
  const wy = new Float64Array(4);
  const taps = resample === 'bicubic' ? 4 : 2;
  const first = resample === 'bicubic' ? -1 : 0;

  for (let y = y0; y < y1; y++) {
    map(y, width, pos);
    let o = (y - y0) * width * 4;
    for (let x = 0; x < width; x++, o += 4) {
      const sx = pos[x * 2] - ox;
      const sy = pos[x * 2 + 1] - oy;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      if (Number.isFinite(sx) && Number.isFinite(sy)) {
        if (resample === 'nearest') {
          let i = Math.floor(sx);
          let j = Math.floor(sy);
          if (clampEdges) {
            i = Math.min(Math.max(i, 0), sw - 1);
            j = Math.min(Math.max(j, 0), sh - 1);
          }
          if (i >= 0 && j >= 0 && i < sw && j < sh) {
            const s = (j * sw + i) * 4;
            a = data[s + 3] / 255;
            r = data[s] * a;
            g = data[s + 1] * a;
            b = data[s + 2] * a;
          }
        } else {
          // Pixel centers sit at half-integers.
          const px = sx - 0.5;
          const py = sy - 0.5;
          const ix = Math.floor(px);
          const iy = Math.floor(py);
          const fx = px - ix;
          const fy = py - iy;
          if (taps === 2 && ix >= 0 && iy >= 0 && ix + 1 < sw && iy + 1 < sh) {
            // Fast path: all four bilinear taps inside the source.
            const s00 = (iy * sw + ix) * 4;
            const s10 = s00 + 4;
            const s01 = s00 + sw * 4;
            const s11 = s01 + 4;
            const w00 = ((1 - fx) * (1 - fy) * data[s00 + 3]) / 255;
            const w10 = (fx * (1 - fy) * data[s10 + 3]) / 255;
            const w01 = ((1 - fx) * fy * data[s01 + 3]) / 255;
            const w11 = (fx * fy * data[s11 + 3]) / 255;
            r = data[s00] * w00 + data[s10] * w10 + data[s01] * w01 + data[s11] * w11;
            g = data[s00 + 1] * w00 + data[s10 + 1] * w10 + data[s01 + 1] * w01 + data[s11 + 1] * w11;
            b = data[s00 + 2] * w00 + data[s10 + 2] * w10 + data[s01 + 2] * w01 + data[s11 + 2] * w11;
            a = w00 + w10 + w01 + w11;
          } else {
            if (taps === 2) {
              wx[0] = 1 - fx;
              wx[1] = fx;
              wy[0] = 1 - fy;
              wy[1] = fy;
            } else {
              for (let t = 0; t < 4; t++) {
                wx[t] = cubic(fx - (t - 1));
                wy[t] = cubic(fy - (t - 1));
              }
            }
            for (let tj = 0; tj < taps; tj++) {
              let j = iy + first + tj;
              if (clampEdges) j = Math.min(Math.max(j, 0), sh - 1);
              if (j < 0 || j >= sh || wy[tj] === 0) continue;
              for (let ti = 0; ti < taps; ti++) {
                let i = ix + first + ti;
                if (clampEdges) i = Math.min(Math.max(i, 0), sw - 1);
                if (i < 0 || i >= sw || wx[ti] === 0) continue;
                const s = (j * sw + i) * 4;
                const w = (wx[ti] * wy[tj] * data[s + 3]) / 255;
                r += data[s] * w;
                g += data[s + 1] * w;
                b += data[s + 2] * w;
                a += w;
              }
            }
          }
        }
      }
      // Premultiplied color r, g, b with alpha `a`. Bicubic's negative lobes can
      // push `a` outside [0, 1]; keep the color's hue and clamp the coverage.
      let alpha = a;
      if (!(alpha > 1e-9)) {
        r = g = b = alpha = 0;
      } else if (alpha > 1) {
        r /= alpha;
        g /= alpha;
        b /= alpha;
        alpha = 1;
      }
      if (bgA > 0) {
        const rest = bgA * (1 - alpha);
        const outA = alpha + rest;
        out[o] = Math.round((r + bgR * rest) / outA);
        out[o + 1] = Math.round((g + bgG * rest) / outA);
        out[o + 2] = Math.round((b + bgB * rest) / outA);
        out[o + 3] = Math.round(outA * 255);
      } else if (alpha > 0) {
        out[o] = Math.round(r / alpha);
        out[o + 1] = Math.round(g / alpha);
        out[o + 2] = Math.round(b / alpha);
        out[o + 3] = Math.round(alpha * 255);
      } else {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      }
    }
  }
}

/**
 * Halves an image (2×2 box filter on premultiplied alpha), for shrinking by
 * more than 2× without aliasing. Odd edges average the pixels that exist.
 */
export function halve(src: { data: Uint8ClampedArray; width: number; height: number }): {
  data: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const w = Math.ceil(src.width / 2);
  const h = Math.ceil(src.height / 2);
  const data = new Uint8ClampedArray(w * h * 4);
  const sw = src.width;
  const s = src.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let dy = 0; dy < 2; dy++) {
        const j = 2 * y + dy;
        if (j >= src.height) continue;
        for (let dx = 0; dx < 2; dx++) {
          const i = 2 * x + dx;
          if (i >= sw) continue;
          const p = (j * sw + i) * 4;
          const al = s[p + 3];
          r += s[p] * al;
          g += s[p + 1] * al;
          b += s[p + 2] * al;
          a += al;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        data[o] = Math.round(r / a);
        data[o + 1] = Math.round(g / a);
        data[o + 2] = Math.round(b / a);
      }
      data[o + 3] = Math.round(a / n);
    }
  }
  return { data, width: w, height: h };
}
