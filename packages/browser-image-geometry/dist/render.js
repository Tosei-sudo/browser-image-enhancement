import { createImageData } from "./workers/src/image.js";
import { renderRows } from "./resample.js";
import { shrink } from "./plan.js";
//#region src/render.ts
/** Running a plan on the calling thread. */
/** Renders the whole output of `plan` from `image` (the full-size source). */
function renderPlan(image, plan) {
	const src = shrink(image, plan.levels);
	const out = new Uint8ClampedArray(plan.width * plan.height * 4);
	renderRows({
		data: src.data,
		width: src.width,
		height: src.height,
		x0: 0,
		y0: 0
	}, plan.mapping, plan.width, 0, plan.height, plan.resample, plan.background, out, plan.clampEdges);
	return createImageData(out, plan.width, plan.height);
}
//#endregion
export { renderPlan };

//# sourceMappingURL=render.js.map