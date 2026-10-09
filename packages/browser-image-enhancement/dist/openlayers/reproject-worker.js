import { getPool } from "../worker/pool.js";
//#region src/openlayers/reproject-worker.ts
/**
* Runs {@link drawTriangles} in the library's worker pool, so reprojecting
* tiles does not hold up the main thread while the map pans.
*/
/** Negative ids, so they never meet the ids `execute` gives its strips on the same worker. */
let nextId = -1;
/** The tile drawn in a worker, or null when no worker can run (the caller then draws it itself). */
async function drawInWorker(job) {
	if (typeof Worker === "undefined") return null;
	const pool = getPool();
	if (!pool.available) return null;
	let slot;
	try {
		[slot] = await pool.acquire(1);
	} catch {
		return null;
	}
	const id = nextId--;
	const float = job.stitch instanceof Float32Array;
	const { stitch, corners, ...rest } = job;
	const response = await pool.request(slot, {
		type: "reproject",
		id,
		job: {
			...rest,
			stitch: stitch.buffer,
			corners: corners.buffer,
			float
		}
	}, [stitch.buffer, corners.buffer]);
	if (response.type !== "reprojected") return null;
	return float ? new Float32Array(response.buffer) : new Uint8ClampedArray(response.buffer);
}
//#endregion
export { drawInWorker };

//# sourceMappingURL=reproject-worker.js.map