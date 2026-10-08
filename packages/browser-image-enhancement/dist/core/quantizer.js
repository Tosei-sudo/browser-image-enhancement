import { srgbToLinear } from "../color/srgb.js";
//#region src/core/quantizer.ts
/**
* Fast exact rounding of `quantize(F(v))` for a non-decreasing function F.
*
* The output code is the number of thresholds s_k with v >= s_k, where
* s_k = min { v : F(v) >= t_k } and t_k are the sRGB code boundaries. The s_k
* are found once by bisection; per pixel, a bucket table gives the code to
* within a step or two and a short scan finishes the job, instead of evaluating
* F (often several Math.pow calls) and an 8-step search for every channel.
*/
const BUCKETS = 4096;
/** Linear value at the boundary between codes k and k + 1. */
const CODE_BOUNDARIES = /* @__PURE__ */ (() => {
	const t = /* @__PURE__ */ new Float64Array(255);
	for (let k = 0; k < 255; k++) t[k] = srgbToLinear((k + .5) / 255);
	return t;
})();
const f64 = /* @__PURE__ */ new Float64Array(1);
const i64 = new BigInt64Array(f64.buffer);
const SIGN = BigInt.asIntN(64, 1n << 63n);
function toKey(v) {
	f64[0] = v;
	const bits = i64[0];
	return bits < 0n ? SIGN - bits - 1n : bits;
}
function fromKey(key) {
	i64[0] = key < 0n ? SIGN - key - 1n : key;
	return f64[0];
}
/**
* Search range. Pixel values never get near it, and staying well inside the
* exactly-representable integers keeps the step functions monotonic in floating point.
*/
const LIMIT = 2 ** 50;
const LOW_KEY = toKey(-LIMIT);
const HIGH_KEY = toKey(LIMIT);
/** Smallest v in [-LIMIT, LIMIT] with F(v) >= target; -Infinity if all qualify, +Infinity if none does. */
function inverse(F, target) {
	if (F(-LIMIT) >= target) return -Infinity;
	if (!(F(LIMIT) >= target)) return Infinity;
	let lo = LOW_KEY;
	let hi = HIGH_KEY;
	while (hi - lo > 1n) {
		const mid = lo + hi >> 1n;
		if (F(fromKey(mid)) >= target) hi = mid;
		else lo = mid;
	}
	return fromKey(hi);
}
/**
* The fields are read by the WebAssembly engine (core/wasm.ts), which copies
* them into its own memory and runs the same `quantize`.
*/
var Quantizer = class {
	/** thresholds[k] = s_k; thresholds[255] = +Infinity as a sentinel. */
	thresholds = /* @__PURE__ */ new Float64Array(256);
	/** Code for inputs below the first finite threshold (count of -Infinity thresholds). */
	floor;
	/** Code for inputs at or above the last finite threshold. */
	lo;
	hi;
	ceil;
	scale;
	base = new Uint8Array(BUCKETS);
	/** `F` must be non-decreasing. Omit it for plain linear -> 8-bit rounding. */
	constructor(F) {
		const t = this.thresholds;
		for (let k = 0; k < 255; k++) t[k] = F ? inverse(F, CODE_BOUNDARIES[k]) : CODE_BOUNDARIES[k];
		t[255] = Infinity;
		let first = 0;
		while (first < 255 && t[first] === -Infinity) first++;
		let last = 254;
		while (last >= first && t[last] === Infinity) last--;
		this.floor = first;
		this.ceil = last + 1;
		this.lo = first <= last ? t[first] : Infinity;
		this.hi = first <= last ? t[last] : Infinity;
		const span = this.hi - this.lo;
		this.scale = span > 0 && Number.isFinite(span) ? BUCKETS / span : 0;
		let code = first;
		for (let b = 0; b < BUCKETS; b++) {
			const start = this.scale > 0 ? this.lo + b / this.scale : this.lo;
			while (code < this.ceil && t[code] <= start) code++;
			this.base[b] = Math.max(first, code - 1);
		}
	}
	/** Exact `quantize(F(v))`. NaN gives the lowest reachable code. */
	quantize(v) {
		if (!(v >= this.lo)) return this.floor;
		if (v >= this.hi) return this.ceil;
		let b = (v - this.lo) * this.scale | 0;
		if (b >= BUCKETS) b = 4095;
		const t = this.thresholds;
		let code = this.base[b];
		while (v >= t[code]) code++;
		return code;
	}
};
//#endregion
export { Quantizer };

//# sourceMappingURL=quantizer.js.map