import { serveWorker } from "../workers/src/serve.js";
import { createWorkerHandler } from "./handler.js";
//#region src/worker/worker.ts
/** Web Worker entry. Loaded by the pool with `new URL('./worker.js', import.meta.url)`. */
serveWorker(createWorkerHandler);
//#endregion

//# sourceMappingURL=worker.js.map