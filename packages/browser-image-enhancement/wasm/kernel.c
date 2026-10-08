/*
 * The pixel engine's hot loops in WebAssembly (SIMD). src/core/wasm.ts
 * decides when a program can run here and lays out the tables; anything else
 * stays in JS (src/core/process.ts, src/core/filter.ts).
 *
 * Every loop does the same float64 arithmetic, in the same order, as the JS
 * it replaces, so results are identical to JS. The one exception is pow (in
 * sRGB encoding and decoding between per-pixel steps and sharpen), which is
 * musl's (pow.c) and may differ from the browser's Math.pow in the last bit
 * of a float64; a value that lands exactly on an 8-bit rounding boundary can
 * then come out one level apart.
 *
 * Build: npm run build:wasm (needs clang with the wasm32 target and wasm-ld).
 */
#include <stdint.h>
#include <wasm_simd128.h>

typedef uint8_t u8;

double kpow(double x, double y);

#define LR 0.2126
#define LG 0.7152
#define LB 0.0722
#define BUCKETS 4096
/* Taps of the widest blur: kernelRadius(50) = 150 on each side. */
#define MAX_SPAN 301

/*
 * A Quantizer (src/core/quantizer.ts): JS writes lo..ceil, t[0..255] and
 * base, then quant_prepare fills the rest. 6216 bytes, 8-aligned.
 */
typedef struct {
  double lo, hi, scale;
  int32_t floor, ceil;
  /* Most codes a bucket's scan can move past (+1 for rounding in the bucket index). */
  int32_t steps, pad;
  double t[260];
  u8 base[BUCKETS];
} Quant;

__attribute__((export_name("quant_prepare")))
void quant_prepare(Quant *q) {
  for (int k = 256; k < 260; k++) q->t[k] = __builtin_inf();
  int steps = 0;
  for (int b = 0; b < BUCKETS; b++) {
    double upper = q->scale > 0 ? q->lo + (b + 1) / q->scale : q->hi;
    if (upper > q->hi) upper = q->hi;
    int c = q->base[b];
    while (c < q->ceil && q->t[c] <= upper) c++;
    if (c - q->base[b] > steps) steps = c - q->base[b];
  }
  q->steps = steps + 1;
}

/*
 * Same as Quantizer.quantize. The scan from base[b] stops at the first
 * threshold above v; as thresholds rise, that is base[b] plus the number of
 * the next `steps` thresholds that are <= v, which needs no branches.
 */
static inline int quant(const Quant *q, double v) {
  if (!(v >= q->lo)) return q->floor;
  if (v >= q->hi) return q->ceil;
  int b = (int)((v - q->lo) * q->scale);
  if (b >= BUCKETS) b = BUCKETS - 1;
  int code = q->base[b];
  const double *t = q->t + code;
  if (q->steps <= 3) return code + (v >= t[0]) + (v >= t[1]) + (v >= t[2]);
  while (v >= q->t[code]) code++;
  return code;
}

static inline double linear_to_srgb(double v) {
  if (!(v > 0)) return 0;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * kpow(v, 1 / 2.4) - 0.055;
}

static inline uint64_t bits(double x) { union { double f; uint64_t i; } u = {x}; return u.i; }
static inline double from_bits(uint64_t i) { union { uint64_t i; double f; } u = {i}; return u.f; }
static inline uint32_t fbits(float x) { union { float f; uint32_t i; } u = {x}; return u.i; }
static inline float from_fbits(uint32_t i) { union { uint32_t i; float f; } u = {i}; return u.f; }

/*
 * Fast x^(5/12) (= x^(1/2.4)) for 2^-10 <= x < 2^20: x = 2^e * m, 1 <= m < 2;
 * m^(5/12) from a degree-5 Taylor series around the middle of m's 1/64-wide
 * segment, times 2^(5e/12) from a table. Relative error about 1e-14.
 */
#define SEGMENTS 64
#define E_MIN (-10)
#define E_MAX 19
static double TAYLOR[SEGMENTS][6];
static double SCALE[E_MAX - E_MIN + 1];
static int fast_ready;

static void fast_init(void) {
  const double a = 5.0 / 12;
  for (int j = 0; j < SEGMENTS; j++) {
    double c = 1 + (j + 0.5) / SEGMENTS;
    double binom = 1;
    for (int k = 0; k <= 5; k++) {
      TAYLOR[j][k] = binom * kpow(c, a - k);
      binom = binom * (a - k) / (k + 1);
    }
  }
  for (int e = E_MIN; e <= E_MAX; e++) SCALE[e - E_MIN] = kpow(2, a * e);
  fast_ready = 1;
}

/*
 * (float)linear_to_srgb(v), which is what the rows of float values hold. The
 * fast power decides when its result is clearly on one side of the midpoint
 * between two floats; near a midpoint the exact pow does, so the float is
 * the one JS stores.
 */
static inline float linear_to_srgb_f32(double v) {
  if (!(v > 0.0031308)) return (float)linear_to_srgb(v);
  uint64_t iv = bits(v);
  int e = (int)(iv >> 52) - 1023;
  if (e >= E_MIN && e <= E_MAX) {
    int j = (int)((iv >> 46) & (SEGMENTS - 1));
    double t = from_bits((iv & 0xFFFFFFFFFFFFFull) | 0x3FF0000000000000ull) - (1 + (j + 0.5) / SEGMENTS);
    const double *c = TAYLOR[j];
    double p = c[0] + t * (c[1] + t * (c[2] + t * (c[3] + t * (c[4] + t * c[5]))));
    double enc = 1.055 * (p * SCALE[e - E_MIN]) - 0.055;
    float f = (float)enc;
    double fd = f;
    double other = from_fbits(enc >= fd ? fbits(f) + 1 : fbits(f) - 1);
    if (__builtin_fabs(enc - (fd + other) * 0.5) > enc * 1e-12) return f;
  }
  return (float)linear_to_srgb(v);
}

static inline double srgb_to_linear(double v) {
  return v <= 0.04045 ? v / 12.92 : kpow((v + 0.055) / 1.055, 2.4);
}

/* Saturation steps on linear R, G, B (the only per-pixel steps run here besides tables). */
static inline void saturate(const double *f, int n, double *r, double *g, double *b) {
  for (int k = 0; k < n; k++) {
    double y = LR * *r + LG * *g + LB * *b;
    *r = y + (*r - y) * f[k];
    *g = y + (*g - y) * f[k];
    *b = y + (*b - y) * f[k];
  }
}

/* ---- per-pixel programs ---- */

/* RGB: tables to linear (`lin`: 3 x 256), saturation steps, then rounding through `q` (3 Quants). */
__attribute__((export_name("pixel_rgb")))
void pixel_rgb(const u8 *src, u8 *dst, int bytes, const double *lin, const double *sat, int nsat, const Quant *q) {
  const double *lg = lin + 256, *lb = lin + 512;
  for (int i = 0; i < bytes; i += 4) {
    double r = lin[src[i]], g = lg[src[i + 1]], b = lb[src[i + 2]];
    saturate(sat, nsat, &r, &g, &b);
    dst[i] = (u8)quant(&q[0], r);
    dst[i + 1] = (u8)quant(&q[1], g);
    dst[i + 2] = (u8)quant(&q[2], b);
    dst[i + 3] = src[i + 3];
  }
}

/* ---- sharpen, streamed by rows (filter.ts sharpenRows) ---- */

/* Gaussian blur of `width` values along a row; sums in the order of blurRow in filter.ts. */
static void blur_row(const double *src, double *out, int width, const double *k, int r) {
  int taps = 2 * r + 1;
  int x = 0;
  for (; x < width && x < r; x++) {
    int to = x < width - r ? r : width - 1 - x;
    double s = 0;
    for (int i = -x; i <= to; i++) s += k[i + r] * src[x + i];
    out[x] = s;
  }
  /* Interior: two pixels per vector, each lane summing its taps in order. */
  for (; x + 1 < width - r; x += 2) {
    v128_t s = wasm_f64x2_splat(0);
    const double *b = src + x - r;
    for (int i = 0; i < taps; i++) s = wasm_f64x2_add(s, wasm_f64x2_mul(wasm_f64x2_splat(k[i]), wasm_v128_load(b + i)));
    wasm_v128_store(out + x, s);
  }
  for (; x < width; x++) {
    double s = 0;
    if (x >= r && x < width - r) {
      for (int i = 0, b = x - r; i < taps; i++) s += k[i] * src[b + i];
    } else {
      int from = x >= r ? -r : -x;
      int to = x < width - r ? r : width - 1 - x;
      for (int i = from; i <= to; i++) s += k[i + r] * src[x + i];
    }
    out[x] = s;
  }
}

/* out += kk * src, `width` values. */
static void accumulate(double *out, const double *src, double kk, int width) {
  v128_t k2 = wasm_f64x2_splat(kk);
  int x = 0;
  for (; x + 1 < width; x += 2) wasm_v128_store(out + x, wasm_f64x2_add(wasm_v128_load(out + x), wasm_f64x2_mul(k2, wasm_v128_load(src + x))));
  for (; x < width; x++) out[x] += kk * src[x];
}

/* out = sum over j of coef[j] * rows[j], added in order from 0 (as repeated `accumulate` onto zeros). */
static void vertical(double *out, double *const *rows, const double *coef, int n, int width) {
  int x = 0;
  for (; x + 3 < width; x += 4) {
    v128_t a = wasm_f64x2_splat(0), b = wasm_f64x2_splat(0);
    for (int j = 0; j < n; j++) {
      v128_t c = wasm_f64x2_splat(coef[j]);
      a = wasm_f64x2_add(a, wasm_f64x2_mul(c, wasm_v128_load(rows[j] + x)));
      b = wasm_f64x2_add(b, wasm_f64x2_mul(c, wasm_v128_load(rows[j] + x + 2)));
    }
    wasm_v128_store(out + x, a);
    wasm_v128_store(out + x + 2, b);
  }
  for (; x < width; x++) {
    double s = 0;
    for (int j = 0; j < n; j++) s += coef[j] * rows[j][x];
    out[x] = s;
  }
}

static void luma_row(const float *q0, const float *q1, const float *q2, double *lum, int width) {
  if (q1) for (int x = 0; x < width; x++) lum[x] = LR * (double)q0[x] + LG * (double)q1[x] + LB * (double)q2[x];
  else for (int x = 0; x < width; x++) lum[x] = q0[x];
}

static inline double *align8(u8 **p, int count) {
  double *d = (double *)(((uintptr_t)*p + 15) & ~(uintptr_t)15);
  *p = (u8 *)(d + count);
  return d;
}

/*
 * One sharpen step with the per-pixel steps around it, rows streamed through
 * a ring of 2r + 1 (filter.ts sharpenRows, process.ts head and finish).
 * Works in place when dst == src.
 *
 * head: 0 = `tab` gives encoded values per code (lutEncoded); 1 = `tab` gives
 * linear values, then `satHead` steps and sRGB encoding. tail: 0 = `q`
 * rounds encoded values; 1 = sRGB decoding, `satTail` steps, then `q`.
 * Gray (channels 1) takes head 0 and tail 0 and gray pixels only.
 *
 * Emits rows y0..y1. Called for consecutive bands of rows from y0 = 0 with
 * the same arguments and scratch, it continues where the last call stopped
 * (calls are short, so the browser can switch to optimized code between them).
 */
__attribute__((export_name("sharpen_stream")))
void sharpen_stream(const u8 *src, u8 *dst, int width, int height, int channels, const double *k, int r, double amount, double threshold,
                    int head, const double *tab, const double *satHead, int nsatHead, int tail, const double *satTail, int nsatTail,
                    const Quant *q, u8 *scratch, int y0, int y1) {
  int span = 2 * r + 1;
  int rgb = channels == 3;
  u8 *p = scratch;
  double *hN = align8(&p, span * width);
  double *hD = align8(&p, span * width);
  double *lum = align8(&p, width);
  double *wy = align8(&p, width);
  double *w = align8(&p, width);
  double *hOnes = align8(&p, width);
  double *vOnes = align8(&p, width);
  double *sn = align8(&p, width);
  double *sd = align8(&p, width);
  float *ring[3];
  for (int c = 0; c < channels; c++) {
    ring[c] = (float *)align8(&p, (span * width + 1) / 2);
  }
  u8 *opaque = p;
  double *rowsN[MAX_SPAN], *rowsD[MAX_SPAN], coef[MAX_SPAN];

  if (y0 == 0) {
    for (int x = 0; x < width; x++) w[x] = 1;
    blur_row(w, hOnes, width, k, r);
    for (int x = 0; x < width; x++) vOnes[x] = 0;
    for (int j = 0; j < span; j++) accumulate(vOnes, hOnes, k[j], width);
  }

  const double *t1 = tab + 256, *t2 = tab + 512;
  if (head == 1 && !fast_ready) fast_init();

  /* Rows below y0 + r were filled by the call for the rows before y0. */
  int yy = y0 == 0 ? 0 : (y0 + r < height ? y0 + r : height);
  for (int y = y0; y < y1; y++) {
    /* Fill and blur rows up to y + r (the first r rows before row 0). */
    for (; yy < height && yy <= y + r; yy++) {
      int slot = yy % span;
      int at = slot * width;
      float *f0 = ring[0] + at, *f1 = rgb ? ring[1] + at : 0, *f2 = rgb ? ring[2] + at : 0;
      const u8 *s = src + (uint32_t)yy * width * 4;
      if (rgb && head == 0) {
        for (int x = 0; x < width; x++) {
          f0[x] = (float)tab[s[4 * x]];
          f1[x] = (float)t1[s[4 * x + 1]];
          f2[x] = (float)t2[s[4 * x + 2]];
        }
      } else if (rgb) {
        for (int x = 0; x < width; x++) {
          double cr = tab[s[4 * x]], cg = t1[s[4 * x + 1]], cb = t2[s[4 * x + 2]];
          saturate(satHead, nsatHead, &cr, &cg, &cb);
          f0[x] = linear_to_srgb_f32(cr);
          f1[x] = linear_to_srgb_f32(cg);
          f2[x] = linear_to_srgb_f32(cb);
        }
      } else {
        for (int x = 0; x < width; x++) f0[x] = (float)tab[s[4 * x]];
      }
      luma_row(f0, f1, f2, lum, width);
      int all = 1;
      for (int x = 0; x < width; x++) if (s[4 * x + 3] != 255) { all = 0; break; }
      opaque[slot] = (u8)all;
      if (all) {
        blur_row(lum, hN + at, width, k, r);
        for (int x = 0; x < width; x++) hD[at + x] = hOnes[x];
        continue;
      }
      for (int x = 0; x < width; x++) {
        double a = s[4 * x + 3] / 255.0;
        w[x] = a;
        wy[x] = a > 0 ? a * lum[x] : 0;
      }
      blur_row(wy, hN + at, width, k, r);
      blur_row(w, hD + at, width, k, r);
    }

    int from = y < r ? -y : -r;
    int to = height - 1 - y < r ? height - 1 - y : r;
    int all = from == -r && to == r;
    for (int j = from; all && j <= to; j++) all = opaque[(y + j) % span] == 1;
    int taps = 0;
    for (int j = from; j <= to; j++, taps++) {
      int at = ((y + j) % span) * width;
      rowsN[taps] = hN + at;
      rowsD[taps] = hD + at;
      coef[taps] = k[j + r];
    }
    vertical(sn, rowsN, coef, taps, width);
    if (all) for (int x = 0; x < width; x++) sd[x] = vOnes[x];
    else vertical(sd, rowsD, coef, taps, width);

    int at = (y % span) * width;
    float *f0 = ring[0] + at, *f1 = rgb ? ring[1] + at : 0, *f2 = rgb ? ring[2] + at : 0;
    luma_row(f0, f1, f2, lum, width);
    const u8 *s = src + (uint32_t)y * width * 4;
    u8 *d = dst + (uint32_t)y * width * 4;
    for (int x = 0; x < width; x++) {
      if (s[4 * x + 3] == 0 || !(sd[x] > 0)) continue;
      double diff = lum[x] - sn[x] / sd[x];
      if (__builtin_fabs(diff) < threshold) continue;
      double dd = amount * diff;
      f0[x] = (float)((double)f0[x] + dd);
      if (rgb) {
        f1[x] = (float)((double)f1[x] + dd);
        f2[x] = (float)((double)f2[x] + dd);
      }
    }

    if (rgb && tail == 0) {
      for (int x = 0; x < width; x++) {
        u8 a = s[4 * x + 3];
        d[4 * x] = (u8)quant(&q[0], f0[x]);
        d[4 * x + 1] = (u8)quant(&q[1], f1[x]);
        d[4 * x + 2] = (u8)quant(&q[2], f2[x]);
        d[4 * x + 3] = a;
      }
    } else if (rgb) {
      for (int x = 0; x < width; x++) {
        u8 a = s[4 * x + 3];
        double cr = srgb_to_linear(f0[x]), cg = srgb_to_linear(f1[x]), cb = srgb_to_linear(f2[x]);
        saturate(satTail, nsatTail, &cr, &cg, &cb);
        d[4 * x] = (u8)quant(&q[0], cr);
        d[4 * x + 1] = (u8)quant(&q[1], cg);
        d[4 * x + 2] = (u8)quant(&q[2], cb);
        d[4 * x + 3] = a;
      }
    } else {
      for (int x = 0; x < width; x++) {
        u8 a = s[4 * x + 3];
        u8 out = (u8)quant(&q[0], f0[x]);
        d[4 * x] = out;
        d[4 * x + 1] = out;
        d[4 * x + 2] = out;
        d[4 * x + 3] = a;
      }
    }
  }
}

/* Bytes of scratch sharpen_stream needs. */
__attribute__((export_name("sharpen_scratch")))
int sharpen_scratch(int width, int r, int channels) {
  int span = 2 * r + 1;
  return (2 * span * width + 7 * width) * 8 + channels * (span * width * 4 + 8) + span + 16 * 16;
}
