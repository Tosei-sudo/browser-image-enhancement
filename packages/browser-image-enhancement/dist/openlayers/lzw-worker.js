import { getPool } from "../worker/pool.js";
import { nextWorkerId } from "./worker-ids.js";
import { decodeLzwBlock } from "./lzw.js";
// src/openlayers/lzw-worker.ts
/**
* Decodes the LZW tiles geotiff.js reads for the map in the library's
* worker pool with the fast decoder (lzw.ts), instead of geotiff.js's own.
*/
/** The block decoded in a worker, or null when no worker can run (`buffer` is then untouched). */
async function decodeLzwInWorker(buffer, parameters) {
	if (typeof Worker === "undefined") return null;
	const pool = getPool();
	if (!pool.available) return null;
	let slot;
	try {
		[slot] = await pool.acquire(1);
	} catch {
		return null;
	}
	const response = await pool.request(slot, {
		type: "lzw",
		id: nextWorkerId(),
		buffer,
		parameters
	}, [buffer]);
	if (response.type !== "lzwDecoded") throw new Error("The worker did not decode the tile.");
	return response.buffer;
}
/**
* For an LZW image, a decoder that runs the fast decoder in the worker pool
* (on this thread where there is none); `fallback`, what geotiff.js would
* have used, for any other image. Where the pool cannot run, `fallback`
* decodes too.
*/
function lzwDecoderFor(img, fallback) {
	let parameters;
	try {
		if (Number(img.fileDirectory.getValue("Compression")) !== 5) return fallback;
		const bits = img.fileDirectory.getValue("BitsPerSample");
		if (bits === void 0) return fallback;
		parameters = {
			tileWidth: img.getTileWidth(),
			tileHeight: img.getTileHeight(),
			planarConfiguration: img.planarConfiguration,
			bitsPerSample: typeof bits === "number" ? bits : Array.from(bits, Number),
			predictor: Number(img.fileDirectory.getValue("Predictor") ?? 1) || 1
		};
	} catch {
		return fallback;
	}
	const original = fallback;
	return { decode: async (buffer) => {
		const decoded = await decodeLzwInWorker(buffer, parameters);
		if (decoded) return decoded;
		return original && typeof original.decode === "function" ? original.decode(buffer) : decodeLzwBlock(buffer, parameters);
	} };
}
export { decodeLzwInWorker, lzwDecoderFor };

//# sourceMappingURL=lzw-worker.js.map