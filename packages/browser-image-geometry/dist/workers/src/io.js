import { createImageData } from "./image.js";
//#region ../workers/src/io.ts
/**
* Converting browser image sources to sRGB pixels and back.
*/
function createCanvas(width, height) {
	if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
	if (typeof document !== "undefined") {
		const c = document.createElement("canvas");
		c.width = width;
		c.height = height;
		return c;
	}
	throw new Error("No canvas implementation is available in this environment.");
}
function context2d(canvas) {
	const ctx = canvas.getContext("2d", {
		colorSpace: "srgb",
		willReadFrequently: true
	});
	if (!ctx) throw new Error("Could not get a 2D canvas context.");
	return ctx;
}
function isImageDataLike(input) {
	return typeof input === "object" && input !== null && input.data instanceof Uint8ClampedArray && typeof input.width === "number" && typeof input.height === "number";
}
function sizeOf(source) {
	if (typeof HTMLImageElement !== "undefined" && source instanceof HTMLImageElement) return {
		width: source.naturalWidth,
		height: source.naturalHeight
	};
	if (typeof HTMLVideoElement !== "undefined" && source instanceof HTMLVideoElement) return {
		width: source.videoWidth,
		height: source.videoHeight
	};
	const s = source;
	return {
		width: s.width,
		height: s.height
	};
}
function drawToImageData(source) {
	const { width, height } = sizeOf(source);
	if (!(width > 0 && height > 0)) throw new RangeError("The image has no pixels (is it loaded?).");
	const ctx = context2d(createCanvas(width, height));
	ctx.drawImage(source, 0, 0);
	return ctx.getImageData(0, 0, width, height, { colorSpace: "srgb" });
}
/**
* Reads any supported input as sRGB ImageData. Pixels in other color spaces
* (for example Display P3) are converted to sRGB by the browser. EXIF
* orientation of encoded images is applied.
*/
async function toImageData(input) {
	if (isImageDataLike(input)) {
		if (!input.colorSpace || input.colorSpace === "srgb") return input;
		const ctx = createCanvas(input.width, input.height).getContext("2d", {
			colorSpace: input.colorSpace,
			willReadFrequently: true
		});
		if (!ctx) throw new Error("Could not get a 2D canvas context.");
		ctx.putImageData(input, 0, 0);
		return ctx.getImageData(0, 0, input.width, input.height, { colorSpace: "srgb" });
	}
	if (typeof Blob !== "undefined" && input instanceof Blob) {
		const bitmap = await createImageBitmap(input, { imageOrientation: "from-image" }).catch((e) => {
			if (e instanceof TypeError) return createImageBitmap(input);
			throw e;
		});
		try {
			return drawToImageData(bitmap);
		} finally {
			bitmap.close();
		}
	}
	if (typeof HTMLImageElement !== "undefined" && input instanceof HTMLImageElement && !input.complete) await input.decode();
	return drawToImageData(input);
}
function toCanvas(image) {
	const canvas = typeof document !== "undefined" ? createHtmlCanvas(image.width, image.height) : createCanvas(image.width, image.height);
	context2d(canvas).putImageData(asImageData(image), 0, 0);
	return canvas;
}
function createHtmlCanvas(width, height) {
	const c = document.createElement("canvas");
	c.width = width;
	c.height = height;
	return c;
}
function asImageData(image) {
	return typeof ImageData !== "undefined" && image instanceof ImageData ? image : createImageData(image.data, image.width, image.height);
}
async function toBlob(image, type = "image/png", quality) {
	const canvas = createCanvas(image.width, image.height);
	context2d(canvas).putImageData(asImageData(image), 0, 0);
	if ("convertToBlob" in canvas) return canvas.convertToBlob({
		type,
		quality
	});
	return new Promise((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(/* @__PURE__ */ new Error("Could not encode the image.")), type, quality));
}
//#endregion
export { createCanvas, toBlob, toCanvas, toImageData };

//# sourceMappingURL=io.js.map