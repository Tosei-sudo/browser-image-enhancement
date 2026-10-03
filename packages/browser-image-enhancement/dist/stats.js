import { assertImageData } from "./workers/src/image.js";
import { SRGB_TO_LINEAR, linearToSrgb } from "./color/srgb.js";
import { resolveMode } from "./core/process.js";
import { countPixels, mergeHistograms, stretchRange } from "./core/histogram.js";
//#region src/stats.ts
/**
* Public statistics API: histograms of images or parts of them, and the
* stretch range they give.
*/
/**
* Histogram of 8-bit sRGB codes, skipping transparent pixels (alpha 0).
* Monochrome images (or `colorMode: 'gray'`) give one luminance channel.
*/
function histogram(image, options = {}) {
	assertImageData(image);
	return countPixels(image.data, image.width, resolveMode(image.data, options.colorMode), options.rect);
}
/**
* The black and white points (sRGB-encoded, per channel) `autoStretch` would
* use for an image with this histogram, as the first step of a pipeline.
*/
function computeStretch(stats, options) {
	return stretchRange(stats, options);
}
/**
* The average color around pixel (`x`, `y`), as sRGB-encoded `[R, G, B]` in
* 0-1, averaged in linear light and skipping transparent pixels. Pass it to
* `whiteBalance` to make that spot neutral gray. Null when every pixel there
* is transparent or the point is outside the image.
*
* @example
* ```ts
* canvas.onclick = (e) => {
*   const [r, g, b] = sampleColor(image, e.offsetX, e.offsetY) ?? [0.5, 0.5, 0.5];
*   p = p.set('whiteBalance', { r, g, b });
* };
* ```
*/
function sampleColor(image, x, y, options = {}) {
	assertImageData(image);
	const r = Math.max(0, Math.floor(options.radius ?? 2));
	const cx = Math.floor(x);
	const cy = Math.floor(y);
	const sum = [
		0,
		0,
		0
	];
	let n = 0;
	for (let py = Math.max(0, cy - r); py <= Math.min(image.height - 1, cy + r); py++) for (let px = Math.max(0, cx - r); px <= Math.min(image.width - 1, cx + r); px++) {
		const i = (py * image.width + px) * 4;
		if (image.data[i + 3] === 0) continue;
		for (let c = 0; c < 3; c++) sum[c] += SRGB_TO_LINEAR[image.data[i + c]];
		n++;
	}
	if (n === 0) return null;
	return sum.map((v) => linearToSrgb(v / n));
}
//#endregion
export { computeStretch, histogram, mergeHistograms, sampleColor };

//# sourceMappingURL=stats.js.map