//#region ../workers/src/serve.ts
/**
* Runs inside the worker. `createHandler` receives a `post` function and returns
* the handler for each request. Sends `ready` once the handler is installed.
*/
function serveWorker(createHandler) {
	const scope = self;
	const handle = createHandler((message, transfer) => scope.postMessage(message, transfer ?? []));
	scope.onmessage = (event) => handle(event.data);
	scope.postMessage({ type: "ready" });
}
//#endregion
export { serveWorker };

//# sourceMappingURL=serve.js.map