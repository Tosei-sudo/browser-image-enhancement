//#region ../workers/src/abort.ts
/** Helpers for cancelling work with an AbortSignal. */
function abortError(signal) {
	const reason = signal?.reason;
	if (reason instanceof Error) return reason;
	if (typeof DOMException !== "undefined") return new DOMException("The operation was aborted.", "AbortError");
	const e = /* @__PURE__ */ new Error("The operation was aborted.");
	e.name = "AbortError";
	return e;
}
function throwIfAborted(signal) {
	if (signal?.aborted) throw abortError(signal);
}
/** Resolves with `promise`, or rejects as soon as `signal` aborts. */
function race(promise, signal) {
	if (!signal) return promise;
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(abortError(signal));
		if (signal.aborted) return onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then((v) => {
			signal.removeEventListener("abort", onAbort);
			resolve(v);
		}, (e) => {
			signal.removeEventListener("abort", onAbort);
			reject(e);
		});
	});
}
//#endregion
export { abortError, race, throwIfAborted };

//# sourceMappingURL=abort.js.map