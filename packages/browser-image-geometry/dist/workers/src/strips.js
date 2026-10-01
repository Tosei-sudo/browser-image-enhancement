//#region ../workers/src/strips.ts
/** Helpers for cutting an image into horizontal strips, one per worker. */
/** Splits `height` rows into `count` contiguous ranges of near-equal size. */
function splitRows(height, count) {
	const n = Math.max(1, Math.min(count, height));
	const ranges = [];
	for (let i = 0; i < n; i++) ranges.push([Math.floor(height * i / n), Math.floor(height * (i + 1) / n)]);
	return ranges;
}
/** How many strips an image of `pixels` pixels and `height` rows is worth splitting into. */
function stripCount(pixels, height, maxWorkers, minStripPixels) {
	return Math.max(1, Math.min(maxWorkers, Math.ceil(pixels / minStripPixels), height));
}
/** Lets other main-thread tasks (rendering, input) run between strip copies. */
function yieldToEventLoop() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}
//#endregion
export { splitRows, stripCount, yieldToEventLoop };

//# sourceMappingURL=strips.js.map