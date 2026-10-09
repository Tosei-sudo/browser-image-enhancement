import { configureWasm } from "../core/wasm.js";
import { compile, isMonochrome, processPixels, resolveMode } from "../core/process.js";
import { countPixels, resolveForPixels } from "../core/histogram.js";
import { drawTriangles } from "../openlayers/reproject-kernel.js";
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
	function finish(id, buffer, width, ops, mode, wasm) {
		configureWasm({ enabled: wasm });
		const pixels = new Uint8ClampedArray(buffer);
		processPixels(pixels, pixels, program(ops, mode), width);
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
					finish(id, request.buffer, request.width, resolveForPixels(request.ops, pixels, mode), mode, request.wasm);
					break;
				}
				case "detect": {
					const { buffer, width, core } = request;
					held.set(id, {
						buffer,
						width
					});
					const pixels = new Uint8ClampedArray(buffer);
					const rect = {
						x: 0,
						y: core[0],
						width,
						height: core[1] - core[0]
					};
					const stats = request.stats ? countPixels(pixels, width, request.stats, rect) : null;
					post({
						type: "detected",
						id,
						mono: isMonochrome(pixels),
						stats
					});
					break;
				}
				case "process": {
					const strip = held.get(id);
					if (!strip) throw new Error(`No strip held for job ${id}.`);
					held.delete(id);
					finish(id, strip.buffer, strip.width, request.ops, request.mode, request.wasm);
					break;
				}
				case "release":
					held.delete(id);
					break;
				case "reproject": {
					const { stitch, corners, float, ...rest } = request.job;
					const out = drawTriangles({
						...rest,
						stitch: float ? new Float32Array(stitch) : new Uint8ClampedArray(stitch),
						corners: new Float64Array(corners)
					});
					post({
						type: "reprojected",
						id,
						buffer: out.buffer
					}, [out.buffer]);
					break;
				}
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