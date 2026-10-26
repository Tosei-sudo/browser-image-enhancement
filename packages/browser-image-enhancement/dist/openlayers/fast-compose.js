// src/openlayers/fast-compose.ts
/** The smallest and largest value of a sample type, as OpenLayers scales samples without statistics. */
function typeRange(array) {
	if (array instanceof Int8Array) return [-128, 127];
	if (array instanceof Uint8Array || array instanceof Uint8ClampedArray) return [0, 255];
	if (array instanceof Int16Array) return [-32768, 32767];
	if (array instanceof Uint16Array) return [0, 65535];
	if (array instanceof Int32Array) return [-2147483648, 2147483647];
	if (array instanceof Uint32Array) return [0, 4294967295];
	if (array instanceof Float32Array) return [12e-39, 34e37];
	return [0, 255];
}
/** Puts the bands of each tile together with {@link composeFast} instead of OpenLayers' per-pixel loop. */
function fastComposeTiles(source) {
	const host = source;
	const original = host.composeTile_;
	if (typeof original !== "function") return;
	host.composeTile_ = (sourceTileSize, sourceSamples) => composeFast(host, sourceTileSize, sourceSamples) ?? original.call(host, sourceTileSize, sourceSamples);
}
/** The tile OpenLayers' `composeTile_` makes, or null when the samples are not in the form expected. */
function composeFast(host, sourceTileSize, sourceSamples) {
	const sourceInfo = host.sourceInfo_;
	const samplesPerPixel = host.samplesPerPixel_;
	const nodataValues = host.nodataValues_;
	const metadata = host.metadata_;
	const sourceCount = host.sourceImagery_?.length;
	if (!sourceInfo || !samplesPerPixel || !nodataValues || !metadata || !sourceCount) return null;
	const normalize = !!host.normalize_;
	const hasAlpha = host.hasAlpha;
	const bandCount = host.bandCount;
	const pixelCount = sourceTileSize[0] * sourceTileSize[1];
	let written = hasAlpha ? 1 : 0;
	for (let s = 0; s < sourceCount; s++) {
		const n = samplesPerPixel[s];
		const bands = sourceSamples[s];
		if (!bands || bands.length < n) return null;
		for (let k = 0; k < n; k++) if (!bands[k] || bands[k].length < pixelCount) return null;
		const mask = sourceSamples[sourceCount + s];
		if (mask && (!mask[0] || mask[0].length < pixelCount)) return null;
		written += n;
	}
	if (written !== bandCount) return null;
	const data = normalize ? new Uint8Array(pixelCount * bandCount) : new Float32Array(pixelCount * bandCount);
	const clear = hasAlpha ? new Uint8Array(pixelCount).fill(1) : null;
	let offset = 0;
	for (let s = 0; s < sourceCount; s++) {
		const info = sourceInfo[s];
		const n = samplesPerPixel[s];
		const stats = metadata[s]?.[0];
		for (let k = 0; k < n; k++, offset++) {
			const values = sourceSamples[s][k];
			const band = info.bands ? info.bands[k] - 1 : k;
			let gain = 1;
			let bias = 0;
			if (normalize) {
				let min = Array.isArray(info.min) ? info.min[band] : info.min;
				let max = Array.isArray(info.max) ? info.max[band] : info.max;
				if (min === void 0) min = stats && "STATISTICS_MINIMUM" in stats ? parseFloat(stats.STATISTICS_MINIMUM) : typeRange(sourceSamples[s][0])[0];
				if (max === void 0) max = stats && "STATISTICS_MAXIMUM" in stats ? parseFloat(stats.STATISTICS_MAXIMUM) : typeRange(sourceSamples[s][0])[1];
				gain = 255 / (max - min);
				bias = -min * gain;
			}
			const scale = normalize && !(gain === 1 && bias === 0 && (values instanceof Uint8Array || values instanceof Uint8ClampedArray));
			if (!clear) {
				copyBand(data, values, offset, bandCount, pixelCount, scale, gain, bias);
				continue;
			}
			let nodata;
			if (Array.isArray(info.nodata)) nodata = info.nodata[band] !== void 0 ? info.nodata[band] : nodataValues[s][band];
			else if (info.nodata !== void 0) nodata = info.nodata;
			else nodata = nodataValues[s][band];
			const nanNoData = isNaN(nodata);
			if (nanNoData ? isIntegerArray(values) : typeof nodata !== "number") {
				copyBand(data, values, offset, bandCount, pixelCount, scale, gain, bias);
				clear.fill(0);
			} else if (nanNoData) copyBandNotNaN(data, clear, values, offset, bandCount, pixelCount, scale, gain, bias);
			else copyBandNot(data, clear, values, nodata, offset, bandCount, pixelCount, scale, gain, bias);
		}
		const mask = sourceSamples[sourceCount + s];
		if (clear && mask) {
			const m = mask[0];
			for (let p = 0; p < pixelCount; p++) if (clear[p] === 0 && !m[p]) clear[p] = 1;
		}
	}
	if (clear) {
		for (let p = 0, i = bandCount - 1; p < pixelCount; p++, i += bandCount) if (clear[p] === 0) data[i] = 255;
	}
	return data;
}
function isIntegerArray(values) {
	return values instanceof Uint8Array || values instanceof Uint8ClampedArray || values instanceof Int8Array || values instanceof Uint16Array || values instanceof Int16Array || values instanceof Uint32Array || values instanceof Int32Array;
}
function copyBand(data, values, offset, stride, pixelCount, scale, gain, bias) {
	if (scale) for (let p = 0, i = offset; p < pixelCount; p++, i += stride) data[i] = Math.min(Math.max(gain * values[p] + bias, 0), 255);
	else for (let p = 0, i = offset; p < pixelCount; p++, i += stride) data[i] = values[p];
}
function copyBandNotNaN(data, clear, values, offset, stride, pixelCount, scale, gain, bias) {
	if (scale) for (let p = 0, i = offset; p < pixelCount; p++, i += stride) {
		const v = values[p];
		if (v !== v) continue;
		clear[p] = 0;
		data[i] = Math.min(Math.max(gain * v + bias, 0), 255);
	}
	else for (let p = 0, i = offset; p < pixelCount; p++, i += stride) {
		const v = values[p];
		if (v !== v) continue;
		clear[p] = 0;
		data[i] = v;
	}
}
function copyBandNot(data, clear, values, nodata, offset, stride, pixelCount, scale, gain, bias) {
	if (scale) for (let p = 0, i = offset; p < pixelCount; p++, i += stride) {
		const v = values[p];
		if (v === nodata) continue;
		clear[p] = 0;
		data[i] = Math.min(Math.max(gain * v + bias, 0), 255);
	}
	else for (let p = 0, i = offset; p < pixelCount; p++, i += stride) {
		const v = values[p];
		if (v === nodata) continue;
		clear[p] = 0;
		data[i] = v;
	}
}
export { composeFast, fastComposeTiles };

//# sourceMappingURL=fast-compose.js.map