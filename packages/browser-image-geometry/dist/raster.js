import { rowMapper } from "./resample.js";
import { planWarp } from "./plan.js";
//#region src/raster.ts
/**
* Warping rasters of any band count and sample type (16-bit, float, ...),
* such as satellite images and elevation models, keeping their values:
* nothing is converted to 8-bit RGBA. Pixels whose first band is the no-data
* value (or NaN) are left out of the interpolation, and output pixels outside the source
* get the no-data value.
*/
/**
* Applies `transform` to a raster on the calling thread, keeping its sample
* type. Output pixels outside the source get the no-data value (0 when the
* raster has none and the samples are integers, NaN for floats).
*
* @example
* ```ts
* const { raster, geoTransform } = warpRaster(
*   { width, height, bands: 4, data: uint16, noData: 0 },
*   fit.transform,
*   { resample: 'bilinear', coordinateTransform: proj4('EPSG:4326', 'EPSG:3857') },
* );
* ```
*/
function warpRaster(raster, transform, options = {}) {
	const { width, height, bands, data } = raster;
	if (!(width > 0 && height > 0 && bands > 0) || data.length !== width * height * bands) throw new RangeError("A raster needs width × height × bands samples.");
	const plan = planWarp(width, height, transform, options);
	let source = raster;
	for (let i = 0; i < plan.levels; i++) source = halveRaster(source);
	return {
		raster: renderRaster(source, plan),
		geoTransform: plan.geoTransform,
		extent: plan.extent
	};
}
function isFloat(data) {
	return data instanceof Float32Array || data instanceof Float64Array;
}
function fillValue(raster) {
	return raster.noData ?? (isFloat(raster.data) ? NaN : 0);
}
/** Keys cubic convolution (a = -0.5), as for RGBA. */
function cubic(t) {
	const x = Math.abs(t);
	if (x < 1) return (1.5 * x - 2.5) * x * x + 1;
	if (x < 2) return ((-.5 * x + 2.5) * x - 4) * x + 2;
	return 0;
}
/** Rounds and clamps to the integer type's range; floats pass through. */
function storer(data) {
	if (isFloat(data)) return (v) => v;
	const [min, max] = data instanceof Uint8Array ? [0, 255] : data instanceof Int8Array ? [-128, 127] : data instanceof Uint16Array ? [0, 65535] : data instanceof Int16Array ? [-32768, 32767] : data instanceof Uint32Array ? [0, 4294967295] : [-2147483648, 2147483647];
	return (v) => Math.min(max, Math.max(min, Math.round(v)));
}
function renderRaster(src, plan) {
	const { width, height, mapping, resample } = plan;
	const { width: sw, height: sh, bands, data } = src;
	const noData = src.noData ?? null;
	const fill = fillValue(src);
	const store = storer(data);
	const out = new data.constructor(width * height * bands);
	const map = rowMapper(mapping);
	const pos = new Float64Array(width * 2);
	const sum = new Float64Array(bands);
	const taps = resample === "bicubic" ? 4 : 2;
	const first = resample === "bicubic" ? -1 : 0;
	const wx = /* @__PURE__ */ new Float64Array(4);
	const wy = /* @__PURE__ */ new Float64Array(4);
	const valid = (v) => v === v && v !== noData;
	for (let y = 0; y < height; y++) {
		map(y, width, pos);
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * bands;
			const sx = pos[x * 2];
			const sy = pos[x * 2 + 1];
			let written = false;
			if (Number.isFinite(sx) && Number.isFinite(sy) && sx >= 0 && sy >= 0 && sx <= sw && sy <= sh) {
				if (resample === "nearest") {
					const i = Math.min(sw - 1, Math.floor(sx));
					const s = (Math.min(sh - 1, Math.floor(sy)) * sw + i) * bands;
					if (valid(data[s])) {
						for (let b = 0; b < bands; b++) out[o + b] = data[s + b];
						written = true;
					}
				} else {
					const px = sx - .5;
					const py = sy - .5;
					const ix = Math.floor(px);
					const iy = Math.floor(py);
					const fx = px - ix;
					const fy = py - iy;
					if (taps === 2) {
						wx[0] = 1 - fx;
						wx[1] = fx;
						wy[0] = 1 - fy;
						wy[1] = fy;
					} else for (let t = 0; t < 4; t++) {
						wx[t] = cubic(fx - (t - 1));
						wy[t] = cubic(fy - (t - 1));
					}
					sum.fill(0);
					let weight = 0;
					for (let tj = 0; tj < taps; tj++) {
						const j = Math.min(sh - 1, Math.max(0, iy + first + tj));
						if (wy[tj] === 0) continue;
						for (let ti = 0; ti < taps; ti++) {
							const i = Math.min(sw - 1, Math.max(0, ix + first + ti));
							const w = wx[ti] * wy[tj];
							if (w === 0) continue;
							const s = (j * sw + i) * bands;
							if (!valid(data[s])) continue;
							for (let b = 0; b < bands; b++) sum[b] += data[s + b] * w;
							weight += w;
						}
					}
					if (weight > 1e-6) {
						for (let b = 0; b < bands; b++) out[o + b] = store(sum[b] / weight);
						written = true;
					}
				}
			}
			if (!written) for (let b = 0; b < bands; b++) out[o + b] = fill;
		}
	}
	return {
		width,
		height,
		bands,
		data: out,
		noData: src.noData
	};
}
/** Halves a raster (2×2 average per band, leaving out no-data), for shrinking by more than 2× without aliasing. */
function halveRaster(src) {
	const { width: sw, height: sh, bands, data } = src;
	const w = Math.ceil(sw / 2);
	const h = Math.ceil(sh / 2);
	const noData = src.noData ?? null;
	const fill = fillValue(src);
	const store = storer(data);
	const out = new data.constructor(w * h * bands);
	const sum = new Float64Array(bands);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		sum.fill(0);
		let n = 0;
		for (let dy = 0; dy < 2; dy++) {
			const j = 2 * y + dy;
			if (j >= sh) continue;
			for (let dx = 0; dx < 2; dx++) {
				const i = 2 * x + dx;
				if (i >= sw) continue;
				const s = (j * sw + i) * bands;
				const v = data[s];
				if (v !== v || v === noData) continue;
				for (let b = 0; b < bands; b++) sum[b] += data[s + b];
				n++;
			}
		}
		const o = (y * w + x) * bands;
		for (let b = 0; b < bands; b++) out[o + b] = n ? store(sum[b] / n) : fill;
	}
	return {
		width: w,
		height: h,
		bands,
		data: out,
		noData: src.noData
	};
}
//#endregion
export { halveRaster, warpRaster };

//# sourceMappingURL=raster.js.map