const shims = new Map();
/**
 * Returns a Blob URL for a module worker that imports the `worker.js` next to
 * `moduleUrl`, or null when that file is same-origin with the page and can be
 * started directly.
 */
export function crossOriginWorkerUrl(moduleUrl, pageOrigin) {
    // Not written as `new URL('./worker.js', import.meta.url)` so bundlers don't treat it as an asset.
    const script = new URL('worker.js', moduleUrl);
    if (pageOrigin === undefined || script.origin === pageOrigin)
        return null;
    let shim = shims.get(script.href);
    if (!shim) {
        // One small Blob per script URL, kept for the page's lifetime so workers can restart.
        shim = URL.createObjectURL(new Blob([`import ${JSON.stringify(script.href)};`], { type: 'text/javascript' }));
        shims.set(script.href, shim);
    }
    return shim;
}
export function defaultCreateWorker() {
    const shim = crossOriginWorkerUrl(import.meta.url, globalThis.location?.origin);
    if (shim)
        return new Worker(shim, { type: 'module' });
    return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
}
//# sourceMappingURL=default-worker.js.map