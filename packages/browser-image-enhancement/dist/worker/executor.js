import { abortError, race, throwIfAborted } from "../workers/src/abort.js";
import { WorkerUnavailableError } from "../workers/src/pool.js";
import { splitRows, stripCount, yieldToEventLoop } from "../workers/src/strips.js";
import { marginOf } from "../ops/index.js";
import { compile, processPixels, resolveMode } from "../core/process.js";
import { grayFromRgb, mergeHistograms, needsStats, resolveForPixels, resolveOps } from "../core/histogram.js";
import { getPool } from "./pool.js";
//#region src/worker/executor.ts
/**
* Runs a chain of normalized ops on an image, in workers when possible.
*
* The image is cut into horizontal strips, one per worker. Each strip's pixels
* are copied once into their own buffer and transferred to the worker and back.
* In `auto` color mode with several strips, workers first report whether their
* strip is monochrome so the whole image is computed in one mode. With
* `autoStretch` they also report their strip's histogram, and the main thread
* resolves one stretch for the whole image from the sum.
*
* With `sharpen`, which reads neighbouring pixels, each strip is sent with
* `marginOf(ops)` extra rows above and below; the strip's own rows then come
* out exactly as they would from the whole image.
*/
let nextId = 1;
/** Processes on the calling thread. */
function executeOnMainThread(image, ops, colorMode = "auto") {
	const mode = resolveMode(image.data, colorMode);
	const data = new Uint8ClampedArray(image.data.length);
	processPixels(image.data, data, compile(resolveForPixels(ops, image.data, mode), mode), image.width);
	return {
		data,
		width: image.width,
		height: image.height,
		mode,
		usedWorker: false
	};
}
async function execute(image, ops, options = {}) {
	const { colorMode = "auto", signal } = options;
	throwIfAborted(signal);
	if (options.worker === false) return executeOnMainThread(image, ops, colorMode);
	const pool = options.pool ?? getPool();
	if (!pool.available) return executeOnMainThread(image, ops, colorMode);
	const pixels = image.width * image.height;
	const wanted = stripCount(pixels, image.height, pool.maxWorkers, pool.minStripPixels);
	let slots;
	try {
		slots = await race(pool.acquire(wanted), signal);
	} catch (e) {
		if (e instanceof WorkerUnavailableError) return executeOnMainThread(image, ops, colorMode);
		throw e;
	}
	try {
		return await race(runInWorkers(pool, slots, image, [...ops], colorMode, signal), signal);
	} catch (e) {
		if (e instanceof WorkerUnavailableError) {
			throwIfAborted(signal);
			return executeOnMainThread(image, ops, colorMode);
		}
		throw e;
	}
}
async function runInWorkers(pool, slots, image, ops, colorMode, signal) {
	const { width, height } = image;
	const rowBytes = width * 4;
	const ranges = splitRows(height, slots.length);
	const margin = marginOf(ops);
	const sentRows = ranges.map(([start, end]) => [Math.max(0, start - margin), Math.min(height, end + margin)]);
	const ids = ranges.map(() => nextId++);
	const stats = needsStats(ops);
	const twoPhase = ranges.length > 1 && (colorMode === "auto" || stats);
	const statsMode = stats ? colorMode === "gray" ? "gray" : "rgb" : null;
	const release = () => ids.forEach((id, i) => pool.notify(slots[i], {
		type: "release",
		id
	}));
	const sent = [];
	for (let i = 0; i < ranges.length; i++) {
		if (i > 0) {
			await yieldToEventLoop();
			if (signal?.aborted) {
				if (twoPhase) release();
				throw abortError(signal);
			}
		}
		const [from, to] = sentRows[i];
		const core = [ranges[i][0] - from, ranges[i][1] - from];
		const buffer = image.data.slice(from * rowBytes, to * rowBytes).buffer;
		const reply = twoPhase ? pool.request(slots[i], {
			type: "detect",
			id: ids[i],
			buffer,
			width,
			core,
			stats: statsMode
		}, [buffer]) : pool.request(slots[i], {
			type: "run",
			id: ids[i],
			buffer,
			width,
			ops,
			colorMode
		}, [buffer]);
		reply.catch(() => {});
		sent.push(reply);
	}
	let pending = sent;
	if (twoPhase) {
		let detected;
		try {
			detected = await Promise.all(sent);
		} catch (e) {
			release();
			throw e;
		}
		if (signal?.aborted) {
			release();
			throw abortError(signal);
		}
		const reports = detected;
		const mode = colorMode === "auto" ? reports.every((r) => r.mono) ? "gray" : "rgb" : colorMode;
		let resolved = ops;
		if (stats) {
			const merged = mergeHistograms(reports.map((r) => r.stats));
			resolved = resolveOps(ops, mode === "gray" ? grayFromRgb(merged) : merged);
		}
		pending = ids.map((id, i) => pool.request(slots[i], {
			type: "process",
			id,
			ops: resolved,
			mode
		}));
	}
	if (pending.length === 1) {
		const done = await pending[0];
		return {
			data: new Uint8ClampedArray(done.buffer),
			width,
			height,
			mode: done.mode,
			usedWorker: true
		};
	}
	const data = new Uint8ClampedArray(image.data.length);
	return {
		data,
		width,
		height,
		mode: (await Promise.all(pending.map(async (reply, i) => {
			const done = await reply;
			const [start, end] = ranges[i];
			const offset = (start - sentRows[i][0]) * rowBytes;
			data.set(new Uint8ClampedArray(done.buffer, offset, (end - start) * rowBytes), start * rowBytes);
			return done.mode;
		})))[0],
		usedWorker: true
	};
}
//#endregion
export { abortError, execute, executeOnMainThread, splitRows };

//# sourceMappingURL=executor.js.map