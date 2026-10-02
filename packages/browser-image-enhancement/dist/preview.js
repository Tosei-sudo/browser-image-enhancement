import { createImageData } from "./workers/src/image.js";
import { createCanvas, toCanvas } from "./workers/src/io.js";
//#region src/preview.ts
/** Shrinking images for fast previews. */
/** The size an image of `width` x `height` is shown at when its longer side may be at most `maxSize`. */
function previewSize(width, height, maxSize) {
	const scale = Math.min(1, maxSize / Math.max(width, height));
	if (!(scale < 1)) return {
		width,
		height,
		scale: 1
	};
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
		scale
	};
}
/**
* Returns `image` shrunk (with the browser's high-quality smoothing) so its
* longer side is at most `maxSize`, or `image` itself when it already fits.
*/
function downscale(image, maxSize) {
	const size = previewSize(image.width, image.height, maxSize);
	if (size.scale === 1) return {
		image,
		scale: 1
	};
	const ctx = createCanvas(size.width, size.height).getContext("2d", {
		colorSpace: "srgb",
		willReadFrequently: true
	});
	if (!ctx) throw new Error("Could not get a 2D canvas context.");
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";
	ctx.drawImage(toCanvas(image), 0, 0, size.width, size.height);
	const d = ctx.getImageData(0, 0, size.width, size.height);
	return {
		image: createImageData(d.data, d.width, d.height),
		scale: d.width / image.width
	};
}
//#endregion
export { downscale, previewSize };

//# sourceMappingURL=preview.js.map