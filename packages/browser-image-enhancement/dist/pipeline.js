import { abortError } from "./workers/src/abort.js";
import { assertImageData, createImageData } from "./workers/src/image.js";
import { toBlob, toCanvas, toImageData } from "./workers/src/io.js";
import { normalizeOp } from "./ops/index.js";
import { extractGray } from "./core/process.js";
import { needsStats, resolveOps } from "./core/histogram.js";
import { applySync, warnColorOnly } from "./functional.js";
import { execute } from "./worker/executor.js";
//#region src/pipeline.ts
/**
* Pipeline API: declare a chain of corrections, then run it in one pass
* (no 8-bit rounding between steps), in Web Workers by default.
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
pipeline.fromJSON = Pipeline.fromJSON;
/**
* For slider previews: each call supersedes the previous one. The last decoded
* input is reused while the same input object is passed again.
*/
function createPreviewRunner(options) {
	let generation = 0;
	let controller = null;
	let lastInput = null;
	let lastDecoded = null;
	return {
		async run(p, input) {
			const mine = ++generation;
			controller?.abort();
			const current = new AbortController();
			controller = current;
			if (input !== lastInput || !lastDecoded) {
				lastInput = input;
				lastDecoded = toImageData(input);
				lastDecoded.catch(() => {
					if (lastInput === input) lastDecoded = null;
				});
			}
			try {
				const decoded = await lastDecoded;
				if (mine !== generation) return null;
				const result = await p.run(decoded, {
					...options ?? {},
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