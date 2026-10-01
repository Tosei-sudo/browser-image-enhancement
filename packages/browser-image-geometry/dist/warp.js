import { assertImageData } from "./workers/src/image.js";
import { toBlob, toCanvas, toImageData } from "./workers/src/io.js";
import { planWarp } from "./plan.js";
import { execute } from "./worker/executor.js";
//#region src/warp.ts
/** Asynchronous API: any image source in, the requested output type back, in workers by default. */
/**
* Applies `transform` to any supported image source. The coordinate transform
* (if any) runs here on the main thread on a coarse grid; resampling runs in workers.
*/
async function warp(input, transform, options) {
	const opts = options ?? {};
	const source = await toImageData(input);
	assertImageData(source);
	const plan = planWarp(source.width, source.height, transform, opts);
	const { image, usedWorker } = await execute(source, plan, {
		worker: opts.worker,
		signal: opts.signal
	});
	let out;
	switch (opts.output ?? "imageData") {
		case "imageData":
			out = image;
			break;
		case "canvas":
			out = toCanvas(image);
			break;
		case "blob":
			out = await toBlob(image, opts.type, opts.quality);
			break;
		default: throw new TypeError(`Unknown output: ${String(opts.output)}`);
	}
	return {
		image: out,
		width: plan.width,
		height: plan.height,
		geoTransform: plan.geoTransform,
		extent: plan.extent,
		usedWorker
	};
}
//#endregion
export { warp };

//# sourceMappingURL=warp.js.map