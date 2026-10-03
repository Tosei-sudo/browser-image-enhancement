//#region src/openlayers/margin.ts
/**
* The centre tile (`width` x `height`) with `margin` pixels of its neighbours
* on every side. Where there is no neighbour the margin is transparent, which
* the library treats exactly like the edge of the image.
*/
function withMargin(tile, width, height, margin) {
	const W = width + 2 * margin;
	const H = height + 2 * margin;
	const out = new Uint8ClampedArray(W * H * 4);
	const nx = Math.ceil(margin / width);
	const ny = Math.ceil(margin / height);
	for (let dy = -ny; dy <= ny; dy++) for (let dx = -nx; dx <= nx; dx++) {
		const x0 = Math.max(0, margin + dx * width);
		const x1 = Math.min(W, margin + (dx + 1) * width);
		const y0 = Math.max(0, margin + dy * height);
		const y1 = Math.min(H, margin + (dy + 1) * height);
		if (x1 <= x0 || y1 <= y0) continue;
		const src = tile(dx, dy);
		if (!src) continue;
		const sx = x0 - (margin + dx * width);
		for (let y = y0; y < y1; y++) {
			const from = ((y - (margin + dy * height)) * width + sx) * 4;
			out.set(src.subarray(from, from + (x1 - x0) * 4), (y * W + x0) * 4);
		}
	}
	return out;
}
/** The centre `width` x `height` pixels of an image padded by `margin` on every side. */
function cropMargin(padded, width, height, margin) {
	if (margin === 0) return padded;
	const W = width + 2 * margin;
	const out = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		const from = ((y + margin) * W + margin) * 4;
		out.set(padded.subarray(from, from + width * 4), y * width * 4);
	}
	return out;
}
//#endregion
export { cropMargin, withMargin };

//# sourceMappingURL=margin.js.map