//#region ../workers/src/pool.ts
/** Thrown when no worker could be started; callers fall back to the main thread. */
var WorkerUnavailableError = class extends Error {
	name = "WorkerUnavailableError";
};
function defaultMaxWorkers() {
	const n = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : void 0;
	return n && n > 0 ? n : 4;
}
function noWorkers() {
	throw new WorkerUnavailableError("Web Workers are not supported in this environment.");
}
var WorkerPool = class {
	maxWorkers;
	minStripPixels;
	startupTimeout;
	create;
	slots = [];
	starting = null;
	failed = false;
	/** Set by {@link terminate}: workers still starting are stopped as soon as they are up. */
	terminated = false;
	capacity;
	/**
	* @param defaultCreate Used when `config.createWorker` is not set and `Worker` exists.
	*/
	constructor(config = {}, defaultCreate) {
		const valid = (v) => v !== void 0 && Number.isFinite(v) && v > 0 ? v : void 0;
		this.maxWorkers = Math.max(1, Math.floor(valid(config.maxWorkers) ?? defaultMaxWorkers()));
		this.capacity = this.maxWorkers;
		this.minStripPixels = Math.max(1, valid(config.minStripPixels) ?? 1 << 18);
		this.startupTimeout = valid(config.startupTimeout) ?? 1e4;
		this.create = config.createWorker ?? (typeof Worker !== "undefined" && defaultCreate ? defaultCreate : noWorkers);
	}
	/** False once workers have failed to start; the pool then stays on the main thread. */
	get available() {
		return !this.failed;
	}
	/** Number of live workers. */
	get size() {
		return this.slots.length;
	}
	/**
	* Returns up to `count` started workers, least busy first, starting new ones as needed.
	* Rejects with WorkerUnavailableError if none can run.
	*/
	async acquire(count) {
		const want = Math.min(Math.max(1, Math.floor(count) || 1), this.capacity);
		while (this.starting) await this.starting;
		if (this.terminated) throw new WorkerUnavailableError("Worker pool was terminated.");
		if (this.failed) throw new WorkerUnavailableError("Web Workers could not be started.");
		if (this.slots.length < want) {
			this.starting = this.startWorkers(want - this.slots.length).finally(() => {
				this.starting = null;
			});
			await this.starting;
			if (this.terminated) throw new WorkerUnavailableError("Worker pool was terminated.");
			if (this.failed) throw new WorkerUnavailableError("Web Workers could not be started.");
		}
		return [...this.slots].sort((a, b) => a.load - b.load).slice(0, want);
	}
	async startWorkers(n) {
		const ok = (await Promise.all(Array.from({ length: n }, () => this.startOne()))).filter((s) => s !== null && !s.dead);
		if (this.terminated) {
			for (const slot of ok) this.kill(slot, new WorkerUnavailableError("Worker pool was terminated."));
			return;
		}
		this.slots.push(...ok);
		if (this.slots.length === 0) this.failed = true;
		else if (ok.length < n) this.capacity = this.slots.length;
	}
	startOne() {
		let worker;
		try {
			worker = this.create();
		} catch {
			return Promise.resolve(null);
		}
		return new Promise((resolve) => {
			const slot = {
				worker,
				load: 0,
				dead: false,
				pending: /* @__PURE__ */ new Map()
			};
			let ready = false;
			const timer = setTimeout(() => fail(), this.startupTimeout);
			const fail = () => {
				clearTimeout(timer);
				this.kill(slot, new WorkerUnavailableError("Web Worker stopped unexpectedly."));
				if (!ready) resolve(null);
			};
			worker.addEventListener("message", (event) => {
				const msg = event.data;
				if ("type" in msg && msg.type === "ready") {
					ready = true;
					clearTimeout(timer);
					resolve(slot);
					return;
				}
				const id = msg.id;
				const pending = slot.pending.get(id);
				if (!pending) return;
				slot.pending.delete(id);
				slot.load--;
				if ("type" in msg && msg.type === "error") pending.reject(new Error(msg.message));
				else pending.resolve(msg);
			});
			worker.addEventListener("error", (event) => {
				event.preventDefault?.();
				fail();
			});
			worker.addEventListener("messageerror", () => fail());
		});
	}
	/** Sends a request and resolves with the worker's answer for the same id. */
	request(slot, message, transfer = []) {
		if (slot.dead) return Promise.reject(new WorkerUnavailableError("Web Worker is no longer running."));
		return new Promise((resolve, reject) => {
			slot.pending.set(message.id, {
				resolve,
				reject
			});
			slot.load++;
			try {
				slot.worker.postMessage(message, transfer);
			} catch (e) {
				slot.pending.delete(message.id);
				slot.load--;
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	}
	/** Fire-and-forget message that gets no answer. */
	notify(slot, message) {
		if (!slot.dead) slot.worker.postMessage(message, []);
	}
	/**
	* Gives up on requests already sent: each rejects with `error`. A worker
	* busy only with them is stopped, so an aborted job stops using the CPU (a
	* new worker starts on the next {@link acquire}); on a worker that also has
	* other jobs' requests, the answers to these are ignored when they come.
	*/
	cancel(slot, ids, error) {
		const mine = [...ids].filter((id) => slot.pending.has(id));
		if (mine.length === 0) return;
		if (mine.length === slot.pending.size) {
			this.kill(slot, error);
			return;
		}
		for (const id of mine) {
			const pending = slot.pending.get(id);
			slot.pending.delete(id);
			slot.load--;
			pending.reject(error);
		}
	}
	kill(slot, error) {
		if (slot.dead) return;
		slot.dead = true;
		try {
			slot.worker.terminate();
		} catch {}
		const i = this.slots.indexOf(slot);
		if (i >= 0) this.slots.splice(i, 1);
		for (const p of slot.pending.values()) p.reject(error);
		slot.pending.clear();
	}
	/** Stops every worker. Pending requests reject. */
	terminate() {
		this.terminated = true;
		for (const slot of [...this.slots]) this.kill(slot, new WorkerUnavailableError("Worker pool was terminated."));
	}
};
/** One lazily created pool per package, with the package's default way to start its worker. */
function createSharedPool(defaultCreate) {
	let config = {};
	let shared = null;
	const terminateWorkers = () => {
		shared?.terminate();
		shared = null;
	};
	return {
		getPool: () => shared ??= new WorkerPool(config, defaultCreate),
		configureWorkers(next) {
			terminateWorkers();
			config = {
				...config,
				...next
			};
		},
		terminateWorkers
	};
}
//#endregion
export { WorkerPool, WorkerUnavailableError, createSharedPool };

//# sourceMappingURL=pool.js.map