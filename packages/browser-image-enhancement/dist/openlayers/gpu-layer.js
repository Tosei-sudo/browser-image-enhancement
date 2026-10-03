import { createGpuRenderer } from "../gpu/renderer.js";
import EnhancedGeoTIFF from "./enhanced-geotiff.js";
import WebGLTileLayer from "ol/layer/WebGLTile.js";
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
*/
/**
* `ol/layer/WebGLTile` that corrects the drawn map on the GPU with the
* pipeline of its {@link EnhancedGeoTIFF} source (created with
* `correctTiles: false`). Without WebGL2 it draws the tiles as read.
*/
var GpuCorrectedTileLayer = class extends WebGLTileLayer {
	output_ = document.createElement("canvas");
	gpu_;
	/** Frames corrected so far. */
	frames = 0;
	constructor(options = {}) {
		super({
			className: "ol-layer gpu-corrected",
			...options
		});
		this.gpu_ = options.gpu === false ? null : createGpuRenderer({ canvas: this.output_ });
		this.output_.addEventListener("webglcontextlost", () => {
			this.gpu_ = null;
			this.changed();
		});
	}
	/** Whether the layer can correct on the GPU (WebGL2 is available and the context was not lost). */
	hasGpu() {
		return this.gpu_ !== null;
	}
	/** The canvas the corrected map is shown on (for reading pixels in tests). */
	getOutputCanvas() {
		return this.output_;
	}
	render(frameState, target) {
		const drawn = super.render(frameState, target);
		const source = this.getSource();
		const gpu = this.gpu_;
		if (!(drawn instanceof HTMLCanvasElement) || !gpu || !(source instanceof EnhancedGeoTIFF) || source.correctsTiles()) return drawn;
		const pipeline = source.getEffectivePipeline();
		const colorMode = source.getColorMode();
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
	disposeInternal() {
		this.gpu_?.dispose();
		this.gpu_ = null;
		super.disposeInternal();
	}
};
//#endregion
export { GpuCorrectedTileLayer as default };

//# sourceMappingURL=gpu-layer.js.map