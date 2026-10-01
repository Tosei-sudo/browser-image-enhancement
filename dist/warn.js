/**
 * Development-only warnings. Bundlers replace `process.env.NODE_ENV` with a
 * literal, so production builds drop the warnings. Without a bundler `process`
 * is undefined and warnings stay on.
 */
function isDev() {
    try {
        return process.env.NODE_ENV !== 'production';
    }
    catch {
        return true;
    }
}
export function warn(message) {
    if (isDev())
        console.warn(`[browser-image-enhancement] ${message}`);
}
//# sourceMappingURL=warn.js.map