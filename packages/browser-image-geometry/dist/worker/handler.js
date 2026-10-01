import { renderRows } from "../resample.js";
//#region src/worker/handler.ts
const EMPTY = /* @__PURE__ */ new Uint8ClampedArray(0);
function createWorkerHandler(post) {
	return (request) => {
		try {
			if (request.type !== "warp") throw new Error(`Unknown request: ${String(request.type)}`);
			const { window: w, width, y0, y1 } = request;
			const src = w ? {
				data: new Uint8ClampedArray(w.buffer),
				width: w.width,
				height: w.height,
				x0: w.x0,
				y0: w.y0
			} : {
				data: EMPTY,
				width: 0,
				height: 0,
				x0: 0,
				y0: 0
			};
			const out = new Uint8ClampedArray((y1 - y0) * width * 4);
			renderRows(src, request.mapping, width, y0, y1, request.resample, request.background, out);
			post({
				type: "done",
				id: request.id,
				buffer: out.buffer
			}, [out.buffer]);
		} catch (e) {
			post({
				type: "error",
				id: request.id,
				message: e instanceof Error ? e.message : String(e)
			});
		}
	};
}
//#endregion
export { createWorkerHandler };

//# sourceMappingURL=handler.js.map