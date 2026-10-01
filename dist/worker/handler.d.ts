import type { WorkerRequest, WorkerResponse } from './protocol.js';
export type Post = (message: WorkerResponse, transfer?: Transferable[]) => void;
export declare function createWorkerHandler(post: Post): (request: WorkerRequest) => void;
//# sourceMappingURL=handler.d.ts.map