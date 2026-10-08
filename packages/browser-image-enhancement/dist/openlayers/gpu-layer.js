import { warn } from "../warn.js";
import { histogram } from "../stats.js";
import { createGpuRenderer } from "../gpu/renderer.js";
import EnhancedGeoTIFF from "./enhanced-geotiff.js";
import TileCorrection from "./tile-correction.js";
import { getIntersection, isEmpty } from "ol/extent.js";
import WebGLTileLayer from "ol/layer/WebGLTile.js";
import { listen, unlistenByKey } from "ol/events.js";
//#region src/openlayers/gpu-layer.ts
/**
* WebGL tile layer that corrects the drawn map on the GPU.
*
* OpenLayers draws the tiles as read (an `EnhancedGeoTIFF` with
* `correctTiles: false`) into the layer's WebGL canvas; the layer then runs
* the source's pipeline over that canvas with `createGpuRenderer`, GPU to GPU,
* and shows the result instead. A new pipeline only redraws the map: no tile
* is reloaded or corrected again, so the image follows a slider.
*
* The correction works on screen pixels, after OpenLayers has resampled and
* reprojected the tiles. Per-pixel steps give the same result as correcting
* the tiles; DRA uses the statistics the source collected from the image.
* Sharpening, which looks at neighbouring pixels, works at screen resolution:
* its radius is in screen pixels, so it looks the same at every zoom level.
*
* Over 16-bit (or float) imagery the source hands the layer the raw values
* as float tiles (`gpuStretch`), and the layer's shader stretches them to
* 0-255 before anything else: at full precision, and a new stretch (DRA)
* only redraws the map.
*
* Over a source of ordinary pictures (`ol/source/ImageTile`: WMS, WMTS, XYZ
* tiles, loaded with `crossOrigin` so WebGL may read them), the layer takes
* its pipeline from a {@link TileCorrection} given as `correction`, and DRA
* takes its statistics from the map the layer has drawn.
*/
/**
* `ol/layer/WebGLTile` that corrects the drawn map on the GPU with the
* pipeline of its {@link EnhancedGeoTIFF} source (created with
* `correctTiles: false`), or of its `correction` over any other tile source.
* Without WebGL2 it draws the tiles as read.
*/
var GpuCorrectedTileLayer = class extends WebGLTileLayer {
	output_ = document.createElement("canvas");
	gpu_;
	correction_;
	correctionKey_;
	useGpu_;
	disposed_ = false;
	/** Small canvas the drawn map is read through for DRA statistics. */
	sample_ = null;
	/** The style given in the options, shown unless the shader stretches raw values. */
	userStyle_;
	/** Whether the raw-stretch style is set. */
	stretching_ = false;
	/** The raw-stretch style's variables, updated in place (the shader reads them on every draw). */
	stretch_ = {
		b0: 0,
		b1: 0,
		b2: 0,
		s0: 0,
		s1: 0,
		s2: 0,
		ready: 0
	};
	/** Frames corrected so far. */
	frames = 0;
	constructor(options = {}) {
		const { correction, ...layerOptions } = options;
		super({
			className: "ol-layer gpu-corrected",
			...layerOptions
		});
		this.userStyle_ = options.style ?? {};
		this.correction_ = correction ?? null;
		this.correctionKey_ = correction ? listen(correction, "change", () => this.changed()) : null;
		this.useGpu_ = options.gpu !== false;
		this.gpu_ = this.useGpu_ ? createGpuRenderer({ canvas: this.output_ }) : null;
		this.output_.addEventListener("webglcontextlost", (event) => {
			event.preventDefault();
			if (!this.gpu_) return;
			this.gpu_ = null;
			warn("GpuCorrectedTileLayer: the WebGL context was lost; showing the tiles uncorrected until it is restored.");
			this.changed();
		});
		this.output_.addEventListener("webglcontextrestored", () => {
			if (this.disposed_ || !this.useGpu_ || this.gpu_) return;
			this.gpu_ = createGpuRenderer({ canvas: this.output_ });
			this.changed();
		});
	}
	/** Whether the layer can correct on the GPU (WebGL2 is available and the context is not lost right now). */
	hasGpu() {
		return this.gpu_ !== null;
	}
	/** The `correction` given in the options, or null. */
	getCorrection() {
		return this.correction_;
	}
	/** The canvas the corrected map is shown on (for reading pixels in tests). */
	getOutputCanvas() {
		return this.output_;
	}
	render(frameState, target) {
		this.updateStretch_();
		const drawn = super.render(frameState, target);
		const source = this.getSource();
		const gpu = this.gpu_;
		if (!(drawn instanceof HTMLCanvasElement) || !gpu || !frameState) return drawn;
		const correcting = source instanceof EnhancedGeoTIFF ? source.correctsTiles() ? null : source : this.correction_;
		if (!correcting) return drawn;
		if (correcting instanceof TileCorrection && correcting.wantsStats()) this.sampleStats_(drawn, correcting, frameState);
		const pipeline = correcting.getEffectivePipeline();
		const colorMode = correcting.getColorMode();
		if (pipeline.ops.length === 0 || !colorMode) return drawn;
		if (drawn.width > gpu.maxSize || drawn.height > gpu.maxSize) return drawn;
		gpu.setImage(drawn, { colorMode });
		gpu.render(pipeline);
		this.frames++;
		const out = this.output_;
		out.className = drawn.className;
		out.style.cssText = drawn.style.cssText;
		return out;
	}
	/** Sets the raw-stretch style while the source hands raw float tiles, and its variables from the source's stretch. */
	updateStretch_() {
		const source = this.getSource();
		const stretching = source instanceof EnhancedGeoTIFF && source.stretchesOnGpu();
		if (stretching !== this.stretching_) {
			this.stretching_ = stretching;
			this.setStyle(stretching ? rawStretchStyle(this.stretch_) : this.userStyle_);
		}
		if (!stretching) return;
		const range = source.getRawStretch();
		const v = this.stretch_;
		v.ready = range ? 1 : 0;
		if (!range) return;
		for (let c = 0; c < 3; c++) {
			const span = range.white[c] - range.black[c];
			v[`b${c}`] = range.black[c];
			v[`s${c}`] = span > 0 ? 1 / span : 0;
		}
	}
	/** DRA statistics of the map as drawn (before correction), read through a canvas of at most 512 px. */
	sampleStats_(drawn, target, frameState) {
		const scale = Math.min(1, 512 / Math.max(drawn.width, drawn.height));
		const width = Math.max(1, Math.round(drawn.width * scale));
		const height = Math.max(1, Math.round(drawn.height * scale));
		if (!this.sample_) this.sample_ = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
		const ctx = this.sample_;
		if (!ctx) return;
		ctx.canvas.width = width;
		ctx.canvas.height = height;
		ctx.drawImage(drawn, 0, 0, width, height);
		const stats = histogram(ctx.getImageData(0, 0, width, height), { colorMode: "rgb" });
		const pixels = stats.count;
		if (pixels === 0) return;
		const extent = this.getExtent();
		const visible = frameState.extent ?? [
			0,
			0,
			0,
			0
		];
		const area = extent ? getIntersection(visible, extent) : visible;
		target.setStats(stats, {
			extent: isEmpty(area) ? visible : area,
			z: frameState.viewState.zoom,
			tiles: 0,
			pixels
		});
	}
	disposeInternal() {
		this.disposed_ = true;
		if (this.correctionKey_) unlistenByKey(this.correctionKey_);
		this.gpu_?.dispose();
		this.gpu_ = null;
		super.disposeInternal();
	}
};
/**
* The style that stretches raw float tiles (R, G, B, alpha) to 0-1: each band
* linearly from its black to its white, clipped; transparent until the
* stretch is known (`ready` 0).
*/
function rawStretchStyle(variables) {
	const band = (c) => [
		"clamp",
		[
			"*",
			[
				"-",
				["band", c + 1],
				["var", `b${c}`]
			],
			["var", `s${c}`]
		],
		0,
		1
	];
	return {
		variables,
		color: [
			"array",
			band(0),
			band(1),
			band(2),
			[
				"*",
				["band", 4],
				["var", "ready"]
			]
		]
	};
}
//#endregion
export { GpuCorrectedTileLayer as default };

//# sourceMappingURL=gpu-layer.js.map