import { WorkerUnavailableError, createSharedPool } from "../workers/src/pool.js";
import { defaultCreateWorker } from "./default-worker.js";
//#region src/worker/pool.ts
/**
* This package's worker pool: the shared pool from @browser-image/workers,
* typed with this package's messages and started with its own worker script.
*/
const shared = createSharedPool(defaultCreateWorker);
/** The pool used by `pipeline().run()`. */
const getPool = shared.getPool;
/**
* Changes how workers are created and how many run. Stops the current workers;
* new ones start on the next run with the new settings.
*/
function configureWorkers(next) {
	shared.configureWorkers(next);
}
/** Stops all workers. They restart on demand. */
function terminateWorkers() {
	shared.terminateWorkers();
}
//#endregion
export { WorkerUnavailableError, configureWorkers, getPool, terminateWorkers };

//# sourceMappingURL=pool.js.map