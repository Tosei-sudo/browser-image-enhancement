import { createImageData } from "./workers/src/image.js";
import { toImageData } from "./workers/src/io.js";
import { histogram } from "./stats.js";
import { downscale } from "./preview.js";
import { createPreviewRunner } from "./pipeline.js";
import { createGpuRenderer } from "./gpu/renderer.js";
//#region src/editor.ts
/**
* An editor for slider-driven corrections: it picks the fastest way to show
* the image (WebGL2 at full size, or a shrunk preview in workers) and keeps the
* exact JS engine for the final result, so callers need not combine
* `createGpuRenderer`, `createPreviewRunner` and `run` themselves.
*/
/**
* Creates an editor that shows corrections as fast as the browser allows.
*
* @example
* ```ts
* const editor = createEditor({ canvas: document.querySelector('canvas')! });
* await editor.setImage(file);
* slider.oninput = () => editor.render(pipeline().exposure(Number(slider.value)));
* save.onclick = async () => download(await editor.export(current(), { output: 'blob' }));
* ```
*/
function createEditor(options = {}) {
	return new EditorImpl(options);
}
const DEFAULT_PREVIEW_SIZE = 1280;
const DEFAULT_SETTLE_DELAY = 250;
var EditorImpl = class {
	options;
	canvas;
	engine;
	image = null;
	gpu = null;
	/** Scale of the image uploaded to the GPU (1 unless the GPU limits its size). */
	gpuScale = 1;
	stats = null;
	/** Counts setImage calls, so a slower earlier decode does not win. */
	imageGeneration = 0;
	last = null;
	generation = 0;
	frame = 0;
	pendingFrame = null;
	settleTimer;
	preview;
	full;
	disposed = false;
	constructor(options) {
		this.options = options;
		this.canvas = options.canvas ?? document.createElement("canvas");
		const runOptions = {
			colorMode: options.colorMode,
			worker: options.worker
		};
		this.preview = createPreviewRunner({
			...runOptions,
			maxSize: options.previewSize ?? DEFAULT_PREVIEW_SIZE
		});
		this.full = createPreviewRunner(runOptions);
		this.engine = "cpu";
		if (options.engine !== "cpu") {
			this.gpu = createGpuRenderer({ canvas: this.canvas });
			if (this.gpu) {
				this.engine = "gpu";
				this.canvas.addEventListener("webglcontextlost", this.onContextLost);
			}
		}
	}
	async setImage(input) {
		this.check();
		const generation = ++this.imageGeneration;
		const decoded = await toImageData(input);
		this.check();
		if (generation !== this.imageGeneration) return;
		this.image = decoded instanceof ImageData ? decoded : createImageData(decoded.data, decoded.width, decoded.height);
		this.stats = null;
		this.uploadToGpu();
		if (this.last) this.render(this.last);
	}
	render(p) {
		this.check();
		if (!this.image) return Promise.reject(/* @__PURE__ */ new Error("Call setImage before render."));
		this.last = p;
		const mine = ++this.generation;
		clearTimeout(this.settleTimer);
		const t0 = performance.now();
		if (this.engine === "gpu") return this.renderGpu(p, t0);
		return this.renderCpu(p, mine, t0);
	}
	export(p, options) {
		this.check();
		if (!this.image) return Promise.reject(/* @__PURE__ */ new Error("Call setImage before export."));
		const opts = {
			colorMode: this.options.colorMode,
			worker: this.options.worker,
			...options
		};
		return p.run(this.image, opts);
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.generation++;
		clearTimeout(this.settleTimer);
		cancelAnimationFrame(this.frame);
		this.pendingFrame?.done(false);
		this.pendingFrame = null;
		this.preview.cancel();
		this.full.cancel();
		this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
		this.gpu?.dispose();
		this.gpu = null;
		this.image = null;
	}
	/** `p` with `autoStretch` fixed from the full-size image, so every preview size gets the same range. */
	resolved(p) {
		if (!p.needsStats) return p;
		this.stats ??= histogram(this.image, { colorMode: this.options.colorMode });
		return p.resolve(this.stats);
	}
	uploadToGpu() {
		if (!this.gpu || !this.image) return;
		const { image, scale } = downscale(this.image, this.gpu.maxSize);
		this.gpuScale = scale;
		this.gpu.setImage(image, { colorMode: this.options.colorMode });
	}
	/** Draws on the next animation frame; a newer call before it replaces `p`. */
	renderGpu(p, t0) {
		return new Promise((resolve) => {
			this.pendingFrame?.done(false);
			this.pendingFrame = {
				p,
				t0,
				done: resolve
			};
			if (this.frame) return;
			this.frame = requestAnimationFrame(() => {
				this.frame = 0;
				const job = this.pendingFrame;
				this.pendingFrame = null;
				if (!job || this.disposed) return job?.done(false);
				const gpu = this.gpu;
				if (!gpu) {
					this.renderCpu(job.p, this.generation, job.t0).then(job.done);
					return;
				}
				gpu.render(this.resolved(job.p).scaled(this.gpuScale));
				this.notify("gpu", gpu.canvas.width, gpu.canvas.height, job.t0);
				job.done(true);
			});
		});
	}
	async renderCpu(p, mine, t0) {
		this.full.cancel();
		const image = this.image;
		const resolved = this.resolved(p);
		const result = await this.preview.run(resolved, image);
		if (!result || mine !== this.generation) return false;
		this.draw(result);
		const preview = result.width < image.width;
		this.notify("cpu", result.width, result.height, t0, preview);
		const delay = this.options.settleDelay ?? DEFAULT_SETTLE_DELAY;
		if (preview && delay >= 0) this.settleTimer = setTimeout(() => {
			const start = performance.now();
			this.full.run(resolved, image).then((full) => {
				if (!full || mine !== this.generation) return;
				this.draw(full);
				this.notify("cpu", full.width, full.height, start, false);
			}, () => {});
		}, delay);
		return true;
	}
	draw(image) {
		const c = this.canvas;
		if (c.width !== image.width) c.width = image.width;
		if (c.height !== image.height) c.height = image.height;
		const ctx = c.getContext("2d");
		if (!ctx) throw new Error("The editor canvas has no 2D context.");
		ctx.putImageData(image instanceof ImageData ? image : createImageData(image.data, image.width, image.height), 0, 0);
	}
	notify(engine, width, height, t0, preview = width < (this.image?.width ?? width)) {
		this.options.onRender?.({
			engine,
			width,
			height,
			preview,
			ms: performance.now() - t0
		});
	}
	onContextLost = () => {
		const old = this.canvas;
		old.removeEventListener("webglcontextlost", this.onContextLost);
		const next = document.createElement("canvas");
		next.className = old.className;
		next.style.cssText = old.style.cssText;
		old.replaceWith(next);
		this.canvas = next;
		this.gpu = null;
		this.engine = "cpu";
		if (this.last && this.image) this.render(this.last);
	};
	check() {
		if (this.disposed) throw new Error("The editor was disposed.");
	}
};
//#endregion
export { createEditor };

//# sourceMappingURL=editor.js.map