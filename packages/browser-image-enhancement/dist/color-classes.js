import { colorScalePalette } from "./color-scale.js";
// src/color-classes.ts
/**
* Color classes (discrete pseudo-color, as QGIS's "discrete" and "exact"
* color ramps or its paletted renderer): pixel values are sorted into
* classes and each class gets one flat color, instead of a smooth ramp.
* Elevations in 100 m steps, an index cut at a few thresholds, or a land
* cover map whose codes 1, 2, 3… each mean a class.
*
* Classes hold values of the image (raw values, not the 8-bit codes it is
* shown with). {@link classPalette} turns them into a 256-entry RGBA table
* for the codes `range` is shown over, the form `GpuRenderer.render` and
* `GpuCorrectedTileLayer` take; {@link colorClasses} makes classes from a
* value histogram: equal intervals, quantiles (classes of equal area), or
* one class per value.
*/
const sorted = (c) => [...c.classes].sort((a, b) => a.value - b.value);
/**
* The raw values that the 8-bit codes 0 and 255 should stand for to show
* `classes` (an image stretched linearly from the first to the second):
* integer values that span at most 255 one code each, else the classes'
* whole range.
*/
function classRange(classes) {
	const list = sorted(classes);
	if (list.length === 0) return [0, 255];
	const first = list[0].value;
	const last = list[list.length - 1].value;
	if (classes.kind === "exact") {
		if (list.every((c) => Number.isInteger(c.value)) && last - first <= 255) return [first, first + 255];
		return last > first ? [first, last] : [first, first + 255];
	}
	const lo = Math.min(classes.min ?? first, first);
	return last > lo ? [lo, last] : [lo, lo + 1];
}
/**
* The classes as a 256-entry RGBA table (1024 bytes) for an image shown
* linearly from `range[0]` (code 0) to `range[1]` (code 255): entry `v` is
* the color of the class of the value code `v` stands for.
*/
function classPalette(classes, range = classRange(classes)) {
	const out = /* @__PURE__ */ new Uint8ClampedArray(1024);
	const list = sorted(classes);
	if (list.length === 0) return out;
	const [lo, hi] = range;
	const step = (hi - lo) / 255;
	const tolerance = Math.abs(step) * 1e-6;
	for (let v = 0; v < 256; v++) {
		const value = lo + step * v;
		let pick = null;
		if (classes.kind === "range") pick = list.find((c) => value <= c.value + tolerance) ?? list[list.length - 1];
		else {
			let best = Infinity;
			for (const c of list) {
				const d = Math.abs(c.value - value);
				if (d < best) [best, pick] = [d, c];
			}
			if (best > Math.abs(step) / 2 + tolerance) pick = null;
		}
		if (!pick) continue;
		const [r = 0, g = 0, b = 0, a = 255] = pick.color;
		out.set([
			r,
			g,
			b,
			a
		], 4 * v);
	}
	return out;
}
/** The value of bin `k` of `hist`. */
const binValue = (hist, k, bins) => hist.range[0] + (hist.range[1] - hist.range[0]) * k / Math.max(1, bins - 1);
/** The smallest and largest value counted in `band` of `hist`; null when it counted nothing. */
function histogramValueRange(hist, band = 0) {
	const bins = hist.bins[band] ?? hist.bins[0];
	if (!bins) return null;
	let first = -1;
	let last = -1;
	for (let k = 0; k < bins.length; k++) {
		if (bins[k] <= 0) continue;
		if (first < 0) first = k;
		last = k;
	}
	return first < 0 ? null : [binValue(hist, first, bins.length), binValue(hist, last, bins.length)];
}
/** `count` upper bounds of classes of equal width from `min` to `max`. */
function equalIntervalBreaks(min, max, count) {
	const n = Math.max(1, Math.round(count));
	return Array.from({ length: n }, (_, i) => i === n - 1 ? max : min + (max - min) * (i + 1) / n);
}
/**
* Upper bounds of classes of about as many pixels each (at most `count`;
* fewer when many pixels share a value, as bounds that fall together are
* merged).
*/
function quantileBreaks(hist, count, band = 0) {
	const bins = hist.bins[band] ?? hist.bins[0];
	const span = histogramValueRange(hist, band);
	if (!bins || !span) return [];
	const n = Math.max(1, Math.round(count));
	let total = 0;
	for (let k = 0; k < bins.length; k++) total += bins[k];
	const out = [];
	let cum = 0;
	let next = 1;
	for (let k = 0; k < bins.length && next < n; k++) {
		cum += bins[k];
		let crossed = false;
		while (next < n && cum >= total * next / n) {
			next++;
			crossed = true;
		}
		if (crossed) {
			const value = binValue(hist, k, bins.length);
			if (value < span[1] && out[out.length - 1] !== value) out.push(value);
		}
	}
	out.push(span[1]);
	return out;
}
/**
* The values counted in `band` of `hist` and how many pixels have each,
* smallest first; null when there are more than `max`. Values of a
* histogram of integers (bins no wider than 1 over an integer range) are
* rounded to integers.
*/
function uniqueValues(hist, max = 64, band = 0) {
	const bins = hist.bins[band] ?? hist.bins[0];
	if (!bins) return null;
	const [lo, hi] = hist.range;
	const width = (hi - lo) / Math.max(1, bins.length - 1);
	const integers = Number.isInteger(lo) && Number.isInteger(hi) && width <= 1;
	const out = [];
	for (let k = 0; k < bins.length; k++) {
		if (bins[k] <= 0) continue;
		const raw = binValue(hist, k, bins.length);
		const value = integers ? Math.round(raw) : raw;
		const last = out[out.length - 1];
		if (last && last.value === value) last.count += bins[k];
		else {
			if (out.length >= max) return null;
			out.push({
				value,
				count: bins[k]
			});
		}
	}
	return out;
}
/** `count` colors taken evenly along `scale`, from its dark end to its bright end (the other way with `reverse`). */
function classColors(scale, count, reverse = false) {
	const palette = colorScalePalette(scale, { reverse });
	const n = Math.max(1, Math.round(count));
	return Array.from({ length: n }, (_, i) => {
		const v = n === 1 ? 128 : Math.round(255 * i / (n - 1));
		return Array.from(palette.subarray(4 * v, 4 * v + 4));
	});
}
/** A value written with as many decimals as a class `width` needs (two digits finer than it, at most 6; trailing zeros dropped). */
function formatClassValue(value, width) {
	const decimals = width > 0 && Number.isFinite(width) ? Math.min(6, Math.max(0, Math.ceil(-Math.log10(width)) + 2)) : 0;
	const text = value.toFixed(Number.isInteger(value) && width >= 1 ? 0 : decimals);
	return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}
/** Labels of range classes, "low – high" (the first from `min`). */
function rangeLabels(min, bounds) {
	const width = bounds.length ? (bounds[bounds.length - 1] - min) / bounds.length : 1;
	return bounds.map((b, i) => `${formatClassValue(i === 0 ? min : bounds[i - 1], width)} – ${formatClassValue(b, width)}`);
}
/**
* Classes for the values counted in `hist` (from `rasterHistogram`, or the
* value histogram of an image), colored along a scale. Null when there is
* nothing to class, or more distinct values than `maxValues` for `unique`.
*/
function colorClasses(hist, options = {}) {
	const band = options.band ?? 0;
	const span = histogramValueRange(hist, band);
	if (!span) return null;
	const method = options.method ?? "equal";
	const scale = options.scale ?? "turbo";
	if (method === "unique") {
		const values = uniqueValues(hist, options.maxValues ?? 64, band);
		if (!values?.length) return null;
		const colors = classColors(scale, values.length, options.reverse);
		const width = values.length > 1 ? (values[values.length - 1].value - values[0].value) / (values.length - 1) : 1;
		return {
			kind: "exact",
			method,
			classes: values.map((v, i) => ({
				value: v.value,
				color: colors[i],
				label: formatClassValue(v.value, width)
			}))
		};
	}
	const count = Math.max(1, Math.round(options.count ?? 5));
	const exact = method === "quantile" ? quantileBreaks(hist, count, band) : equalIntervalBreaks(span[0], span[1], count);
	const width = (span[1] - span[0]) / Math.max(1, exact.length);
	const bounds = exact.map((b, i) => i === exact.length - 1 ? b : Number(formatClassValue(b, width)));
	const colors = classColors(scale, bounds.length, options.reverse);
	const labels = rangeLabels(span[0], bounds);
	return {
		kind: "range",
		method,
		min: span[0],
		classes: bounds.map((b, i) => ({
			value: b,
			color: colors[i],
			label: labels[i]
		}))
	};
}
/** The share of the pixels counted in `hist` that each class gets (0-1, in the order of `classes.classes`). */
function classShares(hist, classes, band = 0) {
	const bins = hist.bins[band] ?? hist.bins[0];
	const list = classes.classes;
	const counts = new Array(list.length).fill(0);
	if (!bins || list.length === 0) return counts;
	const order = list.map((c, i) => [c.value, i]).sort((a, b) => a[0] - b[0]);
	const width = (hist.range[1] - hist.range[0]) / Math.max(1, bins.length - 1);
	let total = 0;
	for (let k = 0; k < bins.length; k++) {
		const n = bins[k];
		if (n <= 0) continue;
		total += n;
		const value = binValue(hist, k, bins.length);
		let pick = -1;
		if (classes.kind === "range") pick = (order.find(([v]) => value <= v + width * 1e-6) ?? order[order.length - 1])[1];
		else {
			const near = order.reduce((best, o) => Math.abs(o[0] - value) < Math.abs(best[0] - value) ? o : best);
			if (Math.abs(near[0] - value) <= Math.max(width, .5)) pick = near[1];
		}
		if (pick >= 0) counts[pick] += n;
	}
	return total > 0 ? counts.map((c) => c / total) : counts;
}
export { classColors, classPalette, classRange, classShares, colorClasses, equalIntervalBreaks, formatClassValue, histogramValueRange, quantileBreaks, rangeLabels, uniqueValues };

//# sourceMappingURL=color-classes.js.map