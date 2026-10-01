//#region src/warn.ts
/**
* Development-only warnings. Bundlers replace `process.env.NODE_ENV` with a
* literal, so production builds drop the warnings. Without a bundler `process`
* is undefined and warnings stay on.
*/
function isDev() {
	try {
		return true;
	} catch {
		return true;
	}
}
function warn(message) {
	if (isDev()) console.warn(`[browser-image-enhancement] ${message}`);
}
//#endregion
export { warn };

//# sourceMappingURL=warn.js.map