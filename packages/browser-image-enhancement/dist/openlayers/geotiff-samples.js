//#region src/openlayers/geotiff-samples.ts
/**
* True when every image the source reads holds unsigned 8-bit samples. Reads
* the images OpenLayers opened (`sourceImagery_`, set before the loader);
* false when they cannot be read, so the values are stretched here.
*/
function isEightBit(source) {
	const imagery = source.sourceImagery_;
	if (!Array.isArray(imagery) || imagery.length === 0) return false;
	try {
		return imagery.every((levels) => {
			const image = levels?.[0];
			if (!image) return false;
			for (let s = 0; s < image.getSamplesPerPixel(); s++) if (image.getBitsPerSample(s) !== 8 || (image.getSampleFormat(s) ?? 1) !== 1) return false;
			return true;
		});
	} catch {
		return false;
	}
}
/**
* Makes OpenLayers read an 8-bit image's values as they are (0-255). Given no
* `min`/`max`, it scales every band by the `STATISTICS_MINIMUM`/`MAXIMUM`
* that GDAL wrote for the first band, so a file with statistics (of a darker
* first band, or stale ones) comes out washed out or all white.
*/
function keepEightBitRange(source) {
	const info = source.sourceInfo_;
	for (const s of info ?? []) {
		s.min ??= 0;
		s.max ??= 255;
	}
}
/** Largest float32 value. */
const FLOAT32_MAX = 34028234663852886e22;
/**
* For a float32 image whose no-data value OpenLayers cannot match: the
* test for that value. `GDAL_NODATA` is text, often rounded
* ("-3.40282e+38" for the lowest float), so a sample never equals the
* number read from it, and the fill shows instead of being transparent.
* GDAL itself writes the overviews with the rounded value cast to float32,
* and the full image often with the exact lowest float: as GDAL does, a
* value close to the largest float stands for any value that close. Null
* when the samples are not float32 or the value matches as it is.
*/
function floatNoData(source) {
	const s = source;
	const imagery = s.sourceImagery_;
	if (!Array.isArray(imagery) || imagery.length !== 1) return null;
	const image = imagery[0]?.[imagery[0].length - 1];
	const nodata = s.nodataValues_?.[0]?.find((v) => v !== null && v !== void 0);
	if (!image || typeof nodata !== "number" || !Number.isFinite(nodata)) return null;
	try {
		if (image.getSampleFormat(0) !== 3 || image.getBitsPerSample(0) !== 32) return null;
	} catch {
		return null;
	}
	if (Math.abs(Math.abs(nodata) - FLOAT32_MAX) <= FLOAT32_MAX * 1e-5) {
		const edge = Math.sign(nodata) * FLOAT32_MAX * .99999;
		return nodata < 0 ? (v) => v <= edge : (v) => v >= edge;
	}
	const f = Math.fround(nodata);
	return f === nodata ? null : (v) => v === f;
}
//#endregion
export { floatNoData, isEightBit, keepEightBitRange };

//# sourceMappingURL=geotiff-samples.js.map