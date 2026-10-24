/**
 * Land cover classification of a multi-band image, pixel by pixel:
 * unsupervised (k-means over a sample of the pixels: give the number of
 * classes) or supervised (statistics of training polygons, one class per
 * value of an attribute, then the minimum distance to the class means or the
 * maximum likelihood of a Gaussian per class). Classes are numbered from 1;
 * 0 is no data. The math here is plain functions, run in workers by
 * classify-run.ts.
 */

/** How pixels are put in classes. */
export type ClassifierKind = 'distance' | 'likelihood';

/** A trained classifier: per class its mean, and for maximum likelihood its inverse covariance and the constant of its log density. */
export interface ClassModel {
  kind: ClassifierKind;
  /** Bands per pixel. */
  dims: number;
  /** `classes × dims`, class by class. */
  means: Float64Array;
  /** Maximum likelihood: `classes × dims × dims` inverse covariances. */
  inverses?: Float64Array;
  /** Maximum likelihood: `-0.5 · log det Σ` per class. */
  constants?: Float64Array;
}

/** Statistics of training pixels per class: counts, sums and sums of products. */
export interface ClassStats {
  dims: number;
  counts: Float64Array;
  /** `classes × dims`. */
  sums: Float64Array;
  /** `classes × dims × dims`. */
  products: Float64Array;
}

/** Empty statistics for `classes` classes of `dims` bands. */
export function emptyStats(classes: number, dims: number): ClassStats {
  return { dims, counts: new Float64Array(classes), sums: new Float64Array(classes * dims), products: new Float64Array(classes * dims * dims) };
}

/** Adds `b` into `a`. */
export function addStats(a: ClassStats, b: ClassStats): void {
  for (const k of ['counts', 'sums', 'products'] as const) for (let i = 0; i < a[k].length; i++) a[k][i] += b[k][i];
}

/** Whether pixel `i` of band-separate `values` has a value in every band; its values go into `out`. */
function pixelOf(values: ReadonlyArray<ArrayLike<number>>, i: number, out: Float64Array): boolean {
  for (let d = 0; d < values.length; d++) {
    const v = values[d][i];
    if (v !== v) return false;
    out[d] = v;
  }
  return true;
}

/** Adds the pixels where `labels` (0: none, else class + 1) is set to `stats`. */
export function accumulate(stats: ClassStats, values: ReadonlyArray<ArrayLike<number>>, labels: ArrayLike<number>, n: number): void {
  const { dims } = stats;
  const x = new Float64Array(dims);
  for (let i = 0; i < n; i++) {
    const label = labels[i];
    if (!label || !pixelOf(values, i, x)) continue;
    const c = label - 1;
    stats.counts[c]++;
    const s = c * dims;
    const p = c * dims * dims;
    for (let a = 0; a < dims; a++) {
      stats.sums[s + a] += x[a];
      for (let b = 0; b < dims; b++) stats.products[p + a * dims + b] += x[a] * x[b];
    }
  }
}

/**
 * Inverts a symmetric positive definite matrix (Cholesky); returns the
 * inverse and log det, or null when it is not positive definite.
 */
export function invertSpd(m: Float64Array, n: number): { inverse: Float64Array; logDet: number } | null {
  const l = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = m[i * n + j];
      for (let k = 0; k < j; k++) s -= l[i * n + k] * l[j * n + k];
      if (i === j) {
        if (!(s > 0)) return null;
        l[i * n + i] = Math.sqrt(s);
      } else l[i * n + j] = s / l[j * n + j];
    }
  }
  let logDet = 0;
  for (let i = 0; i < n; i++) logDet += 2 * Math.log(l[i * n + i]);
  // L⁻¹ by forward substitution, then Σ⁻¹ = L⁻ᵀ L⁻¹.
  const li = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    li[i * n + i] = 1 / l[i * n + i];
    for (let j = 0; j < i; j++) {
      let s = 0;
      for (let k = j; k < i; k++) s -= l[i * n + k] * li[k * n + j];
      li[i * n + j] = s / l[i * n + i];
    }
  }
  const inverse = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = Math.max(i, j); k < n; k++) s += li[k * n + i] * li[k * n + j];
      inverse[i * n + j] = s;
    }
  }
  return { inverse, logDet };
}

/** Fewest training pixels a class needs: one more than the bands for maximum likelihood (a covariance), one for minimum distance. */
export function minPixels(kind: ClassifierKind, dims: number): number {
  return kind === 'likelihood' ? dims + 1 : 1;
}

/**
 * A classifier from training statistics. Throws naming the classes that
 * have too few pixels (by `names`).
 */
export function trainModel(stats: ClassStats, kind: ClassifierKind, names: readonly string[]): ClassModel {
  const { dims, counts } = stats;
  const classes = counts.length;
  const few = names.filter((_, c) => counts[c] < minPixels(kind, dims));
  if (few.length) throw new Error(`学習用の画素が不足のクラス: ${few.join('、')}（${minPixels(kind, dims)} 画素以上必要）`);
  const means = new Float64Array(classes * dims);
  for (let c = 0; c < classes; c++) for (let d = 0; d < dims; d++) means[c * dims + d] = stats.sums[c * dims + d] / counts[c];
  if (kind === 'distance') return { kind, dims, means };
  const inverses = new Float64Array(classes * dims * dims);
  const constants = new Float64Array(classes);
  for (let c = 0; c < classes; c++) {
    const n = counts[c];
    const cov = new Float64Array(dims * dims);
    let trace = 0;
    for (let a = 0; a < dims; a++) {
      for (let b = 0; b < dims; b++) {
        cov[a * dims + b] = stats.products[c * dims * dims + a * dims + b] / n - means[c * dims + a] * means[c * dims + b];
      }
      trace += cov[a * dims + a];
    }
    // A little ridge keeps a flat class (a uniform area, a saturated band) invertible.
    const ridge = Math.max(1e-9, (1e-4 * trace) / dims);
    for (let a = 0; a < dims; a++) cov[a * dims + a] += ridge;
    const inv = invertSpd(cov, dims);
    if (!inv) throw new Error(`クラス「${names[c]}」の分散の算出に失敗（学習用の画素の値がそろいすぎ）`);
    inverses.set(inv.inverse, c * dims * dims);
    constants[c] = -0.5 * inv.logDet;
  }
  return { kind, dims, means, inverses, constants };
}

/** Puts every pixel of band-separate `values` in the class it fits best: 1-based, 0 where a band has no value. */
export function classify(values: ReadonlyArray<ArrayLike<number>>, n: number, model: ClassModel): Uint8Array {
  const { dims, means, kind } = model;
  const classes = means.length / dims;
  const out = new Uint8Array(n);
  const x = new Float64Array(dims);
  const diff = new Float64Array(dims);
  for (let i = 0; i < n; i++) {
    if (!pixelOf(values, i, x)) continue;
    let best = 0;
    let bestScore = -Infinity;
    for (let c = 0; c < classes; c++) {
      let score: number;
      if (kind === 'distance') {
        let d2 = 0;
        for (let d = 0; d < dims; d++) {
          const v = x[d] - means[c * dims + d];
          d2 += v * v;
        }
        score = -d2;
      } else {
        const inv = model.inverses!;
        const o = c * dims * dims;
        for (let d = 0; d < dims; d++) diff[d] = x[d] - means[c * dims + d];
        let q = 0;
        for (let a = 0; a < dims; a++) {
          let row = 0;
          for (let b = 0; b < dims; b++) row += inv[o + a * dims + b] * diff[b];
          q += diff[a] * row;
        }
        score = model.constants![c] - 0.5 * q;
      }
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    out[i] = best + 1;
  }
  return out;
}

/** A small seeded random generator (mulberry32), so a classification can be made again the same. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Up to `count` pixels with a value in every band, picked evenly with a random start, interleaved (`dims` values each). */
export function samplePixels(values: ReadonlyArray<ArrayLike<number>>, n: number, count: number, rand: () => number): Float32Array {
  const dims = values.length;
  const x = new Float64Array(dims);
  const valid: number[] = [];
  for (let i = 0; i < n; i++) if (pixelOf(values, i, x)) valid.push(i);
  const take = Math.min(count, valid.length);
  const out = new Float32Array(take * dims);
  const step = valid.length / Math.max(1, take);
  const start = rand() * step;
  for (let k = 0; k < take; k++) {
    const i = valid[Math.min(valid.length - 1, Math.floor(start + k * step))];
    for (let d = 0; d < dims; d++) out[k * dims + d] = values[d][i];
  }
  return out;
}

/**
 * k-means of interleaved `samples` (`dims` values each) into `k` clusters:
 * k-means++ seeds, then Lloyd's iterations until no sample changes cluster
 * (or `iterations`). The clusters come out from darkest to brightest (by the
 * sum of their mean), so class 1 is the darkest, the same each time.
 */
export function kMeans(samples: Float32Array, dims: number, k: number, iterations = 30, seed = 1): Float64Array {
  const n = samples.length / dims;
  if (n < k) throw new Error(`値のある画素が ${n} のみのため、${k} クラスへの分類不可`);
  const rand = random(seed);
  const means = new Float64Array(k * dims);
  const dist2 = (i: number, c: number) => {
    let s = 0;
    for (let d = 0; d < dims; d++) {
      const v = samples[i * dims + d] - means[c * dims + d];
      s += v * v;
    }
    return s;
  };
  // k-means++: each next seed far from those chosen, with probability by squared distance.
  const nearest = new Float64Array(n).fill(Infinity);
  let pick = Math.floor(rand() * n);
  for (let c = 0; c < k; c++) {
    for (let d = 0; d < dims; d++) means[c * dims + d] = samples[pick * dims + d];
    let total = 0;
    for (let i = 0; i < n; i++) {
      nearest[i] = Math.min(nearest[i], dist2(i, c));
      total += nearest[i];
    }
    if (c === k - 1) break;
    if (!(total > 0)) {
      pick = Math.floor(rand() * n);
      continue;
    }
    let r = rand() * total;
    pick = n - 1;
    for (let i = 0; i < n; i++) {
      r -= nearest[i];
      if (r <= 0) {
        pick = i;
        break;
      }
    }
  }
  const owner = new Int32Array(n).fill(-1);
  const sums = new Float64Array(k * dims);
  const counts = new Float64Array(k);
  for (let it = 0; it < iterations; it++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist2(i, c);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (owner[i] !== best) {
        owner[i] = best;
        moved++;
      }
    }
    sums.fill(0);
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const c = owner[i];
      counts[c]++;
      for (let d = 0; d < dims; d++) sums[c * dims + d] += samples[i * dims + d];
    }
    for (let c = 0; c < k; c++) {
      // An empty cluster takes the sample farthest from its own mean.
      if (!counts[c]) {
        let far = 0;
        let farD = -1;
        for (let i = 0; i < n; i++) {
          const d = dist2(i, owner[i]);
          if (d > farD) {
            farD = d;
            far = i;
          }
        }
        for (let d = 0; d < dims; d++) means[c * dims + d] = samples[far * dims + d];
        moved++;
        continue;
      }
      for (let d = 0; d < dims; d++) means[c * dims + d] = sums[c * dims + d] / counts[c];
    }
    if (!moved) break;
  }
  const order = Array.from({ length: k }, (_, c) => c);
  const brightness = (c: number) => {
    let s = 0;
    for (let d = 0; d < dims; d++) s += means[c * dims + d];
    return s;
  };
  order.sort((a, b) => brightness(a) - brightness(b));
  const sorted = new Float64Array(k * dims);
  order.forEach((c, j) => sorted.set(means.subarray(c * dims, (c + 1) * dims), j * dims));
  return sorted;
}

/**
 * Marks the pixels of a `width` × `height` block whose centers are inside a
 * polygon with its label (1-based class). Rings are in the block's pixel
 * coordinates, `[x0, y0, x1, y1, …]`, and filled even-odd (holes stay out).
 */
export function rasterizePolygons(polygons: ReadonlyArray<{ label: number; rings: Float64Array[] }>, width: number, height: number, out = new Uint8Array(width * height)): Uint8Array {
  const xs: number[] = [];
  for (const { label, rings } of polygons) {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const ring of rings) {
      for (let i = 1; i < ring.length; i += 2) {
        minY = Math.min(minY, ring[i]);
        maxY = Math.max(maxY, ring[i]);
      }
    }
    const y0 = Math.max(0, Math.ceil(minY - 0.5));
    const y1 = Math.min(height - 1, Math.floor(maxY - 0.5));
    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5;
      xs.length = 0;
      for (const ring of rings) {
        const m = ring.length / 2;
        for (let i = 0, j = m - 1; i < m; j = i++) {
          const ay = ring[2 * j + 1];
          const by = ring[2 * i + 1];
          if (ay > cy === by > cy) continue;
          const ax = ring[2 * j];
          const bx = ring[2 * i];
          xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.ceil(xs[k] - 0.5));
        const to = Math.min(width - 1, Math.floor(xs[k + 1] - 0.5));
        for (let x = from; x <= to; x++) out[y * width + x] = label;
      }
    }
  }
  return out;
}

/** Distinct colors for classes, in order (then again). */
export const CLASS_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [31, 119, 180],
  [44, 160, 44],
  [214, 39, 40],
  [255, 127, 14],
  [148, 103, 189],
  [140, 86, 75],
  [227, 119, 194],
  [127, 127, 127],
  [188, 189, 34],
  [23, 190, 207],
  [174, 199, 232],
  [152, 223, 138],
  [255, 152, 150],
  [255, 187, 120],
  [197, 176, 213],
  [196, 156, 148],
  [247, 182, 210],
  [199, 199, 199],
  [219, 219, 141],
  [158, 218, 229],
];

/** The color of 1-based class `c`. */
export function classColor(c: number): readonly [number, number, number] {
  return CLASS_COLORS[(c - 1) % CLASS_COLORS.length];
}

/** Classes as RGBA pixels (transparent where 0), interleaved, colored by `colors` (index: class - 1). */
export function colorClasses(classes: Uint8Array, colors: ReadonlyArray<readonly [number, number, number]>): Uint8Array {
  const out = new Uint8Array(classes.length * 4);
  for (let i = 0; i < classes.length; i++) {
    const c = classes[i];
    if (!c) continue;
    const rgb = colors[c - 1];
    out[4 * i] = rgb[0];
    out[4 * i + 1] = rgb[1];
    out[4 * i + 2] = rgb[2];
    out[4 * i + 3] = 255;
  }
  return out;
}
