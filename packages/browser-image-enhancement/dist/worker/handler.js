import { compile, isMonochrome, processPixels, resolveMode } from "../core/process.js";
import { countPixels, resolveForPixels } from "../core/histogram.js";
//#region src/worker/handler.ts
/**
* Worker-side message handling, kept free of worker globals so it can be tested directly.
*/
function createWorkerHandler(post) {
	const held = /* @__PURE__ */ new Map();
	let cacheKey = "";
	let cached = null;
	function program(ops, mode) {
		const key = mode + JSON.stringify(ops);
		if (key !== cacheKey || !cached) {
			cached = compile(ops, mode);
			cacheKey = key;
		}
		return cached;
	}
	function finish(id, buffer, ops, mode) {
		const pixels = new Uint8ClampedArray(buffer);
		processPixels(pixels, pixels, program(ops, mode));
		post({
			type: "done",
			id,
			buffer,
			mode
		}, [buffer]);
	}
	return (request) => {
		const id = request.id;
		try {
			switch (request.type) {
				case "run": {
					const pixels = new Uint8ClampedArray(request.buffer);
					const mode = resolveMode(pixels, request.colorMode);
					finish(id, request.buffer, resolveForPixels(request.ops, pixels, mode), mode);
					break;
				}
				case "detect": {
					held.set(id, request.buffer);
					const pixels = new Uint8ClampedArray(request.buffer);
					const stats = request.stats ? countPixels(pixels, Math.max(1, pixels.length >> 2), request.stats) : null;
					post({
						type: "detected",
						id,
						mono: isMonochrome(pixels),
						stats
					});
					break;
				}
				case "process": {
					const buffer = held.get(id);
					if (!buffer) throw new Error(`No strip held for job ${id}.`);
					held.delete(id);
					finish(id, buffer, request.ops, request.mode);
					break;
				}
				case "release": held.delete(id);
			}
		} catch (e) {
			post({
				type: "error",
				id,
				message: e instanceof Error ? e.message : String(e)
			});
		}
	};
}
//#endregion
export { createWorkerHandler };

//# sourceMappingURL=handler.js.map