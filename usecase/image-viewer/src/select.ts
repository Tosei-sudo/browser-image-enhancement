/**
 * The k-th smallest of many values without sorting them all: a quickselect
 * (median-of-three pivots, falling back to a sort of what is left when the
 * pivots go badly), in place, in time proportional to the count. A median or
 * percentile of a 12-megapixel band takes tens of milliseconds this way
 * instead of seconds for a sort of a plain array.
 */

/**
 * Reorders `a` so that `a[k]` is the value a sort would put there, every
 * value before it no larger and every one after no smaller, and returns it.
 * `a` holds no NaN.
 */
export function selectInPlace(a: Float64Array, k: number): number {
  let lo = 0;
  let hi = a.length - 1;
  // A bad run of pivots costs at most this many rounds before the rest is sorted.
  let budget = 2 * Math.ceil(Math.log2(a.length + 1)) + 8;
  while (hi > lo) {
    if (hi - lo < 16 || --budget < 0) {
      a.subarray(lo, hi + 1).sort();
      return a[k];
    }
    const mid = (lo + hi) >>> 1;
    // Median of three as the pivot, also left at lo and hi as sentinels.
    if (a[mid] < a[lo]) swap(a, mid, lo);
    if (a[hi] < a[lo]) swap(a, hi, lo);
    if (a[hi] < a[mid]) swap(a, hi, mid);
    const pivot = a[mid];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        swap(a, i, j);
        i++;
        j--;
      }
    }
    // Now a[lo..j] <= pivot <= a[i..hi], and anything between equals it.
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k];
  }
  return a[k];
}

function swap(a: Float64Array, i: number, j: number): void {
  const t = a[i];
  a[i] = a[j];
  a[j] = t;
}

/** The largest of `a[0..end)`. */
export function maxBefore(a: Float64Array, end: number): number {
  let m = -Infinity;
  for (let i = 0; i < end; i++) if (a[i] > m) m = a[i];
  return m;
}

/** The median of `a` (which it reorders): the middle value, or the mean of the two middle ones. NaN when empty. */
export function medianInPlace(a: Float64Array): number {
  const n = a.length;
  if (!n) return NaN;
  const h = n >> 1;
  const upper = selectInPlace(a, h);
  // After the select, the value just below the middle is the largest of the lower part.
  return n % 2 ? upper : (maxBefore(a, h) + upper) / 2;
}
