//#region src/pansharpen.ts
/** The range an integer typed array holds, or null for floats and plain arrays. */
function integerRange(data) {
	if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) return [0, 255];
	if (data instanceof Int8Array) return [-128, 127];
	if (data instanceof Uint16Array) return [0, 65535];
	if (data instanceof Int16Array) return [-32768, 32767];
	if (data instanceof Uint32Array) return [0, 4294967295];
	if (data instanceof Int32Array) return [-2147483648, 2147483647];
	return null;
}
function outputArray(data, length) {
	if (ArrayBuffer.isView(data) && !(data instanceof DataView)) return new data.constructor(length);
	return new Float64Array(length);
}
/** Pixels whose statistics are taken: about this many, evenly spread. */
const SAMPLES = 1 << 20;
/**
* Pan-sharpens `ms` with `pan`. Both must have the same width and height:
* resample the multispectral image onto the panchromatic grid first
* (bilinear or bicubic). Pixels that are no data (or NaN) in either stay no data.
*
* @example
* ```ts
* const sharp = panSharpen(
*   { data: pan, width, height, noData: 0 },
*   { data: msOnPanGrid, width, height, bands: 4, noData: 0 },
*   { method: 'gram-schmidt' },
* );
* ```
*/
function panSharpen(pan, ms, options = {}) {
	const { width, height } = ms;
	if (pan.width !== width || pan.height !== height) throw new RangeError(`pan (${pan.width}x${pan.height}) and ms (${width}x${height}) must be the same size: resample ms onto the pan grid first.`);
	const pixels = width * height;
	const panBands = pan.bands ?? 1;
	const msBands = ms.bands ?? 1;
	if (pan.data.length < pixels * panBands) throw new RangeError(`pan needs ${pixels * panBands} values, got ${pan.data.length}.`);
	if (ms.data.length < pixels * msBands) throw new RangeError(`ms needs ${pixels * msBands} values, got ${ms.data.length}.`);
	const panBand = options.panBand ?? 0;
	if (!Number.isInteger(panBand) || panBand < 0 || panBand >= panBands) throw new RangeError(`panBand must be a band of pan, got ${panBand}.`);
	const alpha = ms.alpha ? msBands - 1 : -1;
	const bands = options.bands ? [...options.bands] : Array.from({ length: msBands }, (_, b) => b).filter((b) => b !== alpha);
	if (!bands.length || bands.some((b) => !Number.isInteger(b) || b < 0 || b >= msBands || b === alpha) || new Set(bands).size !== bands.length) throw new RangeError(`bands must name distinct value bands of ms, got ${JSON.stringify(options.bands)}.`);
	const method = options.method ?? "gram-schmidt";
	if (![
		"gram-schmidt",
		"ihs",
		"brovey"
	].includes(method)) throw new RangeError(`Unknown method ${String(method)}.`);
	const strength = options.strength ?? 1;
	if (!Number.isFinite(strength) || strength < 0) throw new RangeError(`strength must be 0 or more, got ${strength}.`);
	const P = pan.data;
	const M = ms.data;
	const panNoData = pan.noData ?? null;
	const msNoData = ms.noData ?? null;
	const n = bands.length;
	/** Whether pixel `i` has a value in pan and in every sharpened band. */
	const valid = (i) => {
		const p = P[i * panBands + panBand];
		if (p - p !== 0 || p === panNoData) return false;
		if (alpha >= 0 && M[i * msBands + alpha] === 0) return false;
		for (const b of bands) {
			const v = M[i * msBands + b];
			if (v - v !== 0 || v === msNoData) return false;
		}
		return true;
	};
	const step = Math.max(1, Math.floor(pixels / SAMPLES));
	const k = n + 1;
	const sum = new Float64Array(k);
	const cross = new Float64Array(k * k);
	const row = new Float64Array(k);
	let count = 0;
	for (let i = 0; i < pixels; i += step) {
		if (!valid(i)) continue;
		for (let j = 0; j < n; j++) row[j] = M[i * msBands + bands[j]];
		row[n] = P[i * panBands + panBand];
		for (let a = 0; a < k; a++) {
			sum[a] += row[a];
			for (let b = a; b < k; b++) cross[a * k + b] += row[a] * row[b];
		}
		count++;
	}
	const mean = Array.from(sum, (s) => count ? s / count : 0);
	/** Covariance of variables `a` and `b` (bands 0..n-1, pan n). */
	const cov = (a, b) => count ? cross[Math.min(a, b) * k + Math.max(a, b)] / count - mean[a] * mean[b] : 0;
	const weights = intensityWeights(options.weights ?? "auto", n, cov);
	const meanI = weights.reduce((s, w, j) => s + w * mean[j], 0);
	let varI = 0;
	for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) varI += weights[a] * weights[b] * cov(a, b);
	const varP = cov(n, n);
	const gainP = varP > 0 && varI > 0 ? Math.sqrt(varI / varP) : 1;
	const offsetP = meanI - gainP * mean[n];
	const gains = bands.map((_, j) => {
		if (method === "ihs") return 1;
		if (method === "brovey") return 0;
		let c = 0;
		for (let b = 0; b < n; b++) c += weights[b] * cov(j, b);
		return varI > 0 ? c / varI : 1;
	});
	const range = integerRange(M);
	const noData = msNoData ?? (range ? 0 : NaN);
	const out = outputArray(M, pixels * msBands);
	const copy = Array.from({ length: msBands }, (_, b) => b).filter((b) => !bands.includes(b));
	const sharp = new Float64Array(n);
	for (let i = 0; i < pixels; i++) {
		const o = i * msBands;
		for (const b of copy) out[o + b] = M[o + b];
		if (!valid(i)) {
			for (const b of bands) out[o + b] = noData;
			continue;
		}
		let I = 0;
		for (let j = 0; j < n; j++) I += weights[j] * M[o + bands[j]];
		const detail = strength * (gainP * P[i * panBands + panBand] + offsetP - I);
		if (method === "brovey") {
			const ratio = Math.abs(I) > 1e-9 ? (I + detail) / I : NaN;
			for (let j = 0; j < n; j++) sharp[j] = ratio === ratio ? M[o + bands[j]] * ratio : M[o + bands[j]] + detail;
		} else for (let j = 0; j < n; j++) sharp[j] = M[o + bands[j]] + gains[j] * detail;
		for (let j = 0; j < n; j++) {
			let v = sharp[j];
			if (range) {
				v = Math.round(Math.min(range[1], Math.max(range[0], v)));
				if (v === noData) v = noData < range[1] ? noData + 1 : noData - 1;
			}
			out[o + bands[j]] = v;
		}
	}
	return {
		data: out,
		width,
		height,
		bands: msBands,
		noData,
		weights,
		gains
	};
}
/** The intensity weights (summing to 1): fitted, equal or given. */
function intensityWeights(choice, n, cov) {
	const equal = new Array(n).fill(1 / n);
	if (choice === "equal") return equal;
	if (choice !== "auto") {
		if (choice.length !== n || choice.some((w) => !Number.isFinite(w) || w < 0)) throw new RangeError(`weights must give ${n} numbers of 0 or more.`);
		const total = choice.reduce((s, w) => s + w, 0);
		if (!(total > 0)) throw new RangeError("weights must not all be 0.");
		return choice.map((w) => w / total);
	}
	let active = Array.from({ length: n }, (_, j) => j);
	for (let round = 0; round < n; round++) {
		const w = solve(active.map((a) => active.map((b) => cov(a, b))), active.map((a) => cov(a, n)));
		if (!w) return equal;
		if (w.every((v) => v >= 0)) {
			const total = w.reduce((s, v) => s + v, 0);
			if (!(total > 0)) return equal;
			const out = new Array(n).fill(0);
			active.forEach((j, i) => out[j] = w[i] / total);
			return out;
		}
		active = active.filter((_, i) => w[i] > 0);
		if (!active.length) return equal;
	}
	return equal;
}
/** Solves `a x = b` by Gaussian elimination with partial pivoting; null when singular. */
function solve(a, b) {
	const n = b.length;
	const m = a.map((r, i) => [...r, b[i]]);
	const scale = Math.max(1e-300, ...a.map((r, i) => Math.abs(r[i])));
	for (let c = 0; c < n; c++) {
		let p = c;
		for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
		if (Math.abs(m[p][c]) <= scale * 1e-12) return null;
		[m[c], m[p]] = [m[p], m[c]];
		for (let r = 0; r < n; r++) {
			if (r === c) continue;
			const f = m[r][c] / m[c][c];
			for (let j = c; j <= n; j++) m[r][j] -= f * m[c][j];
		}
	}
	return m.map((r, i) => r[n] / r[i]);
}
//#endregion
export { panSharpen };

//# sourceMappingURL=pansharpen.js.map