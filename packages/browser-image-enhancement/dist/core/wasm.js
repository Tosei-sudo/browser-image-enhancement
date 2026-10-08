import { gaussian } from "./filter.js";
import { WASM_BASE64 } from "./wasm-bytes.js";
//#region src/core/wasm.ts
/**
* The WebAssembly engine: the hot loops of core/process.ts and core/filter.ts
* compiled from C (wasm/kernel.c) with SIMD. It does the same float64
* arithmetic in the same order, so it gives the same pixels as the JS loops,
* 2.5 to 4 times faster.
*
* It covers the programs that cost the most in JS: tables with saturation
* between them, and one sharpen with tables or saturation around it. Plain
* 8-bit tables are as fast in JS. Anything else (a step that can fall,
* several sharpens, a colored pixel in forced gray mode around a sharpen)
* runs in JS, as it does wherever WebAssembly is missing or blocked (a CSP
* without 'wasm-unsafe-eval').
*
* The module compiles synchronously where the browser allows it (workers,
* Node), else in the background; until then pixels go through JS.
*/
/** Bytes of a Quant in kernel.c. */
const QUANT_BYTES = 6216;
/** Per-pixel programs run on this many bytes at a time, so memory stays small. */
const CHUNK = 1 << 20;
/** Sharpen runs this many pixels' rows per call. */
const BAND_PIXELS = 1 << 18;
/** Above this much memory for one sharpen, JS runs it instead (wasm32 addresses 4 GB). */
const MAX_BYTES = 1.5 * 2 ** 30;
let enabled = true;
let state = "idle";
let kernel = null;
/**
* Turns the WebAssembly engine on (the default) or off. Off, every pixel goes
* through the JS engine; the results are the same either way. Applies to
* this thread and to the workers `run` uses.
*/
function configureWasm(options) {
	if (options.enabled !== void 0) enabled = options.enabled;
	if (enabled) load();
}
/**
* `ready` when pixels go through WebAssembly, `loading` while it compiles,
* `unavailable` when the browser cannot run it (or a CSP forbids it), `off`
* after `configureWasm({ enabled: false })`.
*/
function wasmStatus() {
	if (!enabled) return "off";
	load();
	return state === "ready" ? "ready" : state === "failed" ? "unavailable" : "loading";
}
/** True when `configureWasm` has not turned the engine off. */
function wasmEnabled() {
	return enabled;
}
function load() {
	if (state !== "idle") return;
	state = "loading";
	let bytes;
	try {
		if (typeof WebAssembly !== "object" || typeof atob !== "function") throw new Error("no WebAssembly");
		const text = atob(WASM_BASE64);
		bytes = new Uint8Array(text.length);
		for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
	} catch {
		state = "failed";
		return;
	}
	try {
		kernel = new Kernel(new WebAssembly.Module(bytes));
		state = "ready";
		return;
	} catch (e) {
		if (!(e instanceof RangeError)) {
			state = "failed";
			return;
		}
	}
	WebAssembly.compile(bytes).then((module) => {
		try {
			kernel = new Kernel(module);
			state = "ready";
		} catch {
			state = "failed";
		}
	}, () => {
		state = "failed";
	});
}
/**
* Runs `program` in WebAssembly when it can (see the module comment): writes
* `dst` and returns true, or returns false and leaves both arrays alone.
* `src` and `dst` may be the same array; `width` is checked by the caller.
*/
function runWasm(src, dst, program, width) {
	if (!enabled) return false;
	if (state === "idle") load();
	if (!kernel) return false;
	try {
		return program.spatial ? kernel.spatial(src, dst, program, width) : kernel.pixels(src, dst, program);
	} catch {
		return false;
	}
}
/** Saturation factors when every step is a saturation, else null. */
function saturations(stages) {
	const out = [];
	for (const s of stages) {
		if (s.kind !== "saturation") return null;
		out.push(s.factor);
	}
	return out;
}
function isGray(data) {
	for (let i = 0; i < data.length; i += 4) if (data[i] !== data[i + 1] || data[i] !== data[i + 2]) return false;
	return true;
}
var Kernel = class {
	memory = new WebAssembly.Memory({ initial: 16 });
	x;
	heap;
	top = 0;
	constructor(module) {
		this.x = new WebAssembly.Instance(module, { env: { memory: this.memory } }).exports;
		this.heap = this.x.__heap_base.value + 15 & -16;
	}
	pixels(src, dst, p) {
		const x = this.x;
		this.top = this.heap;
		if (p.lut8) return false;
		const sat = p.mode === "rgb" ? saturations(p.middle) : null;
		if (!sat) return false;
		const lin = this.alloc(6144);
		const sats = this.alloc(sat.length * 8);
		const q = this.alloc(3 * QUANT_BYTES);
		return this.chunks(src, dst, () => {
			p.lutLinear.forEach((t, c) => this.doubles(lin + c * 2048, 256).set(t));
			this.doubles(sats, sat.length).set(sat);
			p.tail.forEach((t, c) => this.quant(q + c * QUANT_BYTES, t));
		}, (s, n) => x.pixel_rgb(s, s, n, lin, sats, sat.length, q));
	}
	spatial(src, dst, p, width) {
		const sp = p.spatial;
		if (!sp.stream) return false;
		const rgb = p.mode === "rgb";
		const channels = rgb ? 3 : 1;
		const satHead = sp.lutEncoded ? [] : rgb ? saturations(p.middle) : null;
		const satTail = sp.tailTakesEncoded ? [] : rgb ? saturations(sp.middle) : null;
		if (!satHead || !satTail) return false;
		if (!rgb && !isGray(src)) return false;
		const tab = sp.lutEncoded ?? p.lutLinear;
		const stage = sp.filters[0].stage;
		const k = gaussian(stage.radius);
		const r = k.length - 1 >> 1;
		if (2 * r + 1 > 301) return false;
		const n = src.length;
		const scratchBytes = this.x.sharpen_scratch(width, r, channels);
		if (n + scratchBytes + 65536 > MAX_BYTES) return false;
		this.top = this.heap;
		const pixels = this.alloc(n);
		const tables = this.alloc(channels * 256 * 8);
		const heads = this.alloc(satHead.length * 8);
		const tails = this.alloc(satTail.length * 8);
		const kernel = this.alloc(k.length * 8);
		const q = this.alloc(channels * QUANT_BYTES);
		const scratch = this.alloc(scratchBytes);
		this.reserve();
		this.bytes(pixels, n).set(src);
		for (let c = 0; c < channels; c++) this.doubles(tables + c * 2048, 256).set(tab[c]);
		this.doubles(heads, satHead.length).set(satHead);
		this.doubles(tails, satTail.length).set(satTail);
		this.doubles(kernel, k.length).set(k);
		for (let c = 0; c < channels; c++) this.quant(q + c * QUANT_BYTES, sp.tail[c]);
		const height = n / 4 / width;
		const band = Math.max(1, Math.floor(BAND_PIXELS / width));
		for (let y = 0; y < height; y += band) this.x.sharpen_stream(pixels, pixels, width, height, channels, kernel, r, stage.amount, stage.threshold, sp.lutEncoded ? 0 : 1, tables, heads, satHead.length, sp.tailTakesEncoded ? 0 : 1, tails, satTail.length, q, scratch, y, Math.min(height, y + band));
		dst.set(this.bytes(pixels, n));
		return true;
	}
	/** Runs `kernel` on `src` a chunk at a time, in place in wasm memory, into `dst`. `setup` writes the tables. */
	chunks(src, dst, setup, kernel) {
		const size = Math.min(CHUNK, src.length);
		const at = this.alloc(size);
		this.reserve();
		setup();
		for (let i = 0; i < src.length; i += CHUNK) {
			const n = Math.min(CHUNK, src.length - i);
			this.bytes(at, n).set(src.subarray(i, i + n));
			kernel(at, n);
			dst.set(this.bytes(at, n), i);
		}
		return true;
	}
	alloc(bytes) {
		const at = this.top;
		this.top = at + bytes + 15 & -16;
		return at;
	}
	/** Grows memory to hold everything allocated so far. */
	reserve() {
		const short = this.top - this.memory.buffer.byteLength;
		if (short > 0) this.memory.grow(Math.ceil(short / 65536));
	}
	bytes(at, n) {
		return new Uint8Array(this.memory.buffer, at, n);
	}
	doubles(at, n) {
		return new Float64Array(this.memory.buffer, at, n);
	}
	/** Writes a Quantizer in kernel.c's layout and lets the kernel finish it. */
	quant(at, q) {
		const view = new DataView(this.memory.buffer, at, QUANT_BYTES);
		view.setFloat64(0, q.lo, true);
		view.setFloat64(8, q.hi, true);
		view.setFloat64(16, q.scale, true);
		view.setInt32(24, q.floor, true);
		view.setInt32(28, q.ceil, true);
		this.doubles(at + 40, 256).set(q.thresholds);
		new Uint8Array(this.memory.buffer, at + 40 + 2080, q.base.length).set(q.base);
		this.x.quant_prepare(at);
	}
};
//#endregion
export { configureWasm, runWasm, wasmEnabled, wasmStatus };

//# sourceMappingURL=wasm.js.map