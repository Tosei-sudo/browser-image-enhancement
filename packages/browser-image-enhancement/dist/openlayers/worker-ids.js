//#region src/openlayers/worker-ids.ts
/** Negative ids for the map's requests to the worker pool, so they never meet the ids `execute` gives its strips on the same worker. */
let next = -1;
function nextWorkerId() {
	return next--;
}
//#endregion
export { nextWorkerId };

//# sourceMappingURL=worker-ids.js.map