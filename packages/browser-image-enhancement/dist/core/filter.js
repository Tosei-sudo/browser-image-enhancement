import { LUMA_B, LUMA_G, LUMA_R } from "../color/srgb.js";
import { kernelRadius } from "../ops/index.js";
//#region src/core/filter.ts
/**
* Steps that read neighbouring pixels: the unsharp mask.
*
* They run on planes of sRGB-encoded values (one Float32Array per channel,
* not clamped), between the per-pixel steps before and after them.
*
* The blur is a separable Gaussian weighted by alpha: transparent pixels
* (nodata) contribute nothing, and pixels outside the buffer count as
* transparent. So a pixel's result depends only on the input within
* `kernelRadius(radius)` pixels of it, and a strip or tile processed with that
* much margin around it gives exactly the pixels the whole image would. Every
* sum is taken in the same order however the image is cut, which keeps the
* results equal bit for bit, not just close.
*/
/** Gaussian weights for offsets -r..r. They need not sum to 1; the blur divides by the weight it used. */
function gaussian(radius) {
	const r = kernelRadius(radius);
	const k = new Float64Array(2 * r + 1);
	const s = 2 * radius * radius;
	for (let i = -r; i <= r; i++) k[i + r] = Math.exp(-(i * i) / s);
	return k;
}
/**
* Sharpens `planes` (sRGB-encoded, one per channel: 3 for RGB, 1 for gray) in
* place. `rgba` supplies alpha; pixels with alpha 0 are left unchanged.
*/
function sharpenPlanes(planes, rgba, width, stage) {
	const n = planes[0].length;
	const height = width > 0 ? n / width : 0;
	const k = gaussian(stage.radius);
	const r = k.length - 1 >> 1;
	const [p0, p1, p2] = planes;
	const rgb = planes.length === 3;
	/** Luminance of row `y` into `out`. */
	const lumaRow = (y, out) => {
		const row = y * width;
		if (rgb) for (let x = 0; x < width; x++) out[x] = LUMA_R * p0[row + x] + LUMA_G * p1[row + x] + LUMA_B * p2[row + x];
		else for (let x = 0; x < width; x++) out[x] = p0[row + x];
	};
	const span = 2 * r + 1;
	const hN = new Float64Array(span * width);
	const hD = new Float64Array(span * width);
	const lum = new Float64Array(width);
	const wy = new Float64Array(width);
	const w = new Float64Array(width);
	const horizontal = (y) => {
		lumaRow(y, lum);
		const row = y * width;
		for (let x = 0; x < width; x++) {
			const a = rgba[(row + x) * 4 + 3] / 255;
			w[x] = a;
			wy[x] = a > 0 ? a * lum[x] : 0;
		}
		const at = y % span * width;
		for (let x = 0; x < width; x++) {
			const from = x >= r ? -r : -x;
			const to = x < width - r ? r : width - 1 - x;
			let sn = 0;
			let sd = 0;
			for (let i = from; i <= to; i++) {
				const kk = k[i + r];
				sn += kk * wy[x + i];
				sd += kk * w[x + i];
			}
			hN[at + x] = sn;
			hD[at + x] = sd;
		}
	};
	const { amount, threshold } = stage;
	const sn = new Float64Array(width);
	const sd = new Float64Array(width);
	for (let y = 0; y < Math.min(r, height); y++) horizontal(y);
	for (let y = 0; y < height; y++) {
		if (y + r < height) horizontal(y + r);
		sn.fill(0);
		sd.fill(0);
		const from = Math.max(-r, -y);
		const to = Math.min(r, height - 1 - y);
		for (let j = from; j <= to; j++) {
			const kk = k[j + r];
			const at = (y + j) % span * width;
			for (let x = 0; x < width; x++) {
				sn[x] += kk * hN[at + x];
				sd[x] += kk * hD[at + x];
			}
		}
		lumaRow(y, lum);
		const row = y * width;
		for (let x = 0; x < width; x++) {
			const j = row + x;
			if (rgba[j * 4 + 3] === 0 || !(sd[x] > 0)) continue;
			const diff = lum[x] - sn[x] / sd[x];
			if (Math.abs(diff) < threshold) continue;
			const d = amount * diff;
			p0[j] += d;
			if (rgb) {
				p1[j] += d;
				p2[j] += d;
			}
		}
	}
}
/**
* Blurs `src` (`width` values) along the row into `out` from `at`. Interior
* pixels run all taps in a fixed loop; near the row ends only the taps inside
* the row. Each pixel's terms are added in the same order as in
* {@link sharpenPlanes}, so the sums are identical.
*/
function blurRow(src, out, at, width, k, r) {
	const taps = k.length;
	for (let x = 0; x < width; x++) {
		let s = 0;
		if (x >= r && x < width - r) for (let i = 0, b = x - r; i < taps; i++) s += k[i] * src[b + i];
		else {
			const from = x >= r ? -r : -x;
			const to = x < width - r ? r : width - 1 - x;
			for (let i = from; i <= to; i++) s += k[i + r] * src[x + i];
		}
		out[at + x] = s;
	}
}
/** Luminance of one row of encoded values (`q1` null for gray) into `lum`. */
function lumaRow(q0, q1, q2, at, width, lum) {
	if (q1 && q2) for (let x = 0; x < width; x++) lum[x] = LUMA_R * q0[at + x] + LUMA_G * q1[at + x] + LUMA_B * q2[at + x];
	else for (let x = 0; x < width; x++) lum[x] = q0[at + x];
}
/** `out += kk * src[at..at + width]`. */
function accumulate(out, src, at, kk, width) {
	for (let x = 0; x < width; x++) out[x] += kk * src[at + x];
}
/**
* The same unsharp mask as {@link sharpenPlanes}, streamed row by row: `fill`
* writes the encoded values of row `y` into `out[c]` from index `o`, and
* `emit` receives each row once it is sharpened. Only `2r + 1` rows are held,
* so the whole image never sits in float buffers. The arithmetic is the same,
* in the same order, so the result equals {@link sharpenPlanes} bit for bit.
* Rows that are fully opaque skip the weight sums, whose values are then known.
*/
function sharpenRows(rgba, width, channels, stage, fill, emit) {
	const height = width > 0 ? (rgba.length >> 2) / width : 0;
	const k = gaussian(stage.radius);
	const r = k.length - 1 >> 1;
	const span = 2 * r + 1;
	const ring = Array.from({ length: channels }, () => new Float32Array(span * width));
	const q0 = ring[0];
	const q1 = channels === 3 ? ring[1] : null;
	const q2 = channels === 3 ? ring[2] : null;
	const hN = new Float64Array(span * width);
	const hD = new Float64Array(span * width);
	const opaque = new Uint8Array(span);
	const lum = new Float64Array(width);
	const wy = new Float64Array(width);
	const w = new Float64Array(width);
	const hOnes = new Float64Array(width);
	blurRow(new Float64Array(width).fill(1), hOnes, 0, width, k, r);
	const vOnes = new Float64Array(width);
	for (let j = 0; j < span; j++) accumulate(vOnes, hOnes, 0, k[j], width);
	const horizontal = (y) => {
		const slot = y % span;
		const at = slot * width;
		fill(y, ring, at);
		lumaRow(q0, q1, q2, at, width, lum);
		const row = y * width;
		let all = true;
		for (let x = 0; x < width && all; x++) all = rgba[(row + x) * 4 + 3] === 255;
		opaque[slot] = all ? 1 : 0;
		if (all) {
			blurRow(lum, hN, at, width, k, r);
			hD.set(hOnes, at);
			return;
		}
		for (let x = 0; x < width; x++) {
			const a = rgba[(row + x) * 4 + 3] / 255;
			w[x] = a;
			wy[x] = a > 0 ? a * lum[x] : 0;
		}
		blurRow(wy, hN, at, width, k, r);
		blurRow(w, hD, at, width, k, r);
	};
	const { amount, threshold } = stage;
	const sn = new Float64Array(width);
	const sd = new Float64Array(width);
	for (let y = 0; y < Math.min(r, height); y++) horizontal(y);
	for (let y = 0; y < height; y++) {
		if (y + r < height) horizontal(y + r);
		const from = Math.max(-r, -y);
		const to = Math.min(r, height - 1 - y);
		let all = from === -r && to === r;
		for (let j = from; all && j <= to; j++) all = opaque[(y + j) % span] === 1;
		sn.fill(0);
		if (all) sd.set(vOnes);
		else sd.fill(0);
		for (let j = from; j <= to; j++) {
			const at = (y + j) % span * width;
			accumulate(sn, hN, at, k[j + r], width);
			if (!all) accumulate(sd, hD, at, k[j + r], width);
		}
		const at = y % span * width;
		lumaRow(q0, q1, q2, at, width, lum);
		applyMask(rgba, y * width, at, width, lum, sn, sd, amount, threshold, q0, q1, q2);
		emit(y, ring, at);
	}
}
/** Adds `amount * (luminance - blur)` to each channel of one row, where it is at least `threshold`. */
function applyMask(rgba, row, at, width, lum, sn, sd, amount, threshold, q0, q1, q2) {
	for (let x = 0; x < width; x++) {
		if (rgba[(row + x) * 4 + 3] === 0 || !(sd[x] > 0)) continue;
		const diff = lum[x] - sn[x] / sd[x];
		if (Math.abs(diff) < threshold) continue;
		const d = amount * diff;
		q0[at + x] += d;
		if (q1 && q2) {
			q1[at + x] += d;
			q2[at + x] += d;
		}
	}
}
//#endregion
export { sharpenPlanes, sharpenRows };

//# sourceMappingURL=filter.js.map