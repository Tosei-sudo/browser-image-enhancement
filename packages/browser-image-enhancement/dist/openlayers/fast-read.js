//#region src/openlayers/fast-read.ts
const hostLittleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const patched = /* @__PURE__ */ new WeakSet();
/** Makes `image` (a geotiff.js `GeoTIFFImage`) copy decoded tiles with typed arrays where it can. */
function fastReadRasters(image) {
	const img = image;
	if (!img || typeof img._readRaster !== "function" || typeof img.getTileOrStrip !== "function" || patched.has(img)) return;
	patched.add(img);
	const original = img._readRaster;
	img._readRaster = function(imageWindow, samples, valueArrays, interleave, poolOrDecoder, width, height, resampleMethod, signal) {
		const plan = interleave || !Array.isArray(valueArrays) ? null : planFor(this, imageWindow, samples, valueArrays, width, height);
		if (!plan) return original.call(this, imageWindow, samples, valueArrays, interleave, poolOrDecoder, width, height, resampleMethod, signal);
		return readFast(this, plan, imageWindow, samples, valueArrays, poolOrDecoder, signal);
	};
}
function planFor(img, imageWindow, samples, arrays, width, height) {
	if (width && imageWindow[2] - imageWindow[0] !== width || height && imageWindow[3] - imageWindow[1] !== height) return null;
	const bits = img.fileDirectory.getValue("BitsPerSample");
	const formats = img.fileDirectory.getValue("SampleFormat");
	if (!bits || typeof bits !== "object") return null;
	const planar = img.planarConfiguration;
	if (planar !== 1 && planar !== 2) return null;
	const ctors = [];
	const offsets = [];
	let size = 0;
	for (let i = 0; i < samples.length; i++) {
		const s = samples[i];
		const b = bits[s];
		if ((formats?.[s] ?? formats?.[0] ?? 1) === 3 && b === 16) return null;
		if (b !== 8 && b !== 16 && b !== 32 && b !== 64) return null;
		if (b > 8 && img.littleEndian !== hostLittleEndian) return null;
		const ctor = arrays[i].constructor;
		if (ctor.BYTES_PER_ELEMENT !== b / 8) return null;
		if (size && size !== b / 8) return null;
		size = b / 8;
		ctors.push(ctor);
		if (planar === 1) {
			let bitOffset = 0;
			for (let k = 0; k < s; k++) bitOffset += bits[k];
			if (bitOffset % b !== 0) return null;
			offsets.push(bitOffset / b);
		} else offsets.push(0);
	}
	if (!size) return null;
	if (planar === 1) {
		const bytesPerPixel = img.getBytesPerPixel();
		if (bytesPerPixel % size !== 0) return null;
		return {
			stride: bytesPerPixel / size,
			offsets,
			ctors
		};
	}
	return {
		stride: 1,
		offsets,
		ctors
	};
}
async function readFast(img, plan, imageWindow, samples, arrays, poolOrDecoder, signal) {
	const tileWidth = img.getTileWidth();
	const tileHeight = img.getTileHeight();
	const imageWidth = img.getWidth();
	const imageHeight = img.getHeight();
	const minXTile = Math.max(Math.floor(imageWindow[0] / tileWidth), 0);
	const maxXTile = Math.min(Math.ceil(imageWindow[2] / tileWidth), Math.ceil(imageWidth / tileWidth));
	const minYTile = Math.max(Math.floor(imageWindow[1] / tileHeight), 0);
	const maxYTile = Math.min(Math.ceil(imageWindow[3] / tileHeight), Math.ceil(imageHeight / tileHeight));
	const windowWidth = imageWindow[2] - imageWindow[0];
	const { stride, offsets, ctors } = plan;
	const reads = [];
	for (let yTile = minYTile; yTile < maxYTile; yTile++) for (let xTile = minXTile; xTile < maxXTile; xTile++) {
		const perSample = img.planarConfiguration === 2;
		const tiles = perSample ? samples.map((s) => img.getTileOrStrip(xTile, yTile, s, poolOrDecoder, signal)) : [img.getTileOrStrip(xTile, yTile, 0, poolOrDecoder, signal)];
		for (let si = 0; si < samples.length; si++) reads.push(tiles[perSample ? si : 0].then((tile) => {
			const blockHeight = img.getBlockHeight(tile.y);
			const firstLine = tile.y * tileHeight;
			const firstCol = tile.x * tileWidth;
			const ymax = Math.min(blockHeight, blockHeight - (firstLine + blockHeight - imageWindow[3]), imageHeight - firstLine);
			const xmax = Math.min(tileWidth, tileWidth - ((tile.x + 1) * tileWidth - imageWindow[2]), imageWidth - firstCol);
			const xmin = Math.max(0, imageWindow[0] - firstCol);
			const ctor = ctors[si];
			const element = ctor.BYTES_PER_ELEMENT;
			const src = new ctor(tile.data, 0, Math.floor(tile.data.byteLength / element));
			const dst = arrays[si];
			const offset = offsets[si];
			for (let y = Math.max(0, imageWindow[1] - firstLine); y < ymax; y++) {
				let d = (y + firstLine - imageWindow[1]) * windowWidth + xmin + firstCol - imageWindow[0];
				let s = (y * tileWidth + xmin) * stride + offset;
				if (stride === 1) {
					dst.set(src.subarray(s, s + xmax - xmin), d);
					continue;
				}
				for (let x = xmin; x < xmax; x++, s += stride) dst[d++] = src[s];
			}
		}));
	}
	await Promise.all(reads);
	const result = arrays;
	result.width = windowWidth;
	result.height = imageWindow[3] - imageWindow[1];
	return result;
}
//#endregion
export { fastReadRasters };

//# sourceMappingURL=fast-read.js.map