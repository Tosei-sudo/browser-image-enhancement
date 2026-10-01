import { assertImageData } from "./workers/src/image.js";
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
//#endregion
export { computeStretch, histogram, mergeHistograms };

//# sourceMappingURL=stats.js.map