import { createImageData } from "./workers/src/image.js";
import { normalizeAutoStretch } from "./ops/index.js";
import { rangeOf } from "./core/histogram.js";
//#region src/raster.ts
/**
* Rasters with values beyond 8 bits (16-bit integers, floats: GeoTIFF
* bands, scientific data). Corrections work on 8-bit images, so a raster is
* first stretched from its own value range to 0-255; the statistics for that
* stretch are taken on the raw values, so nothing is lost to an early 8-bit
* rounding. The 8-bit image then goes through a pipeline like any other.
*/
function layout(r) {
	const bands = r.bands ?? 1;
	if (!Number.isInteger(bands) || bands < 1) throw new RangeError(`bands must be a positive integer, got ${String(r.bands)}.`);
	if (r.data.length < r.width * r.height * bands) throw new RangeError(`A ${r.width}x${r.height} raster with ${bands} bands needs ${r.width * r.height * bands} values, got ${r.data.length}.`);
	const alpha = r.alpha ? bands - 1 : -1;
	const color = r.alpha ? bands - 1 : bands;
	const picture = r.select ? [...r.select] : color >= 3 ? [
		0,
		1,
		2
	] : [0];
	if (picture.length !== 1 && picture.length !== 3 || picture.some((b) => !Number.isInteger(b) || b < 0 || b >= bands || b === alpha)) throw new RangeError(`select must name 1 or 3 value bands of ${bands}, got ${JSON.stringify(r.select)}.`);
	return {
		bands,
		picture,
		alpha,
		noData: r.noData ?? null
	};
}
/** Whether pixel `p` (index of its first value) is transparent or has no data (or a non-finite value) in a picture band. */
function hidden(data, p, l) {
	if (l.alpha >= 0 && data[p + l.alpha] === 0) return true;
	for (const b of l.picture) {
		const v = data[p + b];
		if (v - v !== 0 || v === l.noData) return true;
	}
	return false;
}
function clip(rect, width, height) {
	if (!rect) return [
		0,
		0,
		width,
		height
	];
	return [
		Math.max(0, Math.floor(rect.x)),
		Math.max(0, Math.floor(rect.y)),
		Math.min(width, Math.ceil(rect.x + rect.width)),
		Math.min(height, Math.ceil(rect.y + rect.height))
	];
}
/**
* Smallest and largest value of the picture bands, skipping transparent,
* no-data and NaN pixels; null when there is none.
*/
function rasterRange(raster, rect) {
	const l = layout(raster);
	const [x0, y0, x1, y1] = clip(rect, raster.width, raster.height);
	let min = Infinity;
	let max = -Infinity;
	const d = raster.data;
	for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
		const p = (y * raster.width + x) * l.bands;
		if (hidden(d, p, l)) continue;
		for (const b of l.picture) {
			const v = d[p + b];
			if (v < min) min = v;
			if (v > max) max = v;
		}
	}
	return min <= max ? [min, max] : null;
}
/** Value counts of the picture bands over `range` (default: the raster's own range). */
function rasterHistogram(raster, options = {}) {
	const l = layout(raster);
	const n = Math.max(2, Math.floor(options.bins ?? 4096));
	const [min, max] = options.range ?? rasterRange(raster, options.rect) ?? [0, 1];
	const bins = l.picture.map(() => new Float64Array(n));
	const scale = max > min ? (n - 1) / (max - min) : 0;
	const [x0, y0, x1, y1] = clip(options.rect, raster.width, raster.height);
	const d = raster.data;
	let count = 0;
	for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
		const p = (y * raster.width + x) * l.bands;
		if (hidden(d, p, l)) continue;
		for (let c = 0; c < l.picture.length; c++) {
			const k = Math.round((d[p + l.picture[c]] - min) * scale);
			bins[c][k < 0 ? 0 : k >= n ? n - 1 : k]++;
		}
		count++;
	}
	return {
		range: [min, max],
		bins,
		count
	};
}
/**
* Value counts of the picture bands of several rasters (the tiles of one
* picture), made to hold up on real imagery. Null when there is no value.
*
* Two things in satellite products spoil a plain {@link rasterHistogram}
* (its bins spread evenly from the smallest value to the largest):
*
* - A fill value that is not tagged as no data (-9999, -32768, the lowest
*   float, 0 around a scene) takes the corners of the scene. It is often
*   more than the few percent a stretch clips, so it becomes black (or
*   white) and the scene itself lands at the other end, all white (or all
*   black). The smallest or largest value of a band is taken as such a fill
*   value, and left out, when it lies further from the rest of the values
*   than the rest spreads (between its 1st and 99th percentile).
* - A few far outlying values (hot pixels, a fill value on overview edges
*   blended with the scene) squeeze the values into a handful of bins. The
*   bins are then taken again over the 1-99 % range widened by its own width
*   on each side, with the values outside counted in the end bins.
*
* Imagery without either gets the same histogram as {@link rasterHistogram}
* over the rasters' range.
*/
function sampleRasterHistogram(samples, options = {}) {
	const n = Math.max(2, Math.floor(options.bins ?? 4096));
	if (samples.length === 0) return null;
	const layouts = samples.map((s) => layout(s.raster));
	const bands = layouts[0].picture.length;
	const none = new Array(bands).fill(null);
	const lo = new Array(bands).fill(Infinity);
	const hi = new Array(bands).fill(-Infinity);
	samples.forEach((s, i) => forEachValue(s, layouts[i], none, (c, v) => {
		if (v < lo[c]) lo[c] = v;
		if (v > hi[c]) hi[c] = v;
	}));
	const range = [Math.min(...lo), Math.max(...hi)];
	if (!(range[0] <= range[1])) return null;
	const coarse = histogramOf(samples, layouts, range, n, none);
	const exact = countValues(samples, layouts, [lo, hi]);
	const skip = coarse.bins.map((bins, c) => {
		const k = (v) => binOf(v, range, n);
		const rest = Float64Array.from(bins);
		rest[k(lo[c])] -= exact[0][c];
		if (hi[c] !== lo[c]) rest[k(hi[c])] -= exact[1][c];
		const p1 = quantile(rest, .01, range);
		const p99 = quantile(rest, .99, range);
		if (p1 === null || p99 === null) return [];
		const spread = p99 - p1;
		const out = [];
		if (p1 - lo[c] > spread && lo[c] < p1) out.push(lo[c]);
		if (hi[c] - p99 > spread && hi[c] > p99) out.push(hi[c]);
		return out;
	});
	let first = skip.some((s) => s.length > 0) ? histogramOf(samples, layouts, range, n, skip) : coarse;
	let current = range;
	for (let round = 0; round < 16; round++) {
		let q1 = Infinity;
		let q99 = -Infinity;
		for (const bins of first.bins) {
			const a = quantile(bins, .01, current);
			const b = quantile(bins, .99, current);
			if (a !== null && b !== null) [q1, q99] = [Math.min(q1, a), Math.max(q99, b)];
		}
		if (!(q1 <= q99)) break;
		const margin = Math.max(q99 - q1, (current[1] - current[0]) / (n - 1));
		const narrow = [Math.max(current[0], q1 - margin), Math.min(current[1], q99 + margin)];
		if ((narrow[1] - narrow[0]) * 16 >= current[1] - current[0]) break;
		current = narrow;
		first = histogramOf(samples, layouts, current, n, skip);
	}
	return first;
}
/** Calls `fn(band, value)` for every value of the picture bands that counts (not transparent, no data, NaN or skipped). */
function forEachValue(s, l, skip, fn) {
	const r = s.raster;
	const [x0, y0, x1, y1] = clip(s.rect, r.width, r.height);
	const d = r.data;
	for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
		const p = (y * r.width + x) * l.bands;
		if (hidden(d, p, l)) continue;
		for (let c = 0; c < l.picture.length; c++) {
			const v = d[p + l.picture[c]];
			const k = skip[c];
			if (k !== null && (Array.isArray(k) ? k.includes(v) : k === v)) continue;
			fn(c, v);
		}
	}
}
const binOf = (v, [min, max], n) => {
	const k = Math.round((v - min) * (max > min ? (n - 1) / (max - min) : 0));
	return k < 0 ? 0 : k >= n ? n - 1 : k;
};
/** Histogram of the samples over `range`, values in `skip` (per band) left out. */
function histogramOf(samples, layouts, range, n, skip) {
	const bins = layouts[0].picture.map(() => new Float64Array(n));
	let count = 0;
	samples.forEach((s, i) => {
		const l = layouts[i];
		const r = s.raster;
		const [x0, y0, x1, y1] = clip(s.rect, r.width, r.height);
		for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (!hidden(r.data, (y * r.width + x) * l.bands, l)) count++;
		forEachValue(s, l, skip, (c, v) => bins[c][binOf(v, range, n)]++);
	});
	return {
		range,
		bins,
		count
	};
}
/** How many values of each band equal `values[j][band]`, for each j. */
function countValues(samples, layouts, values) {
	const out = values.map((v) => v.map(() => 0));
	const none = values[0].map(() => null);
	samples.forEach((s, i) => forEachValue(s, layouts[i], none, (c, v) => {
		for (let j = 0; j < values.length; j++) if (values[j][c] === v) out[j][c]++;
	}));
	return out;
}
/** The value below which fraction `q` of the counts lie (a bin's value), or null for no counts. */
function quantile(bins, q, [min, max]) {
	let total = 0;
	for (let k = 0; k < bins.length; k++) total += bins[k];
	if (total <= 0) return null;
	const target = total * q;
	let cum = 0;
	for (let k = 0; k < bins.length; k++) {
		cum += bins[k];
		if (cum > target) return min + (max - min) * k / (bins.length - 1);
	}
	return max;
}
/** Adds raster histograms taken with the same range and bin count (of tiles of one picture). */
function mergeRasterHistograms(histograms) {
	if (histograms.length === 0) throw new RangeError("Nothing to merge.");
	const [first] = histograms;
	const out = {
		range: first.range,
		bins: first.bins.map((b) => new Float64Array(b.length)),
		count: 0
	};
	for (const h of histograms) {
		if (h.range[0] !== first.range[0] || h.range[1] !== first.range[1] || h.bins.length !== first.bins.length || h.bins[0].length !== first.bins[0].length) throw new RangeError("Raster histograms can only be merged when they have the same range, bands and bin count.");
		h.bins.forEach((b, c) => {
			const o = out.bins[c];
			for (let k = 0; k < b.length; k++) o[k] += b[k];
		});
		out.count += h.count;
	}
	return out;
}
/**
* The raw values that become black and white for an automatic stretch of a
* raster with this histogram (one pair per picture band; the same pair for
* all with `linked: true`).
*/
function computeRasterStretch(stats, options = {}) {
	const o = normalizeAutoStretch(options);
	const [min, max] = stats.range;
	const toDistribution = (bins) => {
		const d = [];
		for (const b of bins) {
			const step = (max - min) / (b.length - 1);
			for (let k = 0; k < b.length; k++) if (b[k] > 0) d.push({
				value: k === b.length - 1 ? max : min + k * step,
				count: b[k]
			});
		}
		return d.sort((a, b) => a.value - b.value);
	};
	const fallback = max > min ? [min, max] : [min, min + 1];
	if (o.linked || stats.bins.length === 1) {
		const r = rangeOf(toDistribution(stats.bins), o) ?? fallback;
		return {
			black: stats.bins.map(() => r[0]),
			white: stats.bins.map(() => r[1])
		};
	}
	const ranges = stats.bins.map((b) => rangeOf(toDistribution([b]), o) ?? fallback);
	return {
		black: ranges.map((r) => r[0]),
		white: ranges.map((r) => r[1])
	};
}
function isFixed(s) {
	return !!s && "black" in s && "white" in s;
}
function perBand(v, n, name) {
	const out = typeof v === "number" ? new Array(n).fill(v) : [...v];
	if (out.length !== n || out.some((x) => !Number.isFinite(x))) throw new RangeError(`${name} must be a number or ${n} numbers.`);
	return out;
}
/**
* Stretches a raster to an 8-bit sRGB image (`ImageData`) that pipelines can
* correct: raw values from black to white map linearly onto 0-255, values
* outside are clipped, and transparent, no-data and NaN pixels become
* transparent. One picture band gives a gray image, three give color.
*
* @example
* ```ts
* // A 16-bit, 4-band GeoTIFF: show bands 3, 2, 1 (red, green, blue), stretched on the raw values.
* const data = await tiff.getImage().then((i) => i.readRasters({ interleave: true }));
* const img = rasterToImageData({ data, width, height, bands: 4, select: [2, 1, 0], noData: 0 });
* const out = await pipeline().contrast(0.1).sharpen().run(img);
* ```
*/
function rasterToImageData(raster, options = {}) {
	const l = layout(raster);
	const n = l.picture.length;
	const stretch = isFixed(options.stretch) ? {
		black: perBand(options.stretch.black, n, "stretch.black"),
		white: perBand(options.stretch.white, n, "stretch.white")
	} : computeRasterStretch(sampleRasterHistogram([{ raster }]) ?? rasterHistogram(raster), options.stretch);
	const scale = stretch.black.map((b, c) => stretch.white[c] > b ? 255 / (stretch.white[c] - b) : 0);
	const pixels = raster.width * raster.height;
	const out = new Uint8ClampedArray(pixels * 4);
	const d = raster.data;
	for (let i = 0, p = 0, o = 0; i < pixels; i++, p += l.bands, o += 4) {
		if (hidden(d, p, l)) continue;
		for (let c = 0; c < 3; c++) {
			const b = n === 1 ? 0 : c;
			out[o + c] = (d[p + l.picture[b]] - stretch.black[b]) * scale[b];
		}
		out[o + 3] = 255;
	}
	return createImageData(out, raster.width, raster.height);
}
//#endregion
export { computeRasterStretch, mergeRasterHistograms, rasterHistogram, rasterRange, rasterToImageData, sampleRasterHistogram };

//# sourceMappingURL=raster.js.map