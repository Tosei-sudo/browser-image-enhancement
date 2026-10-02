import { LUMA_B, LUMA_G, LUMA_R, linearToSrgb, srgbToLinear } from "../color/srgb.js";
import { warn } from "../warn.js";
//#region src/ops/index.ts
/**
* Correction definitions: parameter normalization and the per-pixel math.
*
* All math runs on linear-light values (see color/srgb.ts). Values may leave
* [0, 1] between steps; they are clamped only when quantized to 8 bits at the end.
* `sharpen` is the one step that reads neighbouring pixels; core/filter.ts runs it.
*/
/** Corrections that only make sense for color images; no-ops on monochrome input. */
const COLOR_ONLY_OPS = /* @__PURE__ */ new Set(["saturation", "temperature"]);
/** Contrast pivots around sRGB 50 % gray so mid-gray stays put. */
const CONTRAST_PIVOT = srgbToLinear(.5);
/** Strength of `temperature`: at +1 red gain is 1.4x and blue 0.6x before luminance normalization. */
const TEMPERATURE_STRENGTH = .4;
function num(name, value, min, max, fallback) {
	if (typeof value !== "number" || Number.isNaN(value)) {
		if (value !== void 0) warn(`${name} must be a number, got ${String(value)}; using ${fallback}.`);
		return fallback;
	}
	if (value < min || value > max) {
		const clamped = Math.min(max, Math.max(min, value));
		warn(`${name} ${value} is out of range [${min}, ${max}]; clamped to ${clamped}.`);
		return clamped;
	}
	return value;
}
/** Validates and clamps a levels parameter object, filling defaults. */
function normalizeLevels(o = {}) {
	let inBlack = num("levels.inBlack", o.inBlack, 0, 1, 0);
	let inWhite = num("levels.inWhite", o.inWhite, 0, 1, 1);
	if (inWhite <= inBlack) {
		const gap = 1 / 255;
		const before = `inBlack ${inBlack}, inWhite ${inWhite}`;
		if (inBlack + gap <= 1) inWhite = inBlack + gap;
		else [inBlack, inWhite] = [.996078431372549, 1];
		warn(`levels.inWhite must be greater than inBlack (${before}); using inBlack ${inBlack}, inWhite ${inWhite}.`);
	}
	return {
		inBlack,
		inWhite,
		gamma: num("levels.gamma", o.gamma, .1, 10, 1),
		outBlack: num("levels.outBlack", o.outBlack, 0, 1, 0),
		outWhite: num("levels.outWhite", o.outWhite, 0, 1, 1)
	};
}
/** Upper bound for stretch points: far above white, but finite. */
const STRETCH_MAX = 1e3;
function rgb(name, value, fallback) {
	if (Array.isArray(value)) {
		if (value.length !== 3) warn(`${name} must be one number or [R, G, B], got ${value.length} values.`);
		return [
			0,
			1,
			2
		].map((c) => num(`${name}[${c}]`, value[c], 0, STRETCH_MAX, fallback));
	}
	const v = num(name, value, 0, STRETCH_MAX, fallback);
	return [
		v,
		v,
		v
	];
}
/** Validates stretch points. A channel whose white is not above its black is left unchanged. */
function normalizeStretch(o = {}) {
	const black = rgb("stretch.black", o.black, 0);
	const white = rgb("stretch.white", o.white, 1);
	for (let c = 0; c < 3; c++) if (!(white[c] > black[c])) {
		warn(`stretch.white must be greater than black (channel ${c}: ${black[c]}, ${white[c]}); leaving the channel unchanged.`);
		black[c] = 0;
		white[c] = 1;
	}
	return {
		black,
		white
	};
}
/** Validates sharpening options, filling defaults. */
function normalizeSharpen(o = {}) {
	return {
		amount: num("sharpen.amount", o.amount, 0, 5, .5),
		radius: num("sharpen.radius", o.radius, .1, 50, 1),
		threshold: num("sharpen.threshold", o.threshold, 0, 1, 0)
	};
}
/** How far (in pixels) the blur of a sharpen step with this radius reaches. */
function kernelRadius(radius) {
	return Math.ceil(3 * radius);
}
/**
* Pixels of context the steps need on each side: a pixel's result depends
* only on input pixels at most this far away (0 when every step is per-pixel).
* An image cut into tiles or strips gives exactly the same pixels as the
* whole image when each part is processed with this much margin around it.
*/
function marginOf(ops) {
	let m = 0;
	for (const op of ops) if (op.op === "sharpen" && !isIdentity(op)) m += kernelRadius(op.radius);
	return m;
}
const STRETCH_METHODS = [
	"percentClip",
	"minMax",
	"standardDeviation"
];
/** Validates automatic stretch options, filling defaults. */
function normalizeAutoStretch(o = {}) {
	let method = "percentClip";
	if (o.method !== void 0) {
		if (STRETCH_METHODS.includes(o.method)) method = o.method;
		else warn(`autoStretch.method must be one of ${STRETCH_METHODS.join(", ")}, got ${String(o.method)}; using percentClip.`);
	}
	return {
		method,
		lowPercent: num("autoStretch.lowPercent", o.lowPercent, 0, 50, .5),
		highPercent: num("autoStretch.highPercent", o.highPercent, 0, 50, .5),
		stdDevs: num("autoStretch.stdDevs", o.stdDevs, .1, 10, 2),
		linked: o.linked === void 0 ? false : Boolean(o.linked)
	};
}
/**
* Validates an op (from code or from JSON) and clamps its parameters.
* Throws only for an unknown op name, since that cannot be repaired.
*/
function normalizeOp(raw) {
	const o = raw ?? {};
	switch (o.op) {
		case "brightness":
		case "contrast":
		case "saturation":
		case "temperature": return {
			op: o.op,
			amount: num(`${o.op}`, o.amount, -1, 1, 0)
		};
		case "exposure": return {
			op: "exposure",
			ev: num("exposure", o.ev, -10, 10, 0)
		};
		case "gamma": return {
			op: "gamma",
			gamma: num("gamma", o.gamma, .1, 10, 1)
		};
		case "levels": return {
			op: "levels",
			...normalizeLevels(o)
		};
		case "stretch": return {
			op: "stretch",
			...normalizeStretch(o)
		};
		case "autoStretch": return {
			op: "autoStretch",
			...normalizeAutoStretch(o)
		};
		case "sharpen": return {
			op: "sharpen",
			...normalizeSharpen(o)
		};
		default: throw new TypeError(`Unknown correction: ${String(o.op)}`);
	}
}
/** True when the op leaves every pixel unchanged, so it can be skipped. */
function isIdentity(op) {
	switch (op.op) {
		case "brightness":
		case "contrast":
		case "saturation":
		case "temperature": return op.amount === 0;
		case "exposure": return op.ev === 0;
		case "gamma": return op.gamma === 1;
		case "levels": return op.inBlack === 0 && op.inWhite === 1 && op.gamma === 1 && op.outBlack === 0 && op.outWhite === 1;
		case "stretch": return op.black.every((b, c) => b === 0 && op.white[c] === 1);
		case "autoStretch": return false;
		case "sharpen": return op.amount === 0;
	}
}
/** Builds the math for a normalized op. */
function toStage(op) {
	switch (op.op) {
		case "brightness": {
			const b = op.amount;
			if (b === 1) return {
				kind: "channel",
				fn: () => 1
			};
			if (b === -1) return {
				kind: "channel",
				fn: () => 0
			};
			const s = 1 - Math.abs(b);
			const offset = b > 0 ? b : 0;
			return {
				kind: "channel",
				fn: (v) => v * s + offset
			};
		}
		case "contrast": {
			const c = op.amount;
			const k = c >= 0 ? 1 / Math.max(1 - c, 1 / 1024) : 1 + c;
			const p = CONTRAST_PIVOT;
			return {
				kind: "channel",
				fn: (v) => v > 0 ? p * Math.pow(v / p, k) : 0
			};
		}
		case "exposure": {
			const m = Math.pow(2, op.ev);
			return {
				kind: "channel",
				fn: (v) => v * m
			};
		}
		case "gamma": {
			const e = 1 / op.gamma;
			return {
				kind: "channel",
				fn: (v) => v > 0 ? Math.pow(v, e) : 0
			};
		}
		case "saturation": return {
			kind: "saturation",
			factor: 1 + op.amount
		};
		case "temperature": {
			const r = 1 + TEMPERATURE_STRENGTH * op.amount;
			const b = 1 - TEMPERATURE_STRENGTH * op.amount;
			const n = LUMA_R * r + LUMA_G + LUMA_B * b;
			const gains = [
				r / n,
				1 / n,
				b / n
			];
			return {
				kind: "channel",
				fn: (v, c) => v * gains[c]
			};
		}
		case "levels": {
			const { inBlack, inWhite, outBlack, outWhite } = op;
			const inRange = inWhite - inBlack;
			const outRange = outWhite - outBlack;
			const e = 1 / op.gamma;
			return {
				kind: "channel",
				fn: (v) => {
					let x = (linearToSrgb(v) - inBlack) / inRange;
					x = x <= 0 ? 0 : x >= 1 ? 1 : Math.pow(x, e);
					return srgbToLinear(outBlack + x * outRange);
				}
			};
		}
		case "stretch": {
			const black = op.black;
			const scale = op.black.map((b, c) => 1 / (op.white[c] - b));
			return {
				kind: "channel",
				fn: (v, c) => {
					const x = (linearToSrgb(v) - black[c]) * scale[c];
					return x <= 0 ? 0 : x >= 1 ? 1 : srgbToLinear(x);
				}
			};
		}
		case "sharpen": return {
			kind: "sharpen",
			amount: op.amount,
			radius: op.radius,
			threshold: op.threshold
		};
		case "autoStretch": throw new Error("autoStretch has no fixed math; resolve it with image statistics first.");
	}
}
//#endregion
export { COLOR_ONLY_OPS, isIdentity, kernelRadius, marginOf, normalizeAutoStretch, normalizeLevels, normalizeOp, normalizeSharpen, normalizeStretch, toStage };

//# sourceMappingURL=index.js.map