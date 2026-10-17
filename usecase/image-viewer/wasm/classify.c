/*
 * The per-pixel loops of the land cover classification (src/classify.ts),
 * four pixels at a time with WebAssembly SIMD. Bands are planar float32
 * (`dims` planes of `n` pixels), NaN where there is no value. Built into
 * src/classify-wasm-bytes.ts by scripts/build-wasm.mjs.
 */
#include <stdint.h>
#include <wasm_simd128.h>

#define MAX_DIMS 32

/* 1-based classes of four pixels: `best` (0-based lanes) where every band has a value, else 0. */
static inline void store_classes(uint8_t *out, uint32_t *counts, v128_t best, v128_t valid) {
  v128_t c = wasm_v128_and(wasm_i32x4_add(best, wasm_i32x4_splat(1)), valid);
  uint32_t a = (uint32_t)wasm_i32x4_extract_lane(c, 0);
  uint32_t b = (uint32_t)wasm_i32x4_extract_lane(c, 1);
  uint32_t d = (uint32_t)wasm_i32x4_extract_lane(c, 2);
  uint32_t e = (uint32_t)wasm_i32x4_extract_lane(c, 3);
  out[0] = (uint8_t)a;
  out[1] = (uint8_t)b;
  out[2] = (uint8_t)d;
  out[3] = (uint8_t)e;
  counts[a]++;
  counts[b]++;
  counts[d]++;
  counts[e]++;
}

/* Loads four pixels of every band; returns the lanes where all bands have a value. */
static inline v128_t load_pixels(const float *bands, int n, int dims, int i, v128_t *x) {
  v128_t valid = wasm_i32x4_splat(-1);
  for (int d = 0; d < dims; d++) {
    v128_t v = wasm_v128_load(bands + (long)d * n + i);
    x[d] = v;
    valid = wasm_v128_and(valid, wasm_f32x4_eq(v, v));
  }
  return valid;
}

/* The same for the last 1-3 pixels, padded with NaN. */
static inline v128_t load_tail(const float *bands, int n, int dims, int i, v128_t *x) {
  float lane[4];
  v128_t valid = wasm_i32x4_splat(-1);
  for (int d = 0; d < dims; d++) {
    for (int k = 0; k < 4; k++) lane[k] = i + k < n ? bands[(long)d * n + i + k] : __builtin_nanf("");
    v128_t v = wasm_v128_load(lane);
    x[d] = v;
    valid = wasm_v128_and(valid, wasm_f32x4_eq(v, v));
  }
  return valid;
}

static inline void store_tail(uint8_t *out, uint32_t *counts, v128_t best, v128_t valid, int left) {
  uint8_t four[4];
  uint32_t scratch[256 + 1];
  for (int k = 0; k < 4; k++) four[k] = 0;
  store_classes(four, scratch, best, valid);
  for (int k = 0; k < left; k++) {
    out[k] = four[k];
    counts[four[k]]++;
  }
}

/*
 * Minimum distance: each pixel in the class whose mean is nearest
 * (Euclidean), the first on a tie. `counts` gets k + 1 entries, [0] for
 * pixels without a value.
 */
__attribute__((export_name("classify_distance"))) void classify_distance(const float *bands, int n, int dims, const float *means, int k, uint8_t *out, uint32_t *counts) {
  v128_t x[MAX_DIMS];
  for (int i = 0; i < n; i += 4) {
    v128_t valid = i + 4 <= n ? load_pixels(bands, n, dims, i, x) : load_tail(bands, n, dims, i, x);
    v128_t best_d = wasm_f32x4_splat(__builtin_inff());
    v128_t best = wasm_i32x4_splat(0);
    for (int c = 0; c < k; c++) {
      const float *m = means + c * dims;
      v128_t acc = wasm_f32x4_splat(0);
      for (int d = 0; d < dims; d++) {
        v128_t diff = wasm_f32x4_sub(x[d], wasm_f32x4_splat(m[d]));
        acc = wasm_f32x4_add(acc, wasm_f32x4_mul(diff, diff));
      }
      v128_t closer = wasm_f32x4_lt(acc, best_d);
      best_d = wasm_v128_bitselect(acc, best_d, closer);
      best = wasm_v128_bitselect(wasm_i32x4_splat(c), best, closer);
    }
    if (i + 4 <= n) store_classes(out + i, counts, best, valid);
    else store_tail(out + i, counts, best, valid, n - i);
  }
}

/*
 * Maximum likelihood: each pixel in the class with the highest Gaussian log
 * density, `constant - (x - mean)ᵀ Σ⁻¹ (x - mean) / 2` (`inverses` is
 * k × dims × dims, symmetric), the first on a tie.
 */
__attribute__((export_name("classify_ml"))) void classify_ml(const float *bands, int n, int dims, const float *means, const float *inverses, const float *constants, int k, uint8_t *out, uint32_t *counts) {
  v128_t x[MAX_DIMS];
  v128_t diff[MAX_DIMS];
  for (int i = 0; i < n; i += 4) {
    v128_t valid = i + 4 <= n ? load_pixels(bands, n, dims, i, x) : load_tail(bands, n, dims, i, x);
    v128_t best_s = wasm_f32x4_splat(-__builtin_inff());
    v128_t best = wasm_i32x4_splat(0);
    for (int c = 0; c < k; c++) {
      const float *m = means + c * dims;
      const float *inv = inverses + (long)c * dims * dims;
      for (int d = 0; d < dims; d++) diff[d] = wasm_f32x4_sub(x[d], wasm_f32x4_splat(m[d]));
      /* The symmetric form: the diagonal once, the rest twice. */
      v128_t q = wasm_f32x4_splat(0);
      for (int a = 0; a < dims; a++) {
        const float *row = inv + a * dims;
        v128_t r = wasm_f32x4_mul(wasm_f32x4_splat(row[a]), diff[a]);
        v128_t off = wasm_f32x4_splat(0);
        for (int b = a + 1; b < dims; b++) off = wasm_f32x4_add(off, wasm_f32x4_mul(wasm_f32x4_splat(row[b]), diff[b]));
        r = wasm_f32x4_add(r, wasm_f32x4_add(off, off));
        q = wasm_f32x4_add(q, wasm_f32x4_mul(diff[a], r));
      }
      v128_t s = wasm_f32x4_sub(wasm_f32x4_splat(constants[c]), wasm_f32x4_mul(wasm_f32x4_splat(0.5f), q));
      v128_t higher = wasm_f32x4_gt(s, best_s);
      best_s = wasm_v128_bitselect(s, best_s, higher);
      best = wasm_v128_bitselect(wasm_i32x4_splat(c), best, higher);
    }
    if (i + 4 <= n) store_classes(out + i, counts, best, valid);
    else store_tail(out + i, counts, best, valid, n - i);
  }
}

/* Classes (1-based, 0 = none) as RGBA: `palette` is k × RGB; 0 is transparent. */
__attribute__((export_name("color_classes"))) void color_classes(const uint8_t *classes, int n, const uint8_t *palette, uint8_t *rgba) {
  for (int i = 0; i < n; i++) {
    uint32_t c = classes[i];
    uint8_t *p = rgba + 4 * i;
    if (!c) {
      p[0] = p[1] = p[2] = p[3] = 0;
      continue;
    }
    const uint8_t *rgb = palette + 3 * (c - 1);
    p[0] = rgb[0];
    p[1] = rgb[1];
    p[2] = rgb[2];
    p[3] = 255;
  }
}
