/**
 * sRGB <-> linear-light conversion.
 *
 * Decoding uses a 256-entry table (8-bit input only has 256 values).
 * Encoding back to 8 bits uses the 255 decision thresholds between adjacent
 * codes, so `quantize` returns exactly `round(encode(v) * 255)` without
 * evaluating `Math.pow` per pixel.
 */
/** Exact sRGB transfer function: encoded value in [0, 1] -> linear light. */
export function srgbToLinear(v) {
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
/** Exact inverse sRGB transfer function: linear light -> encoded value. Negative input maps to 0. */
export function linearToSrgb(v) {
    if (!(v > 0))
        return 0;
    return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}
/** Linear-light value of every 8-bit sRGB code. */
export const SRGB_TO_LINEAR = /* @__PURE__ */ (() => {
    const t = new Float64Array(256);
    for (let i = 0; i < 256; i++)
        t[i] = srgbToLinear(i / 255);
    return t;
})();
/**
 * THRESHOLDS[k] is the linear value whose encoded value is exactly (k + 0.5) / 255,
 * i.e. the boundary between codes k and k + 1. The last slot is +Infinity so the
 * table has 256 entries and the search below is a fixed 8 steps.
 */
const THRESHOLDS = /* @__PURE__ */ (() => {
    const t = new Float64Array(256);
    for (let k = 0; k < 255; k++)
        t[k] = srgbToLinear((k + 0.5) / 255);
    t[255] = Infinity;
    return t;
})();
/**
 * Linear light -> 8-bit sRGB code, rounding half up and clamping to [0, 255].
 * NaN and negative values map to 0.
 */
export function quantize(v) {
    const t = THRESHOLDS;
    let i = 0;
    if (t[i + 127] <= v)
        i += 128;
    if (t[i + 63] <= v)
        i += 64;
    if (t[i + 31] <= v)
        i += 32;
    if (t[i + 15] <= v)
        i += 16;
    if (t[i + 7] <= v)
        i += 8;
    if (t[i + 3] <= v)
        i += 4;
    if (t[i + 1] <= v)
        i += 2;
    if (t[i] <= v)
        i += 1;
    return i;
}
/** Rec. 709 / sRGB luminance weights for linear RGB. */
export const LUMA_R = 0.2126;
export const LUMA_G = 0.7152;
export const LUMA_B = 0.0722;
//# sourceMappingURL=srgb.js.map