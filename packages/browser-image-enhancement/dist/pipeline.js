import { abortError } from "./workers/src/abort.js";
import { assertImageData, createImageData } from "./workers/src/image.js";
import { toBlob, toCanvas, toImageData } from "./workers/src/io.js";
import { opInfo } from "./ops/info.js";
import { isIdentity, marginOf, normalizeOp } from "./ops/index.js";
import { extractGray } from "./core/process.js";
import { needsStats, resolveOps } from "./core/histogram.js";
import { applySync, warnColorOnly } from "./functional.js";
import { downscale } from "./preview.js";
import { execute } from "./worker/executor.js";
//#region src/pipeline.ts
/**
* Pipeline API: declare a chain of corrections, then run it in one pass
* (no 8-bit rounding between steps), in Web Workers by default.
*/
/**
* An immutable chain of corrections. Each method returns a new pipeline with
* one more step; `run()` applies all steps in one pass in linear light, so no
* precision is lost to 8-bit rounding between steps.
*
* @example
* ```ts
* const p = pipeline().exposure(0.5).contrast(0.2).saturation(0.1);
* const out = await p.run(img, { output: 'canvas' });
* ```
*/
var Pipeline = class Pipeline {
	/** The normalized steps, in order. */
	ops;
	/** Use `pipeline()` or `Pipeline.fromJSON()`. */
	constructor(ops = []) {
		this.ops = Object.freeze(ops.map(normalizeOp));
	}
	/** Restores a pipeline saved with `toJSON()` (object or JSON string). */
	static fromJSON(json) {
		const parsed = typeof json === "string" ? JSON.parse(json) : json;
		if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.ops)) throw new TypeError("Not a browser-image-enhancement pipeline (expected { version: 1, ops: [...] }).");
		return new Pipeline(parsed.ops);
	}
	/** Returns a new pipeline with `op` appended. Pipelines are immutable. */
	add(op) {
		return new Pipeline([...this.ops, op]);
	}
	/** Brightness, -1 to 1. */
	brightness(amount) {
		return this.add({
			op: "brightness",
			amount
		});
	}
	/** Contrast, -1 to 1. */
	contrast(amount) {
		return this.add({
			op: "contrast",
			amount
		});
	}
	/** Exposure in EV stops, -10 to 10. */
	exposure(ev) {
		return this.add({
			op: "exposure",
			ev
		});
	}
	/** Gamma, 0.1 to 10. */
	gamma(value) {
		return this.add({
			op: "gamma",
			gamma: value
		});
	}
	/** Saturation, -1 to 1. No effect on monochrome images. */
	saturation(amount) {
		return this.add({
			op: "saturation",
			amount
		});
	}
	/** Color temperature, -1 (cool) to 1 (warm). No effect on monochrome images. */
	temperature(amount) {
		return this.add({
			op: "temperature",
			amount
		});
	}
	/** Tint, -1 (green) to 1 (magenta): the color axis temperature does not cover. No effect on monochrome images. */
	tint(amount) {
		return this.add({
			op: "tint",
			amount
		});
	}
	/**
	* White balance from a gray point: `gray` is the color (sRGB-encoded, 0-1)
	* of something that should be neutral, for example from `sampleColor` on the
	* image. Put it first so it sees the colors of the original image. No effect
	* on monochrome images.
	*/
	whiteBalance(gray) {
		return this.add({
			op: "whiteBalance",
			...gray
		});
	}
	/** Shadows, -1 (darker) to 1 (lifted): moves dark tones, leaving black, white and highlights almost unchanged. */
	shadows(amount) {
		return this.add({
			op: "shadows",
			amount
		});
	}
	/** Highlights, -1 (recovered, darker) to 1 (brighter): moves light tones, leaving black, white and shadows almost unchanged. */
	highlights(amount) {
		return this.add({
			op: "highlights",
			amount
		});
	}
	/**
	* Tone curve (see {@link CurveOptions}): points `[input, output]` on the
	* sRGB 0-1 scale joined by a smooth curve, for all channels and per channel.
	*
	* @example
	* ```ts
	* pipeline().curve({ points: [[0.25, 0.2], [0.75, 0.8]] }); // gentle S curve: more contrast
	* ```
	*/
	curve(options) {
		return this.add({
			op: "curve",
			...options
		});
	}
	/** Levels (black/white points 0-1, midtone gamma). */
	levels(params) {
		return this.add({
			op: "levels",
			...params
		});
	}
	/**
	* Stretches the range black..white (sRGB-encoded, one number or [R, G, B])
	* to full black..white.
	*/
	stretch(params) {
		return this.add({
			op: "stretch",
			...params
		});
	}
	/**
	* Automatic stretch (dynamic range adjustment). The range comes from the
	* pixel distribution of the image as it reaches this step, ignoring
	* transparent pixels. `run` takes the statistics from the image it is given;
	* for tiles, collect statistics over the area you show and call `resolve`.
	*/
	autoStretch(options) {
		return this.add({
			op: "autoStretch",
			...options
		});
	}
	/**
	* Sharpens with an unsharp mask (see {@link SharpenOptions}). Run on its own
	* image, the result is the same whether or not it is split across workers.
	* For tiles of a larger picture, give each tile {@link Pipeline.margin}
	* pixels of its neighbours so the tile edges do not show.
	*/
	sharpen(options) {
		return this.add({
			op: "sharpen",
			...options
		});
	}
	/**
	* Pixels of context the pipeline needs around each part of a picture: when
	* a tile is run with this many pixels of its neighbours on every side (and
	* the margin is cropped off afterwards), it matches the same area of the
	* whole picture run at once, so tile seams cannot show. 0 unless the
	* pipeline has `sharpen` steps.
	*/
	get margin() {
		return marginOf(this.ops);
	}
	/**
	* Returns a pipeline with step `op` set to `params`: the first step of that
	* kind is updated in place (parameters not given keep their values), or the
	* step is appended when the pipeline has none. Made for controls: each
	* slider sets its own step without rebuilding the chain.
	*
	* Steps with one main value (`brightness`, `contrast`, `exposure`, `gamma`,
	* `saturation`, `temperature`, `sharpen`, ...) also take that value as a number;
	* {@link OpInfo.value} names it.
	*
	* @example
	* ```ts
	* let p = pipeline().exposure(0).contrast(0).sharpen({ amount: 0 });
	* p = p.set('contrast', 0.3);                // same as { amount: 0.3 }
	* p = p.set('sharpen', { radius: 2 });       // amount stays 0
	* p = p.set('levels', { inBlack: 0.05 });    // appended: there was no levels step
	* ```
	*/
	set(op, params) {
		const info = opInfo[op];
		if (!info) throw new TypeError(`Unknown correction: ${String(op)}`);
		let given;
		if (typeof params === "number") {
			if (!info.value) throw new TypeError(`${op} takes an object of parameters, not a number.`);
			given = { [info.value]: params };
		} else given = params ?? {};
		const i = this.ops.findIndex((s) => s.op === op);
		const next = [...this.ops];
		if (i < 0) next.push({
			...given,
			op
		});
		else next[i] = {
			...next[i],
			...given,
			op
		};
		return new Pipeline(next);
	}
	/** The first step of kind `op`, with its normalized parameters, or undefined when there is none. */
	get(op) {
		return this.ops.find((s) => s.op === op);
	}
	/** Returns a pipeline without any step of kind `op`. */
	remove(op) {
		return this.ops.some((s) => s.op === op) ? new Pipeline(this.ops.filter((s) => s.op !== op)) : this;
	}
	/** True when no step changes the image (an empty pipeline, or every step at its neutral value). */
	get isIdentity() {
		return this.ops.every(isIdentity);
	}
	/**
	* The same correction for the image shrunk by `factor` (0.5 = half the
	* width and height): pixel distances (the `sharpen` radius) are scaled with
	* it, so a preview on a smaller copy looks like the full-size result.
	*/
	scaled(factor) {
		if (!(factor > 0) || factor === 1) return this;
		return new Pipeline(this.ops.map((op) => op.op === "sharpen" ? {
			...op,
			radius: Math.min(50, Math.max(.1, op.radius * factor))
		} : op));
	}
	/** True when the pipeline has `autoStretch` steps that still need statistics. */
	get needsStats() {
		return needsStats(this.ops);
	}
	/**
	* Returns a pipeline with every `autoStretch` replaced by a fixed `stretch`
	* computed from `stats`, the histogram of the image (or of the area of a
	* tiled image) it will run on. Every image run through the result gets the
	* same range. With `null`, `autoStretch` steps are removed.
	*/
	resolve(stats) {
		return needsStats(this.ops) ? new Pipeline(resolveOps(this.ops, stats)) : this;
	}
	/** Serializable form of the steps, for saving presets. Restore with {@link Pipeline.fromJSON}. */
	toJSON() {
		return {
			version: 1,
			ops: this.ops.map((op) => ({ ...op }))
		};
	}
	/** Runs synchronously on the calling thread. */
	runSync(image, options = {}) {
		return applySync(image, this.ops, options);
	}
	/** Runs on any supported input and returns the requested output type. */
	async run(input, options) {
		const opts = options ?? {};
		const source = await toImageData(input);
		assertImageData(source);
		if (opts.signal?.aborted) throw abortError(opts.signal);
		const result = await execute(source, this.ops, {
			colorMode: opts.colorMode,
			worker: opts.worker,
			signal: opts.signal
		});
		if (result.mode === "gray") warnColorOnly(this.ops);
		switch (opts.output ?? "imageData") {
			case "gray": return {
				data: extractGray(result.data),
				width: result.width,
				height: result.height
			};
			case "canvas": return toCanvas(result);
			case "blob": return await toBlob(result, opts.type, opts.quality);
			case "imageData": return createImageData(result.data, result.width, result.height);
			default: throw new TypeError(`Unknown output: ${String(opts.output)}`);
		}
	}
};
/** Starts an empty pipeline. */
function pipeline() {
	return new Pipeline();
}
/** Same as {@link Pipeline.fromJSON}. */
pipeline.fromJSON = Pipeline.fromJSON;
/**
* For slider previews: each call supersedes the previous one. The last decoded
* (and, with `maxSize`, shrunk) input is reused while the same input object is
* passed again.
*
* @example
* ```ts
* const preview = createPreviewRunner({ maxSize: 1280 });
* slider.oninput = async () => show(await preview.run(current(), img));
* slider.onchange = async () => show(await current().run(img)); // full size on release
* ```
*/
function createPreviewRunner(options) {
	let generation = 0;
	let controller = null;
	let lastInput = null;
	let lastDecoded = null;
	const { maxSize, ...runOptions } = options ?? {};
	return {
		async run(p, input) {
			const mine = ++generation;
			controller?.abort();
			const current = new AbortController();
			controller = current;
			if (input !== lastInput || !lastDecoded) {
				lastInput = input;
				lastDecoded = toImageData(input).then((image) => maxSize !== void 0 && maxSize > 0 ? downscale(image, maxSize) : {
					image,
					scale: 1
				});
				lastDecoded.catch(() => {
					if (lastInput === input) lastDecoded = null;
				});
			}
			try {
				const decoded = await lastDecoded;
				if (mine !== generation) return null;
				const result = await p.scaled(decoded.scale).run(decoded.image, {
					...runOptions,
					signal: current.signal
				});
				return mine === generation ? result : null;
			} catch (e) {
				if (mine !== generation) return null;
				throw e;
			} finally {
				if (controller === current) controller = null;
			}
		},
		cancel() {
			generation++;
			controller?.abort();
			controller = null;
		}
	};
}
//#endregion
export { Pipeline, createPreviewRunner, pipeline };

//# sourceMappingURL=pipeline.js.map