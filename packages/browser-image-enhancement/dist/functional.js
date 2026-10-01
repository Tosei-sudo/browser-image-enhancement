import { assertImageData, createImageData } from "./core/image.js";
import { warn } from "./warn.js";
import { normalizeOp } from "./ops/index.js";
import { compile, processPixels, resolveMode } from "./core/process.js";
//#region src/functional.ts
/**
* Functional API: one synchronous correction per call, on the calling thread.
*
* Each call returns a new ImageData and leaves its input untouched. Chaining
* calls rounds to 8 bits after every step; use `pipeline()` to chain without
* intermediate rounding.
*/
/** Runs normalized-or-raw ops on an image synchronously. Shared by the pipeline's sync path. */
function applySync(image, ops, options = {}) {
	assertImageData(image);
	const normalized = ops.map(normalizeOp);
	const mode = resolveMode(image.data, options.colorMode);
	if (mode === "gray") warnColorOnly(normalized);
	const out = new Uint8ClampedArray(image.data.length);
	processPixels(image.data, out, compile(normalized, mode));
	return createImageData(out, image.width, image.height);
}
/** Warns when saturation/temperature are requested for an image computed as gray. */
function warnColorOnly(ops) {
	const ignored = ops.filter((op) => (op.op === "saturation" || op.op === "temperature") && op.amount !== 0).map((op) => op.op);
	if (ignored.length > 0) warn(`${ignored.join(", ")} has no effect on a monochrome image. Pass colorMode: 'rgb' to tint it.`);
}
/** Brightness, -1 to 1. Positive moves toward white, negative toward black. */
function brightness(image, amount, options) {
	return applySync(image, [{
		op: "brightness",
		amount
	}], options);
}
/** Contrast around mid-gray, -1 (flat gray) to 1 (threshold). */
function contrast(image, amount, options) {
	return applySync(image, [{
		op: "contrast",
		amount
	}], options);
}
/** Exposure in EV stops, -10 to 10. +1 doubles the light. */
function exposure(image, ev, options) {
	return applySync(image, [{
		op: "exposure",
		ev
	}], options);
}
/** Gamma, 0.1 to 10. Values above 1 brighten midtones. */
function gamma(image, value, options) {
	return applySync(image, [{
		op: "gamma",
		gamma: value
	}], options);
}
/** Saturation, -1 (grayscale) to 1 (double). No effect on monochrome images. */
function saturation(image, amount, options) {
	return applySync(image, [{
		op: "saturation",
		amount
	}], options);
}
/** Color temperature, -1 (cooler/bluer) to 1 (warmer/yellower). No effect on monochrome images. */
function temperature(image, amount, options) {
	return applySync(image, [{
		op: "temperature",
		amount
	}], options);
}
/** Levels: input/output black and white points (0-1, sRGB-encoded) and midtone gamma. */
function levels(image, params, options) {
	return applySync(image, [{
		op: "levels",
		...params
	}], options);
}
//#endregion
export { applySync, brightness, contrast, exposure, gamma, levels, saturation, temperature, warnColorOnly };

//# sourceMappingURL=functional.js.map