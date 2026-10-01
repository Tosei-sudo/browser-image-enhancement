import { crossOriginWorkerUrl as crossOriginWorkerUrl$1 } from "../workers/src/cross-origin.js";
//#region src/worker/default-worker.ts
/**
* How the pool starts a worker when no `createWorker` is configured.
*
* The worker file sits next to this module and is found with
* `new URL('./worker.js', import.meta.url)`, which bundlers understand. When the
* package itself is loaded from another origin (a CDN), browsers refuse to start
* a worker from that URL, so a same-origin Blob worker that imports it is used
* instead. The CDN bundles replace this module with `default-worker.inline.ts`.
*/
/**
* Returns a Blob URL for a module worker that imports the `worker.js` next to
* `moduleUrl`, or null when that file is same-origin with the page and can be
* started directly.
*/
function crossOriginWorkerUrl(moduleUrl, pageOrigin) {
	return crossOriginWorkerUrl$1(new URL("worker.js", moduleUrl), pageOrigin);
}
function defaultCreateWorker() {
	const shim = crossOriginWorkerUrl(import.meta.url, globalThis.location?.origin);
	if (shim) return new Worker(shim, { type: "module" });
	return new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
}
//#endregion
export { crossOriginWorkerUrl, defaultCreateWorker };

//# sourceMappingURL=default-worker.js.map