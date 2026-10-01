import { compile, processPixels, resolveMode } from "../core/process.js";
import { abortError, race, throwIfAborted } from "../workers/src/abort.js";
import { WorkerUnavailableError } from "../workers/src/pool.js";
import { splitRows, stripCount, yieldToEventLoop } from "../workers/src/strips.js";
import { getPool } from "./pool.js";
//#region src/worker/executor.ts
/**
* Runs a chain of normalized ops on an image, in workers when possible.
*
* The image is cut into horizontal strips, one per worker. Each strip's pixels
* are copied once into their own buffer and transferred to the worker and back.
* In `auto` color mode with several strips, workers first report whether their
* strip is monochrome so the whole image is computed in one mode.
*/
let nextId = 1;
/** Processes on the calling thread. */
function executeOnMainThread(image, ops, colorMode = "auto") {
	const mode = resolveMode(image.data, colorMode);
	const data = new Uint8ClampedArray(image.data.length);
	processPixels(image.data, data, compile(ops, mode));
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
	const rowBytes = image.width * 4;
	const ranges = splitRows(image.height, slots.length);
	const ids = ranges.map(() => nextId++);
	const twoPhase = ranges.length > 1 && colorMode === "auto";
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
		const [start, end] = ranges[i];
		const buffer = image.data.slice(start * rowBytes, end * rowBytes).buffer;
		const reply = twoPhase ? pool.request(slots[i], {
			type: "detect",
			id: ids[i],
			buffer
		}, [buffer]) : pool.request(slots[i], {
			type: "run",
			id: ids[i],
			buffer,
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
		const mode = detected.every((r) => r.type === "detected" && r.mono) ? "gray" : "rgb";
		pending = ids.map((id, i) => pool.request(slots[i], {
			type: "process",
			id,
			ops,
			mode
		}));
	}
	if (pending.length === 1) {
		const done = await pending[0];
		return {
			data: new Uint8ClampedArray(done.buffer),
			width: image.width,
			height: image.height,
			mode: done.mode,
			usedWorker: true
		};
	}
	const data = new Uint8ClampedArray(image.data.length);
	const modes = await Promise.all(pending.map(async (reply, i) => {
		const done = await reply;
		data.set(new Uint8ClampedArray(done.buffer), ranges[i][0] * rowBytes);
		return done.mode;
	}));
	return {
		data,
		width: image.width,
		height: image.height,
		mode: modes[0],
		usedWorker: true
	};
}
//#endregion
export { abortError, execute, executeOnMainThread, splitRows };

//# sourceMappingURL=executor.js.map