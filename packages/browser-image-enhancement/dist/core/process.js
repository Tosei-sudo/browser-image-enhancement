import { LUMA_B, LUMA_G, LUMA_R, SRGB_TO_LINEAR, linearToSrgb, quantize, srgbToLinear } from "../color/srgb.js";
import { COLOR_ONLY_OPS, isIdentity, toStage } from "../ops/index.js";
import { sharpenPlanes, sharpenRows } from "./filter.js";
import { Quantizer } from "./quantizer.js";
//#region src/core/process.ts
/**
* The pixel engine. DOM-free and synchronous, so the same code runs on the main
* thread and inside Web Workers.
*
* Every chain of corrections runs in one pass: pixels are decoded to linear light,
* all steps run in float64, and the result is rounded to 8 bits once.
* Per-channel steps at the start of the chain are folded into 256-entry tables
* (the input only has 256 possible values per channel); if the whole chain is
* per-channel, the pass reduces to an 8-bit table lookup.
*
* A chain with `sharpen` (which reads neighbouring pixels) keeps the image in
* float planes of sRGB-encoded values at each sharpen; the steps around it
* still run per pixel, and the result is still rounded only once.
*/
function chain(stages, c) {
	return (v) => {
		for (const s of stages) v = s.fn(v, c);
		return v;
	};
}
/** In gray mode there is one channel; a per-channel stretch uses the mean of its points. */
function forGray(op) {
	if (op.op !== "stretch") return op;
	const mean = (v) => (v[0] + v[1] + v[2]) / 3;
	const b = mean(op.black);
	const w = mean(op.white);
	return {
		op: "stretch",
		black: [
			b,
			b,
			b
		],
		white: [
			w,
			w,
			w
		]
	};
}
/** Splits per-pixel steps into the middle and the trailing per-channel run (all middle without folding). */
function splitTail(stages, fuse) {
	let start = stages.length;
	if (fuse) while (start > 0 && stages[start - 1].kind === "channel") start--;
	return [stages.slice(0, start), stages.slice(start)];
}
/**
* Compiles normalized ops for one color mode. In gray mode color-only ops
* (saturation, temperature) are dropped. `autoStretch` steps must already be
* resolved (see core/histogram.ts).
*/
function compile(ops, mode, options = {}) {
	const fuse = options.fuse ?? true;
	const stages = ops.filter((op) => !isIdentity(op) && !(mode === "gray" && COLOR_ONLY_OPS.has(op.op))).map((op) => toStage(mode === "gray" ? forGray(op) : op));
	const cut = stages.findIndex((s) => s.kind === "sharpen");
	const all = cut < 0 ? stages : stages.slice(0, cut);
	let lead = 0;
	let tailStart = all.length;
	if (fuse) {
		while (lead < all.length && all[lead].kind === "channel") lead++;
		while (tailStart > lead && all[tailStart - 1].kind === "channel") tailStart--;
	}
	if (cut >= 0) tailStart = all.length;
	const leading = all.slice(0, lead);
	const middle = all.slice(lead, tailStart);
	const trailing = all.slice(tailStart);
	const channels = mode === "rgb" ? 3 : 1;
	const lutLinear = [];
	const tail = [];
	for (let c = 0; c < channels; c++) {
		const t = /* @__PURE__ */ new Float64Array(256);
		const f = chain(leading, c);
		for (let i = 0; i < 256; i++) t[i] = f(SRGB_TO_LINEAR[i]);
		lutLinear.push(t);
		tail.push(trailing.length > 0 ? new Quantizer(chain(trailing, c)) : new Quantizer());
	}
	if (cut >= 0) return {
		mode,
		lutLinear,
		middle,
		tail: [],
		lut8: null,
		grayFromColor: null,
		spatial: compileSpatial(stages.slice(cut), lutLinear, leading, middle.length === 0 && fuse, fuse)
	};
	let lut8 = null;
	if (middle.length === 0 && fuse) lut8 = lutLinear.map((t) => {
		const q = /* @__PURE__ */ new Uint8Array(256);
		for (let i = 0; i < 256; i++) q[i] = quantize(t[i]);
		return q;
	});
	let grayFromColor = null;
	if (mode === "gray") grayFromColor = fuse ? new Quantizer(chain(all, 0)) : new Quantizer();
	return {
		mode,
		lutLinear,
		middle,
		tail,
		lut8,
		grayFromColor,
		spatial: null
	};
}
/** `rest` starts with a spatial step. */
function compileSpatial(rest, lutLinear, leading, encodeTable, fuse) {
	const filters = [];
	for (const s of rest) if (s.kind === "sharpen") filters.push({
		stage: s,
		after: []
	});
	else filters[filters.length - 1].after.push(s);
	const last = filters[filters.length - 1];
	const [middle, trailing] = splitTail(last.after, fuse);
	last.after = [];
	const tailTakesEncoded = fuse && middle.length === 0;
	const tail = lutLinear.map((_, c) => {
		const f = chain(trailing, c);
		if (tailTakesEncoded) return new Quantizer((e) => f(srgbToLinear(e)));
		return trailing.length > 0 ? new Quantizer(f) : new Quantizer();
	});
	const lutEncoded = encodeTable ? lutLinear.map((t) => {
		const e = /* @__PURE__ */ new Float64Array(256);
		for (let i = 0; i < 256; i++) e[i] = linearToSrgb(t[i]);
		return e;
	}) : null;
	const stream = fuse && filters.length === 1;
	return {
		lead: chain(leading, 0),
		lutEncoded,
		filters,
		middle,
		tail,
		tailTakesEncoded,
		stream
	};
}
/** True when every pixel has R = G = B. Stops at the first colored pixel. */
function isMonochrome(data) {
	for (let i = 0; i < data.length; i += 4) {
		const r = data[i];
		if (data[i + 1] !== r || data[i + 2] !== r) return false;
	}
	return true;
}
/** Turns a requested color mode into the mode pixels are computed in. */
function resolveMode(data, colorMode = "auto") {
	if (colorMode === "auto") return isMonochrome(data) ? "gray" : "rgb";
	return colorMode;
}
function applyChannel(stages, v) {
	for (let k = 0; k < stages.length; k++) v = stages[k].fn(v, 0);
	return v;
}
/**
* Applies a program to RGBA pixels. `src` and `dst` must have the same length
* and may be the same array. Alpha is copied unchanged. `width` (pixels per
* row) is needed when the program has spatial steps.
*/
function processPixels(src, dst, program, width) {
	if (src.length !== dst.length) throw new RangeError("src and dst must have the same length");
	if (program.spatial) {
		const pixels = src.length >> 2;
		if (width === void 0 || !(width > 0) || pixels % width !== 0) throw new RangeError(`A program with sharpen needs the image width (got ${String(width)} for ${pixels} pixels).`);
		processSpatial(src, dst, program, program.spatial, width);
	} else if (program.mode === "gray") processGray(src, dst, program);
	else processRgb(src, dst, program);
}
function processRgb(src, dst, p) {
	const n = src.length;
	if (p.lut8) {
		const [qr, qg, qb] = p.lut8;
		for (let i = 0; i < n; i += 4) {
			dst[i] = qr[src[i]];
			dst[i + 1] = qg[src[i + 1]];
			dst[i + 2] = qb[src[i + 2]];
			dst[i + 3] = src[i + 3];
		}
		return;
	}
	const [lr, lg, lb] = p.lutLinear;
	const [tr, tg, tb] = p.tail;
	const middle = p.middle;
	const steps = middle.length;
	for (let i = 0; i < n; i += 4) {
		let r = lr[src[i]];
		let g = lg[src[i + 1]];
		let b = lb[src[i + 2]];
		for (let k = 0; k < steps; k++) {
			const s = middle[k];
			if (s.kind === "channel") {
				const fn = s.fn;
				r = fn(r, 0);
				g = fn(g, 1);
				b = fn(b, 2);
			} else {
				const y = LUMA_R * r + LUMA_G * g + LUMA_B * b;
				const f = s.factor;
				r = y + (r - y) * f;
				g = y + (g - y) * f;
				b = y + (b - y) * f;
			}
		}
		dst[i] = tr.quantize(r);
		dst[i + 1] = tg.quantize(g);
		dst[i + 2] = tb.quantize(b);
		dst[i + 3] = src[i + 3];
	}
}
/** Runs per-pixel steps on linear R, G, B in place in `v`. */
function runStages(stages, v) {
	for (let k = 0; k < stages.length; k++) {
		const s = stages[k];
		if (s.kind === "channel") {
			v[0] = s.fn(v[0], 0);
			v[1] = s.fn(v[1], 1);
			v[2] = s.fn(v[2], 2);
		} else {
			const y = LUMA_R * v[0] + LUMA_G * v[1] + LUMA_B * v[2];
			const f = s.factor;
			v[0] = y + (v[0] - y) * f;
			v[1] = y + (v[1] - y) * f;
			v[2] = y + (v[2] - y) * f;
		}
	}
}
function processSpatial(src, dst, p, sp, width) {
	const n = src.length >> 2;
	const channels = p.mode === "rgb" ? 3 : 1;
	if (sp.stream) {
		sharpenRows(src, width, channels, sp.filters[0].stage, (y, out, o) => head(src, p, sp, y * width, (y + 1) * width, out, o), (y, vals, o) => finish(src, dst, sp, y * width, (y + 1) * width, vals, o));
		return;
	}
	const planes = Array.from({ length: channels }, () => new Float32Array(n));
	head(src, p, sp, 0, n, planes, 0);
	const v = /* @__PURE__ */ new Float64Array(3);
	const [p0, p1, p2] = planes;
	for (const { stage, after } of sp.filters) {
		sharpenPlanes(planes, src, width, stage);
		if (after.length === 0) continue;
		for (let j = 0; j < n; j++) if (channels === 3) {
			v[0] = srgbToLinear(p0[j]);
			v[1] = srgbToLinear(p1[j]);
			v[2] = srgbToLinear(p2[j]);
			runStages(after, v);
			p0[j] = linearToSrgb(v[0]);
			p1[j] = linearToSrgb(v[1]);
			p2[j] = linearToSrgb(v[2]);
		} else p0[j] = linearToSrgb(applyChannel(after, srgbToLinear(p0[j])));
	}
	finish(src, dst, sp, 0, n, planes, 0);
}
/**
* Steps before the first spatial step for pixels j0..j1: input codes ->
* encoded values, written to `out[c]` from index `o`.
*/
function head(src, p, sp, j0, j1, out, o) {
	const [p0, p1, p2] = out;
	const enc = sp.lutEncoded;
	const lin = p.lutLinear;
	if (p.mode === "rgb" && enc) {
		const [e0, e1, e2] = enc;
		for (let j = j0, i = j0 * 4, k = o; j < j1; j++, i += 4, k++) {
			p0[k] = e0[src[i]];
			p1[k] = e1[src[i + 1]];
			p2[k] = e2[src[i + 2]];
		}
	} else if (p.mode === "rgb") {
		const [l0, l1, l2] = lin;
		const v = /* @__PURE__ */ new Float64Array(3);
		for (let j = j0, i = j0 * 4, k = o; j < j1; j++, i += 4, k++) {
			v[0] = l0[src[i]];
			v[1] = l1[src[i + 1]];
			v[2] = l2[src[i + 2]];
			runStages(p.middle, v);
			p0[k] = linearToSrgb(v[0]);
			p1[k] = linearToSrgb(v[1]);
			p2[k] = linearToSrgb(v[2]);
		}
	} else {
		const e0 = enc ? enc[0] : null;
		const l0 = lin[0];
		for (let j = j0, i = j0 * 4, k = o; j < j1; j++, i += 4, k++) {
			const r = src[i];
			const g = src[i + 1];
			const b = src[i + 2];
			if (r === g && g === b) p0[k] = e0 ? e0[r] : linearToSrgb(applyChannel(p.middle, l0[r]));
			else {
				const y = LUMA_R * SRGB_TO_LINEAR[r] + LUMA_G * SRGB_TO_LINEAR[g] + LUMA_B * SRGB_TO_LINEAR[b];
				p0[k] = linearToSrgb(applyChannel(p.middle, sp.lead(y)));
			}
		}
	}
}
/** Steps after the last spatial step for pixels j0..j1 (values in `vals[c]` from index `o`), then rounding to 8 bits. */
function finish(src, dst, sp, j0, j1, vals, o) {
	const { middle, tail, tailTakesEncoded } = sp;
	const [p0, p1, p2] = vals;
	if (vals.length === 3) {
		const [t0, t1, t2] = tail;
		const v = /* @__PURE__ */ new Float64Array(3);
		for (let i = j0 * 4, k = o, end = j1 * 4; i < end; i += 4, k++) {
			if (tailTakesEncoded) {
				dst[i] = t0.quantize(p0[k]);
				dst[i + 1] = t1.quantize(p1[k]);
				dst[i + 2] = t2.quantize(p2[k]);
			} else {
				v[0] = srgbToLinear(p0[k]);
				v[1] = srgbToLinear(p1[k]);
				v[2] = srgbToLinear(p2[k]);
				runStages(middle, v);
				dst[i] = t0.quantize(v[0]);
				dst[i + 1] = t1.quantize(v[1]);
				dst[i + 2] = t2.quantize(v[2]);
			}
			dst[i + 3] = src[i + 3];
		}
	} else {
		const t0 = tail[0];
		for (let i = j0 * 4, k = o, end = j1 * 4; i < end; i += 4, k++) {
			const out = tailTakesEncoded ? t0.quantize(p0[k]) : t0.quantize(applyChannel(middle, srgbToLinear(p0[k])));
			dst[i] = out;
			dst[i + 1] = out;
			dst[i + 2] = out;
			dst[i + 3] = src[i + 3];
		}
	}
}
function processGray(src, dst, p) {
	const n = src.length;
	const q = p.lut8 ? p.lut8[0] : null;
	const lin = p.lutLinear[0];
	const tail = p.tail[0];
	const middle = p.middle;
	const fromColor = p.grayFromColor;
	const colorSteps = q ? [] : middle;
	for (let i = 0; i < n; i += 4) {
		const r = src[i];
		const g = src[i + 1];
		const b = src[i + 2];
		let out;
		if (r === g && g === b) out = q ? q[r] : tail.quantize(applyChannel(middle, lin[r]));
		else {
			const y = LUMA_R * SRGB_TO_LINEAR[r] + LUMA_G * SRGB_TO_LINEAR[g] + LUMA_B * SRGB_TO_LINEAR[b];
			out = fromColor.quantize(applyChannel(colorSteps, y));
		}
		dst[i] = out;
		dst[i + 1] = out;
		dst[i + 2] = out;
		dst[i + 3] = src[i + 3];
	}
}
/**
* Luminance of RGBA pixels as one 8-bit channel. Gray pixels (R = G = B) keep
* their value; colored pixels use Rec. 709 luminance computed in linear light.
*/
function extractGray(data) {
	const out = new Uint8ClampedArray(data.length >> 2);
	for (let i = 0, j = 0; i < data.length; i += 4, j++) {
		const r = data[i];
		const g = data[i + 1];
		const b = data[i + 2];
		out[j] = r === g && g === b ? r : quantize(LUMA_R * SRGB_TO_LINEAR[r] + LUMA_G * SRGB_TO_LINEAR[g] + LUMA_B * SRGB_TO_LINEAR[b]);
	}
	return out;
}
//#endregion
export { compile, extractGray, forGray, isMonochrome, processPixels, resolveMode };

//# sourceMappingURL=process.js.map