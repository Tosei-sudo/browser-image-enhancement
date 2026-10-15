/**
 * Automatic alignment of one image to another: how far the image to align is
 * off the reference, found by phase correlation (the peak of the normalized
 * cross-power spectrum, which matches texture whatever the brightness of the
 * two), first over the whole overlap at a coarse scale, then in patches at
 * the reference's own resolution. The patches give tie points, from which a
 * shift (their median) or an affine transformation (least squares, outliers
 * dropped) is fitted.
 */

/** In-place radix-2 FFT of `re` + i`im` (length a power of 2); `inverse` divides by the length. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** 2-D FFT of an `n` × `n` grid, rows then columns. */
function fft2(re: Float64Array, im: Float64Array, n: number, inverse = false): void {
  const rowRe = new Float64Array(n);
  const rowIm = new Float64Array(n);
  for (let y = 0; y < n; y++) {
    rowRe.set(re.subarray(y * n, y * n + n));
    rowIm.set(im.subarray(y * n, y * n + n));
    fft(rowRe, rowIm, inverse);
    re.set(rowRe, y * n);
    im.set(rowIm, y * n);
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      rowRe[y] = re[y * n + x];
      rowIm[y] = im[y * n + x];
    }
    fft(rowRe, rowIm, inverse);
    for (let y = 0; y < n; y++) {
      re[y * n + x] = rowRe[y];
      im[y * n + x] = rowIm[y];
    }
  }
}

/** `values` (`n` × `n`) less their mean, NaN as the mean, under a Hann window; null when they are flat or mostly missing. */
function prepare(values: ArrayLike<number>, n: number): Float64Array | null {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n * n; i++) {
    const v = values[i];
    if (v === v) {
      sum += v;
      count++;
    }
  }
  if (count < n * n * 0.5) return null;
  const mean = sum / count;
  const out = new Float64Array(n * n);
  let energy = 0;
  for (let y = 0; y < n; y++) {
    const wy = 0.5 - 0.5 * Math.cos((2 * Math.PI * (y + 0.5)) / n);
    for (let x = 0; x < n; x++) {
      const wx = 0.5 - 0.5 * Math.cos((2 * Math.PI * (x + 0.5)) / n);
      const v = values[y * n + x];
      const d = (v === v ? v : mean) - mean;
      out[y * n + x] = d * wx * wy;
      energy += d * d;
    }
  }
  return energy > 1e-12 * count ? out : null;
}

/** A shift found by phase correlation. */
export interface Correlation {
  /** How far the second grid's content is moved from the first's, in pixels (x right, y down): `b(x) = a(x − d)`. */
  dx: number;
  dy: number;
  /** The peak's height over the next highest elsewhere (above about 1.5 is a clear match). */
  strength: number;
}

/**
 * The shift between two `n` × `n` grids (`n` a power of 2), to a fraction of
 * a pixel; null when either is flat or mostly no data (NaN).
 */
export function phaseCorrelate(a: ArrayLike<number>, b: ArrayLike<number>, n: number): Correlation | null {
  const fa = prepare(a, n);
  const fb = prepare(b, n);
  if (!fa || !fb) return null;
  const ai = new Float64Array(n * n);
  const bi = new Float64Array(n * n);
  fft2(fa, ai, n);
  fft2(fb, bi, n);
  // conj(A)·B, normalized: its inverse peaks at the shift of b from a.
  const re = new Float64Array(n * n);
  const im = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const r = fa[i] * fb[i] + ai[i] * bi[i];
    const m = fa[i] * bi[i] - ai[i] * fb[i];
    const mag = Math.hypot(r, m);
    if (mag > 1e-20) {
      re[i] = r / mag;
      im[i] = m / mag;
    }
  }
  fft2(re, im, n, true);
  let best = 0;
  for (let i = 1; i < n * n; i++) if (re[i] > re[best]) best = i;
  const bx = best % n;
  const by = Math.floor(best / n);
  const at = (x: number, y: number) => re[((y + n) % n) * n + ((x + n) % n)];
  // The next highest peak away from this one, for how sure the match is.
  let second = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const ddx = Math.min(Math.abs(x - bx), n - Math.abs(x - bx));
      const ddy = Math.min(Math.abs(y - by), n - Math.abs(y - by));
      if (ddx > 2 || ddy > 2) second = Math.max(second, re[y * n + x]);
    }
  }
  // Sub-pixel: a parabola through the peak and its neighbours, each way.
  const sub = (l: number, c: number, r: number) => {
    const d = l - 2 * c + r;
    return d < 0 ? Math.max(-0.5, Math.min(0.5, (l - r) / (2 * d))) : 0;
  };
  const fx = sub(at(bx - 1, by), at(bx, by), at(bx + 1, by));
  const fy = sub(at(bx, by - 1), at(bx, by), at(bx, by + 1));
  const wrap = (v: number) => (v > n / 2 ? v - n : v);
  return { dx: wrap(bx) + fx, dy: wrap(by) + fy, strength: second > 0 ? re[best] / second : Infinity };
}

/** A tie point: where a feature is in the reference (`x`, `y`) and where the image to align shows it (`u`, `v`), in the same units. */
export interface TiePoint {
  x: number;
  y: number;
  u: number;
  v: number;
}

/** `[a, b, c, d, e, f]`: u = a + b·x + c·y, v = d + e·x + f·y. */
export type Affine = [number, number, number, number, number, number];

export const applyAffine = (t: Affine, x: number, y: number): [number, number] => [t[0] + t[1] * x + t[2] * y, t[3] + t[4] * x + t[5] * y];

/** The shift of most tie points (the median each way), as an affine transformation. */
export function fitShift(points: readonly TiePoint[]): Affine {
  const median = (v: number[]) => {
    const s = [...v].sort((p, q) => p - q);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  return [median(points.map((p) => p.u - p.x)), 1, 0, median(points.map((p) => p.v - p.y)), 0, 1];
}

/** Solves the 3 × 3 system `m`·s = `r`; null when singular. */
function solve3(m: number[][], r: number[]): number[] | null {
  const a = m.map((row, i) => [...row, r[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let i = c + 1; i < 3; i++) if (Math.abs(a[i][c]) > Math.abs(a[p][c])) p = i;
    if (Math.abs(a[p][c]) < 1e-12) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let i = 0; i < 3; i++) {
      if (i === c) continue;
      const f = a[i][c] / a[c][c];
      for (let k = c; k < 4; k++) a[i][k] -= f * a[c][k];
    }
  }
  return a.map((row, i) => row[3] / a[i][i]);
}

/** The least-squares affine transformation through the tie points; null with fewer than 3 or when they are in a line. */
export function fitAffine(points: readonly TiePoint[]): Affine | null {
  if (points.length < 3) return null;
  // About the centroid, for a well-conditioned system.
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const ru = [0, 0, 0];
  const rv = [0, 0, 0];
  for (const p of points) {
    const row = [1, p.x - cx, p.y - cy];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) m[i][j] += row[i] * row[j];
      ru[i] += row[i] * p.u;
      rv[i] += row[i] * p.v;
    }
  }
  const su = solve3(m, ru);
  const sv = solve3(m, rv);
  if (!su || !sv) return null;
  // Back from centroid coordinates.
  return [su[0] - su[1] * cx - su[2] * cy, su[1], su[2], sv[0] - sv[1] * cx - sv[2] * cy, sv[1], sv[2]];
}

/** How far each tie point is from where `t` puts it. */
export function residuals(t: Affine, points: readonly TiePoint[]): number[] {
  return points.map((p) => {
    const [u, v] = applyAffine(t, p.x, p.y);
    return Math.hypot(u - p.u, v - p.v);
  });
}

export const rms = (values: readonly number[]) => (values.length ? Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length) : 0);

/**
 * Fits `how` to the tie points, dropping the worst while it lies more than
 * 3 times the median residual (and `floor`) off, keeping at least half (and
 * 3 for an affine). Returns the fit, the points kept and their RMS residual.
 */
export function robustFit(points: readonly TiePoint[], how: 'shift' | 'affine', floor = 0): { transform: Affine; kept: TiePoint[]; rms: number } | null {
  let kept = [...points];
  const minimum = how === 'affine' ? 3 : 1;
  if (kept.length < minimum) return null;
  for (;;) {
    const transform = how === 'affine' ? fitAffine(kept) : fitShift(kept);
    if (!transform) return null;
    const r = residuals(transform, kept);
    const median = [...r].sort((a, b) => a - b)[r.length >> 1];
    let worst = 0;
    for (let i = 1; i < r.length; i++) if (r[i] > r[worst]) worst = i;
    const limit = Math.max(3 * median, floor);
    if (r[worst] <= limit || kept.length - 1 < Math.max(minimum, Math.ceil(points.length / 2))) return { transform, kept, rms: rms(r) };
    kept = kept.filter((_, i) => i !== worst);
  }
}

/** The inverse of an affine transformation; null when singular. */
export function invertAffine(t: Affine): Affine | null {
  const [a, b, c, d, e, f] = t;
  const det = b * f - c * e;
  if (Math.abs(det) < 1e-15) return null;
  const ib = f / det;
  const ic = -c / det;
  const ie = -e / det;
  const iff = b / det;
  return [-(ib * a + ic * d), ib, ic, -(ie * a + iff * d), ie, iff];
}
