//#region ../workers/src/cross-origin.ts
/**
* Browsers refuse to start a worker from a script on another origin, which is
* where a package loaded from a CDN keeps its worker file. A same-origin Blob
* module that imports the script works instead.
*/
const shims = /* @__PURE__ */ new Map();
/**
* Returns a Blob URL for a module worker that imports `script`, or null when
* `script` is same-origin with the page (or there is no page) and can be started directly.
*/
function crossOriginWorkerUrl(script, pageOrigin) {
	if (pageOrigin === void 0 || script.origin === pageOrigin) return null;
	let shim = shims.get(script.href);
	if (!shim) {
		shim = URL.createObjectURL(new Blob([`import ${JSON.stringify(script.href)};`], { type: "text/javascript" }));
		shims.set(script.href, shim);
	}
	return shim;
}
//#endregion
export { crossOriginWorkerUrl };

//# sourceMappingURL=cross-origin.js.map