//#region src/core/wasm.d.ts
/** Whether the engine is used, and whether it is ready. See {@link wasmStatus}. */
export type WasmStatus = 'ready' | 'loading' | 'unavailable' | 'off';
/**
 * Turns the WebAssembly engine on (the default) or off. Off, every pixel goes
 * through the JS engine; the results are the same either way. Applies to
 * this thread and to the workers `run` uses.
 */
export declare function configureWasm(options: {
  enabled?: boolean;
}): void;
/**
 * `ready` when pixels go through WebAssembly, `loading` while it compiles,
 * `unavailable` when the browser cannot run it (or a CSP forbids it), `off`
 * after `configureWasm({ enabled: false })`.
 */
export declare function wasmStatus(): WasmStatus;
//#endregion
//# sourceMappingURL=wasm.d.ts.map