import { warn } from "../warn.js";
import { histogram } from "../stats.js";
import { pipeline } from "../pipeline.js";
import { colorScalePalette } from "../color-scale.js";
import { classPalette, classRange } from "../color-classes.js";
import { createGpuRenderer } from "../gpu/renderer.js";
import EnhancedGeoTIFF from "./enhanced-geotiff.js";
import TileCorrection from "./tile-correction.js";
import { getIntersection, isEmpty } from "ol/extent.js";
import WebGLTileLayer from "ol/layer/WebGLTile.js";
import { listen, unlistenByKey } from "ol/events.js";
// src/openlayers/gpu-layer.ts
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
/** Layers made so far, for their own class names. */
let layerCount = 0;
/**
* `ol/layer/WebGLTile` that corrects the drawn map on the GPU with the
* pipeline of its {@link EnhancedGeoTIFF} source (created with
* `correctTiles: false`), or of its `correction` over any other tile source.
* Without WebGL2 it draws the tiles as read.
*/
var GpuCorrectedTileLayer = class extends WebGLTileLayer {
	output_ = document.createElement("canvas");
	/** Made the first time a frame is corrected or colored, so a layer that does neither holds no WebGL context of its own. */
	gpu_ = null;
	/** Whether WebGL2 could not be had (no use trying again), or the context is lost until the browser restores it. */
	noGpu_ = false;
	lost_ = false;
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
	colorScale_ = null;
	palette_ = null;
	/** The palette of the classes for the value range it was made for. */
	classPalette_ = null;
	blendMode_ = "normal";
	/** The class name that gives the layer a WebGL canvas of its own (see {@link GpuCorrectedTileLayer.getClassName}). */
	ownClass_ = `gpu-own-${++layerCount}`;
	constructor(options = {}) {
		const { correction, colorScale, blendMode, ...layerOptions } = options;
		super({
			className: "ol-layer gpu-corrected",
			...layerOptions
		});
		this.userStyle_ = options.style ?? {};
		this.correction_ = correction ?? null;
		this.correctionKey_ = correction ? listen(correction, "change", () => this.changed()) : null;
		this.useGpu_ = options.gpu !== false;
		if (colorScale) this.setColorScale(colorScale);
		if (blendMode) this.blendMode_ = blendMode;
		this.output_.addEventListener("webglcontextlost", (event) => {
			event.preventDefault();
			if (!this.gpu_) return;
			this.gpu_ = null;
			this.lost_ = true;
			warn("GpuCorrectedTileLayer: the WebGL context was lost; showing the tiles uncorrected until it is restored.");
			this.changed();
		});
		this.output_.addEventListener("webglcontextrestored", () => {
			this.lost_ = false;
			if (!this.disposed_) this.changed();
		});
	}
	/** The renderer, made when first needed; null without WebGL2 (or while the context is lost). */
	gpu() {
		if (!this.gpu_ && this.useGpu_ && !this.noGpu_ && !this.lost_ && !this.disposed_) {
			this.gpu_ = createGpuRenderer({ canvas: this.output_ });
			this.noGpu_ = !this.gpu_;
		}
		return this.gpu_;
	}
	/**
	* OpenLayers draws neighbouring WebGL layers of the same class name on one
	* canvas, so a layer that colors, corrects or blends what it drew would do
	* it to the layers under it too. Such a layer gets a class name of its own,
	* hence a canvas of its own; the others keep sharing one (a WebGL context
	* fewer each).
	*/
	getClassName() {
		const base = super.getClassName();
		return this.ownClass_ && this.ownsCanvas_() ? `${base} ${this.ownClass_}` : base;
	}
	/**
	* Whether the layer does something to its frame (see {@link GpuCorrectedTileLayer.getClassName}):
	* not an image left as it is, so many of those share one canvas (and WebGL context).
	*/
	ownsCanvas_() {
		if (this.palette_ || this.blendMode_ !== "normal" || this.correction_) return true;
		const source = this.getSource();
		return source instanceof EnhancedGeoTIFF && !source.correctsTiles() && (source.getPipeline().ops.length > 0 || source.getEffectivePipeline().ops.length > 0);
	}
	/** Whether the layer can correct on the GPU (WebGL2 is available and the context is not lost right now). */
	hasGpu() {
		return this.gpu() !== null;
	}
	/** The `correction` given in the options, or null. */
	getCorrection() {
		return this.correction_;
	}
	/**
	* Colors the corrected map with a color scale (pseudo-color): each pixel
	* by its gray value, black at one end of the scale and white at the other.
	* Meant for monochrome images (a SAR scene, one band); a colored image is
	* colored by its luminance. Null shows the image as corrected. Done on the
	* GPU after the correction, so a new scale only redraws the map; without
	* WebGL2 the map is shown uncolored.
	*/
	setColorScale(colorScale) {
		const classes = colorScale?.classes;
		this.palette_ = !colorScale ? null : classes ? classPalette(classes) : colorScalePalette(colorScale.scale, colorScale);
		this.colorScale_ = colorScale ? { ...colorScale } : null;
		this.classPalette_ = null;
		this.changed();
	}
	/** The color scale set with {@link GpuCorrectedTileLayer.setColorScale}, or null. */
	getColorScale() {
		return this.colorScale_ ? { ...this.colorScale_ } : null;
	}
	/**
	* Sets how the layer is laid over the layers under it (CSS
	* `mix-blend-mode` of its canvas). With `screen`, two scenes in red and
	* in cyan show white where both are bright and their own color where only
	* one is: a two-date color composite, without resampling either.
	*/
	setBlendMode(mode) {
		this.blendMode_ = mode;
		this.changed();
	}
	/** The blend mode set with {@link GpuCorrectedTileLayer.setBlendMode} (`normal` by default). */
	getBlendMode() {
		return this.blendMode_;
	}
	/** The canvas the corrected map is shown on (for reading pixels in tests). */
	getOutputCanvas() {
		return this.output_;
	}
	render(frameState, target) {
		return this.blend_(this.correct_(frameState, target));
	}
	/** Sets the blend mode on the element shown (OpenLayers may return none, for a frame it does not draw). */
	blend_(element) {
		if (!element?.style) return element;
		const mode = this.blendMode_ === "normal" ? "" : this.blendMode_;
		if (element.style.mixBlendMode !== mode) element.style.mixBlendMode = mode;
		return element;
	}
	correct_(frameState, target) {
		this.updateStretch_();
		const drawn = super.render(frameState, target);
		const source = this.getSource();
		if (!(drawn instanceof HTMLCanvasElement) || !frameState || !this.useGpu_ || this.noGpu_ || this.lost_) return drawn;
		const correcting = source instanceof EnhancedGeoTIFF ? source.correctsTiles() ? null : source : this.correction_;
		const classes = this.colorScale_?.classes ?? null;
		const palette = classes ? this.classPaletteFor_(classes) : this.palette_;
		if (!correcting && !palette) return drawn;
		if (!classes && correcting instanceof TileCorrection && correcting.wantsStats()) this.sampleStats_(drawn, correcting, frameState);
		const steps = correcting && !classes ? correcting.getEffectivePipeline() : pipeline();
		const colorMode = correcting ? correcting.getColorMode() : "rgb";
		if (steps.ops.length === 0 && !palette || !colorMode) return drawn;
		const gpu = this.gpu();
		if (!gpu || drawn.width > gpu.maxSize || drawn.height > gpu.maxSize) return drawn;
		gpu.setImage(drawn, { colorMode });
		gpu.render(steps, { palette });
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
		const classes = this.colorScale_?.classes;
		const fixed = classes ? classRange(classes) : null;
		const range = fixed ? {
			black: [
				fixed[0],
				fixed[0],
				fixed[0]
			],
			white: [
				fixed[1],
				fixed[1],
				fixed[1]
			]
		} : source.getRawStretch();
		const v = this.stretch_;
		v.ready = range ? 1 : 0;
		if (!range) return;
		for (let c = 0; c < 3; c++) {
			const span = range.white[c] - range.black[c];
			v[`b${c}`] = range.black[c];
			v[`s${c}`] = span > 0 ? 1 / span : 0;
		}
	}
	/**
	* The palette of `classes` for the values the drawn codes 0-255 stand for:
	* the classes' own range when the shader stretches raw values (see
	* `updateStretch_`), the source's raw stretch when it stretched the tiles
	* itself, else 0-255 (an 8-bit image as read).
	*/
	classPaletteFor_(classes) {
		const source = this.getSource();
		let range = [0, 255];
		if (source instanceof EnhancedGeoTIFF && source.stretchesOnGpu()) range = classRange(classes);
		else if (source instanceof EnhancedGeoTIFF) {
			const raw = source.getRawStretch();
			if (raw) range = [raw.black[0], raw.white[0]];
		}
		const key = range.join(",");
		if (this.classPalette_?.key !== key) this.classPalette_ = {
			key,
			palette: classPalette(classes, range)
		};
		return this.classPalette_.palette;
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
export { GpuCorrectedTileLayer as default };

//# sourceMappingURL=gpu-layer.js.map