/**
 * Browsers refuse to start a worker from a script on another origin, which is
 * where a package loaded from a CDN keeps its worker file. A same-origin Blob
 * module that imports the script works instead.
 */

const shims = new Map<string, string>();

/**
 * Returns a Blob URL for a module worker that imports `script`, or null when
 * `script` is same-origin with the page (or there is no page) and can be started directly.
 */
export function crossOriginWorkerUrl(script: URL, pageOrigin: string | undefined): string | null {
  if (pageOrigin === undefined || script.origin === pageOrigin) return null;
  let shim = shims.get(script.href);
  if (!shim) {
    // One small Blob per script URL, kept for the page's lifetime so workers can restart.
    shim = URL.createObjectURL(new Blob([`import ${JSON.stringify(script.href)};`], { type: 'text/javascript' }));
    shims.set(script.href, shim);
  }
  return shim;
}
