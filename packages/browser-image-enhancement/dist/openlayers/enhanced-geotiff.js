import { mergeHistograms } from "../core/histogram.js";
import { histogram } from "../stats.js";
import { pipeline } from "../pipeline.js";
import { computeRasterStretch, mergeRasterHistograms, rasterHistogram, rasterRange, rasterToImageData } from "../raster.js";
import { cropMargin, withMargin } from "./margin.js";
import GeoTIFF from "ol/source/GeoTIFF.js";
import { getHeight, getIntersection, getWidth, isEmpty } from "ol/extent.js";
import { transformExtent } from "ol/proj.js";
//#region src/openlayers/enhanced-geotiff.ts
/**
* OpenLayers GeoTIFF source that runs a browser-image-enhancement pipeline on
* every tile before it is drawn.
*
* The source reads the COG exactly like `ol/source/GeoTIFF` (range requests,
* overviews, nodata/mask handling, normalization to 0-255) and then corrects
* the decoded tile. Raw tiles are kept in a small cache, so changing the
* pipeline only re-runs the correction instead of fetching the COG again.
*
* DRA (dynamic range adjustment): when the pipeline has an `autoStretch` step,
* `updateDra(map)` collects the statistics of the area the map shows and fixes
* the stretch from them. Every tile then gets the same range, so there are no
* seams; tiles are never stretched on their own statistics.
*
* Sharpening reads neighbouring pixels, so each tile is corrected with
* `pipeline.margin` pixels of its neighbour tiles around it (read through the
* same raw cache) and cropped back: tile edges match the whole image exactly.
*
* With `normalize: false` the source reads the raw values (16-bit, float)
* and stretches them to 0-255 itself, from statistics of the raw values:
* those of the whole image until the first `updateDra`, then those of the
* visible area. Tiles are then corrected as usual.
*
* With `correctTiles: false` tiles are left as read and only the pipeline is
* kept (DRA included): `GpuCorrectedTileLayer` then corrects the drawn map on
* the GPU, so a new pipeline needs no tile to be reloaded.
*/
/**
* `ol/source/GeoTIFF` that corrects its tiles with a pipeline. Needs
* `normalize: true` (the default). Call {@link EnhancedGeoTIFF.updateDra} on the
* map's `moveend` when the pipeline has `autoStretch`.
*/
var EnhancedGeoTIFF = class extends GeoTIFF {
	pipeline_;
	/** The pipeline tiles are corrected with: `pipeline_` with `autoStretch` fixed from the DRA statistics. */
	effective_;
	worker_;
	correctTiles_;
	rawCacheSize_;
	draSampleSize_;
	draMaxTiles_;
	raw_ = /* @__PURE__ */ new Map();
	rawLoader_ = null;
	draStats_ = null;
	draInfo_ = null;
	draKey_ = "";
	draRequest_ = 0;
	/** The key tiles were last corrected (or drawn) for. */
	appliedKey_ = "";
	/** True with `normalize: false`: tiles hold raw values that are stretched here. */
	rawValues_;
	rawStretchOption_;
	/** The raw stretch in use; null until the first statistics are read. */
	rawStretch_ = null;
	rawStretchReady_ = null;
	/** How many tiles were read and corrected, and the time it took. */
	stats = {
		tiles: 0,
		ms: 0,
		reads: 0
	};
	constructor(options) {
		if (options.normalize === false && options.correctTiles === false) throw new TypeError("EnhancedGeoTIFF with normalize: false corrects tiles itself; it cannot be used with correctTiles: false.");
		super(options);
		this.rawValues_ = options.normalize === false;
		this.rawStretchOption_ = options.rawStretch ?? {};
		if ("black" in this.rawStretchOption_ && "white" in this.rawStretchOption_) this.rawStretch_ = this.rawStretchOption_;
		this.pipeline_ = options.pipeline ?? pipeline();
		this.worker_ = options.worker ?? true;
		this.correctTiles_ = options.correctTiles ?? true;
		this.rawCacheSize_ = options.rawCacheSize ?? 256;
		this.draSampleSize_ = options.draSampleSize ?? 1024;
		this.draMaxTiles_ = options.draMaxTiles ?? 64;
		this.effective_ = this.pipeline_.resolve(null);
		this.appliedKey_ = this.tileKey_();
		if (this.correctTiles_) this.setKey(this.appliedKey_);
	}
	/** The tile key: changes whenever tiles must be corrected again. */
	tileKey_() {
		return `${keyFor(this.effective_)}${this.rawValues_ ? `:raw${JSON.stringify(this.rawStretch_)}` : ""}`;
	}
	/** True when the raw stretch is computed from statistics (normalize: false without a fixed stretch). */
	get autoRaw_() {
		return this.rawValues_ && !("black" in this.rawStretchOption_ && "white" in this.rawStretchOption_);
	}
	/** Whether tiles are corrected as they load (false: the layer corrects the drawn map). */
	correctsTiles() {
		return this.correctTiles_;
	}
	/** How the image is corrected: decided by its band count, the same for every tile. Null before the COG is read. */
	getColorMode() {
		return this.getState() === "ready" ? colorModeFor(this.bandCount) : null;
	}
	/** The correction as set, before `autoStretch` is fixed from statistics. */
	getPipeline() {
		return this.pipeline_;
	}
	/**
	* Replaces the correction. Tiles on screen stay visible until their
	* re-corrected versions are ready, then swap in.
	*/
	setPipeline(p) {
		this.pipeline_ = p;
		this.refresh_();
	}
	/** The pipeline tiles are corrected with now, with any `autoStretch` already fixed. */
	getEffectivePipeline() {
		return this.effective_;
	}
	/** What the current DRA statistics were taken from; null before the first `updateDra`. */
	getDraInfo() {
		return this.draInfo_;
	}
	/**
	* Collects the statistics of the area `map` shows and fixes the pipeline's
	* `autoStretch` steps from them. Call it on the map's `moveend`. Does nothing
	* when the pipeline has no `autoStretch` or the visible area has not changed.
	* Tiles are re-corrected only when the resulting range changes.
	*/
	async updateDra(map) {
		if (!this.pipeline_.needsStats && !this.autoRaw_) return;
		const request = ++this.draRequest_;
		const grid = this.getTileGrid();
		const projection = this.getProjection();
		const size = map.getSize();
		if (!this.rawLoader_ || !grid || !projection || !size || this.getState() !== "ready") return;
		const view = map.getView();
		const visible = transformExtent(view.calculateExtent(size), view.getProjection(), projection);
		const area = getIntersection(visible, grid.getExtent());
		if (isEmpty(area)) return;
		const z = this.draZoom_(area);
		const key = `${z}:${area.join(",")}`;
		if (key === this.draKey_ && (this.draStats_ || !this.pipeline_.needsStats)) return;
		const stats = await this.collectStats_(area, z);
		if (request !== this.draRequest_) return;
		this.draKey_ = key;
		this.applyStats_(stats);
	}
	/** Statistics of `area` read at level `z`: the raw stretch (normalize: false) and the 8-bit histogram. */
	async collectStats_(area, z) {
		const loader = this.rawLoader_;
		const grid = this.getTileGrid();
		const parts = [];
		grid.forEachTileCoord(area, z, ([tz, x, y]) => {
			const tileExtent = grid.getTileCoordExtent([
				tz,
				x,
				y
			]);
			const res = grid.getResolution(tz);
			const [width, height] = this.getTileSize(tz);
			const rect = {
				x: (area[0] - tileExtent[0]) / res,
				y: (tileExtent[3] - area[3]) / res,
				width: (area[2] - area[0]) / res,
				height: (area[3] - area[1]) / res
			};
			parts.push(this.rawTile_(loader, tz, x, y, {
				signal: neverAborted,
				crossOrigin: "anonymous"
			}).then((raw) => ({
				raw,
				rect,
				width,
				height
			}), () => null));
		});
		const tiles = (await Promise.all(parts)).filter((t) => t !== null);
		let rawStretch = this.rawStretch_;
		let rawInfo;
		if (this.autoRaw_) {
			const rasters = tiles.flatMap((t) => {
				const r = this.raster_(t.raw, t.width, t.height);
				return r ? [{
					r,
					rect: t.rect
				}] : [];
			});
			let lo = Infinity;
			let hi = -Infinity;
			for (const { r, rect } of rasters) {
				const range = rasterRange(r, rect);
				if (range) [lo, hi] = [Math.min(lo, range[0]), Math.max(hi, range[1])];
			}
			if (lo <= hi) {
				const merged = mergeRasterHistograms(rasters.map(({ r, rect }) => rasterHistogram(r, {
					range: [lo, hi],
					rect
				})));
				rawInfo = computeRasterStretch(merged, this.rawStretchOption_);
				rawStretch = rawInfo;
			}
		}
		const histograms = [];
		let pixels = 0;
		for (const t of tiles) {
			const rgba = this.tileRGBA_(t.raw, t.width, t.height, rawStretch);
			if (!rgba) continue;
			const h = histogram({
				data: rgba.data,
				width: t.width,
				height: t.height
			}, {
				rect: t.rect,
				colorMode: colorModeFor(rgba.bands)
			});
			histograms.push(h);
			pixels += h.count;
		}
		return {
			info: {
				extent: area,
				z,
				tiles: histograms.length,
				pixels,
				...rawInfo ? { rawStretch: rawInfo } : {}
			},
			rawStretch,
			histogram: mergeHistograms(histograms)
		};
	}
	applyStats_(stats) {
		this.draStats_ = stats.histogram;
		this.draInfo_ = stats.info;
		if (this.autoRaw_ && stats.rawStretch) this.rawStretch_ = stats.rawStretch;
		this.refresh_();
	}
	/** Normalize: false: waits for the first raw stretch, from the statistics of the whole image. */
	rawReady_() {
		if (!this.rawValues_ || this.rawStretch_) return Promise.resolve();
		this.rawStretchReady_ ??= (async () => {
			const area = this.getTileGrid().getExtent();
			const stats = await this.collectStats_(area, this.draZoom_(area));
			if (!this.rawStretch_) {
				this.rawStretch_ = stats.rawStretch ?? {
					black: 0,
					white: 1
				};
				this.draInfo_ ??= stats.info;
				this.draStats_ ??= stats.histogram;
				this.effective_ = this.pipeline_.resolve(this.draStats_);
				this.appliedKey_ = this.tileKey_();
			}
		})();
		return this.rawStretchReady_;
	}
	/** The raw tile as a {@link Raster} (normalize: false), or null when its band layout is not gray or RGB. */
	raster_(raw, width, height) {
		if (!(raw instanceof Float32Array)) return null;
		const bands = raw.length / (width * height);
		const color = bands - (this.hasAlpha ? 1 : 0);
		if (!Number.isInteger(bands) || color !== 1 && color !== 3) return null;
		return {
			data: raw,
			width,
			height,
			bands,
			alpha: this.hasAlpha
		};
	}
	/**
	* The tile's pixels as RGBA and its band count, or null for tiles the
	* pipeline cannot take (multispectral). Raw tiles are stretched with `rawStretch`.
	*/
	tileRGBA_(raw, width, height, rawStretch = this.rawStretch_) {
		if (this.rawValues_) {
			const r = this.raster_(raw, width, height);
			if (!r || !rawStretch) return null;
			return {
				data: rasterToImageData(r, { stretch: rawStretch }).data,
				bands: r.bands
			};
		}
		if (!(raw instanceof Uint8Array) && !(raw instanceof Uint8ClampedArray)) return null;
		const bands = raw.length / (width * height);
		if (!Number.isInteger(bands) || bands < 1 || bands > 4) return null;
		return {
			data: toRGBA(raw, bands, width * height),
			bands
		};
	}
	/** The finest level that is no finer than the sample size, coarsened until the tile count fits. */
	draZoom_(area) {
		const grid = this.getTileGrid();
		const target = Math.max(getWidth(area), getHeight(area)) / this.draSampleSize_;
		let z = grid.getMinZoom();
		for (let k = grid.getMaxZoom(); k >= grid.getMinZoom(); k--) if (grid.getResolution(k) >= target) {
			z = k;
			break;
		}
		const count = (k) => {
			let n = 0;
			grid.forEachTileCoord(area, k, () => n++);
			return n;
		};
		while (z > grid.getMinZoom() && count(z) > this.draMaxTiles_) z--;
		return z;
	}
	/** Re-resolves the pipeline; tiles are re-corrected only if the result changed. */
	refresh_() {
		const next = this.pipeline_.resolve(this.draStats_);
		this.effective_ = next;
		const key = this.tileKey_();
		if (key === this.appliedKey_) return;
		this.appliedKey_ = key;
		if (this.correctTiles_) this.setKey(key);
		else this.changed();
	}
	/** Sets the tile count and time in {@link EnhancedGeoTIFF.stats} back to zero. */
	resetStats() {
		this.stats.tiles = 0;
		this.stats.ms = 0;
	}
	/** Called by the GeoTIFF source once the COG's metadata is read; wraps its tile loader. */
	setLoader(loader) {
		this.rawLoader_ = loader;
		super.setLoader((z, x, y, options) => this.loadEnhanced_(loader, z, x, y, options));
	}
	async loadEnhanced_(loader, z, x, y, options) {
		const [raw] = await Promise.all([this.rawTile_(loader, z, x, y, options), this.rawReady_()]);
		const p = this.effective_;
		if (p.ops.length === 0 && !this.rawValues_ || !this.correctTiles_) return raw;
		const [width, height] = this.getTileSize(z);
		const tile = this.tileRGBA_(raw, width, height);
		if (!tile) return raw;
		const { data: rgba, bands } = tile;
		if (p.ops.length === 0) return fromRGBA(rgba, bands, width * height);
		const t0 = performance.now();
		const margin = p.margin;
		const input = margin > 0 ? {
			data: await this.withNeighbours_(loader, z, x, y, rgba, margin),
			width: width + 2 * margin,
			height: height + 2 * margin
		} : {
			data: rgba,
			width,
			height
		};
		const result = await p.run(input, {
			colorMode: colorModeFor(bands),
			worker: this.worker_,
			signal: options.signal
		});
		this.stats.tiles++;
		this.stats.ms += performance.now() - t0;
		return fromRGBA(cropMargin(result.data, width, height, margin), bands, width * height);
	}
	/** The tile's pixels with `margin` pixels of its neighbour tiles around it; transparent where there are none. */
	async withNeighbours_(loader, z, x, y, rgba, margin) {
		const [width, height] = this.getTileSize(z);
		const range = this.getTileGrid()?.getFullTileRange(z);
		const nx = Math.ceil(margin / width);
		const ny = Math.ceil(margin / height);
		const tiles = /* @__PURE__ */ new Map();
		const reads = [];
		for (let dy = -ny; dy <= ny; dy++) for (let dx = -nx; dx <= nx; dx++) {
			const key = `${dx},${dy}`;
			if (dx === 0 && dy === 0) {
				tiles.set(key, rgba);
				continue;
			}
			if (!range || !range.containsXY(x + dx, y + dy)) continue;
			reads.push(this.rawTile_(loader, z, x + dx, y + dy, {
				signal: neverAborted,
				crossOrigin: "anonymous"
			}).then((raw) => {
				const t = this.tileRGBA_(raw, width, height);
				if (t) tiles.set(key, t.data);
			}, () => {}));
		}
		await Promise.all(reads);
		return withMargin((dx, dy) => tiles.get(`${dx},${dy}`) ?? null, width, height, margin);
	}
	rawTile_(loader, z, x, y, options) {
		const key = `${z}/${x}/${y}`;
		const cached = this.raw_.get(key);
		if (cached) {
			this.raw_.delete(key);
			this.raw_.set(key, cached);
			return cached;
		}
		this.stats.reads++;
		const promise = Promise.resolve(loader(z, x, y, {
			...options,
			signal: neverAborted
		}));
		this.raw_.set(key, promise);
		promise.catch(() => {
			if (this.raw_.get(key) === promise) this.raw_.delete(key);
		});
		while (this.raw_.size > this.rawCacheSize_) this.raw_.delete(this.raw_.keys().next().value);
		return promise;
	}
};
const neverAborted = new AbortController().signal;
const keyFor = (p) => `enhanced:${JSON.stringify(p.ops)}`;
/** 1 band = gray, 2 = gray + alpha, 3 = RGB, 4 = RGB + alpha (OpenLayers adds alpha for nodata). */
function colorModeFor(bands) {
	return bands <= 2 ? "gray" : "rgb";
}
function toRGBA(src, bands, pixels) {
	const out = new Uint8ClampedArray(pixels * 4);
	for (let p = 0, i = 0, o = 0; p < pixels; p++, i += bands, o += 4) if (bands <= 2) {
		out[o] = out[o + 1] = out[o + 2] = src[i];
		out[o + 3] = bands === 2 ? src[i + 1] : 255;
	} else {
		out[o] = src[i];
		out[o + 1] = src[i + 1];
		out[o + 2] = src[i + 2];
		out[o + 3] = bands === 4 ? src[i + 3] : 255;
	}
	return out;
}
function fromRGBA(rgba, bands, pixels) {
	if (bands === 4) return new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.length);
	const out = new Uint8Array(pixels * bands);
	for (let p = 0, i = 0, o = 0; p < pixels; p++, i += 4, o += bands) for (let b = 0; b < bands; b++) out[o + b] = bands <= 2 && b === 1 ? rgba[i + 3] : rgba[i + b];
	return out;
}
//#endregion
export { EnhancedGeoTIFF as default, fromRGBA, toRGBA };

//# sourceMappingURL=enhanced-geotiff.js.map