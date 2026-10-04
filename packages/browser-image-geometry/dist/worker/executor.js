import { race, throwIfAborted } from "../workers/src/abort.js";
import { WorkerUnavailableError } from "../workers/src/pool.js";
import { splitRows, stripCount, yieldToEventLoop } from "../workers/src/strips.js";
import { createImageData } from "../workers/src/image.js";
import { shrink, sourceBounds } from "../plan.js";
import { renderPlan } from "../render.js";
import { getPool } from "./pool.js";
//#region src/worker/executor.ts
/**
* Renders a plan in workers when possible: the output is cut into horizontal
* strips, and each worker receives only the source rectangle its strip reads.
*/
let nextId = 1;
async function execute(image, plan, options = {}) {
	const { signal } = options;
	throwIfAborted(signal);
	const onMain = () => ({
		image: renderPlan(image, plan),
		usedWorker: false
	});
	if (options.worker === false) return onMain();
	const pool = options.pool ?? getPool();
	if (!pool.available) return onMain();
	let slots;
	try {
		slots = await race(pool.acquire(stripCount(plan.width * plan.height, plan.height, pool.maxWorkers, pool.minStripPixels)), signal);
	} catch (e) {
		if (e instanceof WorkerUnavailableError) return onMain();
		throw e;
	}
	try {
		return {
			image: await race(runInWorkers(pool, slots, image, plan, signal), signal),
			usedWorker: true
		};
	} catch (e) {
		if (e instanceof WorkerUnavailableError) {
			throwIfAborted(signal);
			return onMain();
		}
		throw e;
	}
}
/** Copies the source rectangle `[left, top, right, bottom)` into its own buffer. */
function copyWindow(src, [left, top, right, bottom]) {
	const w = right - left;
	const h = bottom - top;
	if (left === 0 && w === src.width) return {
		buffer: src.data.slice(top * w * 4, bottom * w * 4).buffer,
		width: w,
		height: h,
		x0: left,
		y0: top
	};
	const data = new Uint8ClampedArray(w * h * 4);
	for (let j = 0; j < h; j++) {
		const s = ((top + j) * src.width + left) * 4;
		data.set(src.data.subarray(s, s + w * 4), j * w * 4);
	}
	return {
		buffer: data.buffer,
		width: w,
		height: h,
		x0: left,
		y0: top
	};
}
async function runInWorkers(pool, slots, image, plan, signal) {
	const src = shrink(image, plan.levels);
	const { width, height } = plan;
	const ranges = splitRows(height, slots.length);
	const replies = [];
	for (let i = 0; i < ranges.length; i++) {
		if (i > 0) {
			await yieldToEventLoop();
			throwIfAborted(signal);
		}
		const [y0, y1] = ranges[i];
		const bounds = sourceBounds(plan.mapping, width, y0, y1, src.width, src.height, plan.resample);
		const window = bounds ? copyWindow(src, bounds) : null;
		const message = {
			type: "warp",
			id: nextId++,
			window,
			width,
			y0,
			y1,
			mapping: plan.mapping,
			resample: plan.resample,
			background: plan.background,
			clampEdges: plan.clampEdges
		};
		const reply = pool.request(slots[i], message, window ? [window.buffer] : []);
		reply.catch(() => {});
		replies.push(reply);
	}
	if (replies.length === 1) return createImageData(new Uint8ClampedArray((await replies[0]).buffer), width, height);
	const out = new Uint8ClampedArray(width * height * 4);
	await Promise.all(replies.map(async (reply, i) => {
		out.set(new Uint8ClampedArray((await reply).buffer), ranges[i][0] * width * 4);
	}));
	return createImageData(out, width, height);
}
//#endregion
export { execute };

//# sourceMappingURL=executor.js.map