import { rotation, scaling } from "./transform.js";
import { assertImageData, createImageData } from "./workers/src/image.js";
import { planWarp } from "./plan.js";
import { renderPlan } from "./render.js";
//#region src/functional.ts
/**
* Synchronous API: takes sRGB `ImageData`, returns new `ImageData`, runs on the
* calling thread. Use `warp()` to run in workers.
*/
const HINT = "Use warp(), which converts other color spaces to sRGB.";
/** Applies `transform` to `image` on the calling thread. */
function warpImageData(image, transform, options = {}) {
	assertImageData(image, HINT);
	const plan = planWarp(image.width, image.height, transform, options);
	return {
		image: renderPlan(image, plan),
		width: plan.width,
		height: plan.height,
		geoTransform: plan.geoTransform,
		extent: plan.extent
	};
}
/** Rotates by `degrees`, clockwise, about the image center. */
function rotate(image, degrees, options = {}) {
	assertImageData(image, HINT);
	if (!Number.isFinite(degrees)) throw new RangeError("`degrees` must be a finite number.");
	const { width, height } = image;
	const t = rotation(degrees, [width / 2, height / 2]);
	const base = {
		resample: options.resample,
		background: options.background,
		yUp: false
	};
	return warpImageData(image, t, options.expand === false ? {
		...base,
		extent: [
			0,
			0,
			width,
			height
		],
		width,
		height
	} : {
		...base,
		pixelSize: 1
	}).image;
}
/** Mirrors the image. Exact: pixels are moved, not resampled. */
function flip(image, direction = "horizontal") {
	assertImageData(image, HINT);
	if (direction !== "horizontal" && direction !== "vertical" && direction !== "both") throw new TypeError(`Unknown flip direction: ${String(direction)}`);
	const { width, height, data } = image;
	const out = new Uint8ClampedArray(data.length);
	const h = direction !== "vertical";
	const v = direction !== "horizontal";
	for (let y = 0; y < height; y++) {
		const sy = v ? height - 1 - y : y;
		for (let x = 0; x < width; x++) {
			const sx = h ? width - 1 - x : x;
			const s = (sy * width + sx) * 4;
			const o = (y * width + x) * 4;
			out[o] = data[s];
			out[o + 1] = data[s + 1];
			out[o + 2] = data[s + 2];
			out[o + 3] = data[s + 3];
		}
	}
	return createImageData(out, width, height);
}
/** Cuts out a rectangle (whole pixels, inside the image). Exact. */
function crop(image, rect) {
	assertImageData(image, HINT);
	const { x, y, width, height } = rect ?? {};
	if (![
		x,
		y,
		width,
		height
	].every(Number.isInteger) || width < 1 || height < 1) throw new RangeError("The crop rectangle needs whole-pixel x, y, width and height (width and height at least 1).");
	if (x < 0 || y < 0 || x + width > image.width || y + height > image.height) throw new RangeError(`The crop rectangle ${width}x${height}+${x}+${y} is outside the ${image.width}x${image.height} image.`);
	const out = new Uint8ClampedArray(width * height * 4);
	for (let j = 0; j < height; j++) {
		const s = ((y + j) * image.width + x) * 4;
		out.set(image.data.subarray(s, s + width * 4), j * width * 4);
	}
	return createImageData(out, width, height);
}
/** Scales to exactly `width` × `height` pixels. */
function resize(image, width, height, options = {}) {
	assertImageData(image, HINT);
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError("`width` and `height` must be whole numbers of at least 1.");
	return warpImageData(image, scaling(width / image.width, height / image.height), {
		resample: options.resample,
		extent: [
			0,
			0,
			width,
			height
		],
		width,
		height,
		yUp: false,
		edges: "clamp"
	}).image;
}
//#endregion
export { crop, flip, resize, rotate, warpImageData };

//# sourceMappingURL=functional.js.map