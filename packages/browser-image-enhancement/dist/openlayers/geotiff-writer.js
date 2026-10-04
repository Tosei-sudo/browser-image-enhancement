//#region src/openlayers/geotiff-writer.ts
const ASCII = 2;
const SHORT = 3;
const LONG = 4;
const DOUBLE = 12;
const TYPE_SIZE = {
	[ASCII]: 1,
	[SHORT]: 2,
	[LONG]: 4,
	[DOUBLE]: 8
};
/**
* The image as a tiled GeoTIFF (with overviews) covering `placement.extent`.
*
* @example
* ```ts
* const blob = imageToGeoTIFF(await toImageData(file), { extent: [x0, y0, x1, y1], epsg: 3857 });
* const source = new EnhancedGeoTIFF({ sources: [{ blob }] });
* ```
*/
function imageToGeoTIFF(image, placement) {
	const { width, height, data } = image;
	if (!(width > 0 && height > 0)) throw new RangeError("The image is empty.");
	const tileSize = placement.tileSize ?? 256;
	if (tileSize % 16 !== 0 || tileSize <= 0) throw new RangeError("tileSize must be a positive multiple of 16.");
	const epsg = placement.epsg ?? 3857;
	const [minX, minY, maxX, maxY] = placement.extent;
	if (!(maxX > minX && maxY > minY)) throw new RangeError("The extent is empty.");
	const { gray, alpha } = inspect(data);
	const bands = (gray ? 1 : 3) + (alpha ? 1 : 0);
	const levels = [{
		width,
		height,
		data
	}];
	while (Math.max(levels[levels.length - 1].width, levels[levels.length - 1].height) > tileSize) levels.push(halve(levels[levels.length - 1]));
	return serialize(levels.map((level, i) => {
		const across = Math.ceil(level.width / tileSize);
		const down = Math.ceil(level.height / tileSize);
		const tiles = [];
		for (let ty = 0; ty < down; ty++) for (let tx = 0; tx < across; tx++) tiles.push(tile(level, tx * tileSize, ty * tileSize, tileSize, bands, gray));
		const entries = [
			{
				tag: 254,
				type: LONG,
				values: [i === 0 ? 0 : 1]
			},
			{
				tag: 256,
				type: LONG,
				values: [level.width]
			},
			{
				tag: 257,
				type: LONG,
				values: [level.height]
			},
			{
				tag: 258,
				type: SHORT,
				values: new Array(bands).fill(8)
			},
			{
				tag: 259,
				type: SHORT,
				values: [1]
			},
			{
				tag: 262,
				type: SHORT,
				values: [gray ? 1 : 2]
			},
			{
				tag: 277,
				type: SHORT,
				values: [bands]
			},
			{
				tag: 284,
				type: SHORT,
				values: [1]
			},
			{
				tag: 322,
				type: LONG,
				values: [tileSize]
			},
			{
				tag: 323,
				type: LONG,
				values: [tileSize]
			},
			{
				tag: 324,
				type: LONG,
				values: new Array(tiles.length).fill(0)
			},
			{
				tag: 325,
				type: LONG,
				values: tiles.map((t) => t.length)
			}
		];
		if (alpha) entries.push({
			tag: 338,
			type: SHORT,
			values: [2]
		});
		entries.push({
			tag: 339,
			type: SHORT,
			values: new Array(bands).fill(1)
		});
		if (i === 0) {
			const geographic = epsg === 4326;
			entries.push({
				tag: 33550,
				type: DOUBLE,
				values: [
					(maxX - minX) / width,
					(maxY - minY) / height,
					0
				]
			}, {
				tag: 33922,
				type: DOUBLE,
				values: [
					0,
					0,
					0,
					minX,
					maxY,
					0
				]
			}, {
				tag: 34735,
				type: SHORT,
				values: [
					1,
					1,
					0,
					3,
					1024,
					0,
					1,
					geographic ? 2 : 1,
					1025,
					0,
					1,
					1,
					geographic ? 2048 : 3072,
					0,
					1,
					epsg
				]
			});
		}
		return {
			entries,
			tiles
		};
	}));
}
/**
* A raster as a tiled GeoTIFF with overviews, keeping its sample type, band
* count, no-data value and georeferencing. Use it to give a GeoTIFF that has
* no overviews (a plain, non-cloud-optimized one) the levels OpenLayers reads
* when zoomed out: without them every view is drawn from the full image and
* looks jagged when zoomed out. Overviews average 2×2 pixels per band,
* leaving out no-data and NaN.
*
* With `statistics: true` each band's lowest and highest value (no-data and
* NaN left out) are written as GDAL metadata (`STATISTICS_MINIMUM` /
* `STATISTICS_MAXIMUM`). OpenLayers then maps that range to 0-255 instead of
* the whole range of the sample type, so 16-bit and float data (elevations,
* 11-bit satellite images) are not crushed into a few gray levels.
*
* @example
* ```ts
* const image = await (await fromBlob(file)).getImage();
* const data = (await image.readRasters({ interleave: true })) as Uint16Array;
* const fd = image.fileDirectory;
* const blob = rasterToGeoTIFF({
*   width: image.getWidth(), height: image.getHeight(), bands: image.getSamplesPerPixel(), data,
*   noData: image.getGDALNoData(),
*   geo: { modelPixelScale: fd.ModelPixelScale, modelTiepoint: fd.ModelTiepoint, geoKeyDirectory: fd.GeoKeyDirectory },
* });
* ```
*/
function rasterToGeoTIFF(raster, options = {}) {
	const { width, height, bands, data } = raster;
	if (!(width > 0 && height > 0 && bands > 0)) throw new RangeError("The raster is empty.");
	if (data.length !== width * height * bands) throw new RangeError("data must hold width × height × bands samples.");
	const tileSize = options.tileSize ?? 256;
	if (tileSize % 16 !== 0 || tileSize <= 0) throw new RangeError("tileSize must be a positive multiple of 16.");
	const { bits, format } = sampleType(data);
	const noData = raster.noData ?? null;
	const metadata = options.statistics ? gdalStatistics(data, bands, noData) : null;
	const levels = [{
		width,
		height,
		data
	}];
	while (Math.max(levels[levels.length - 1].width, levels[levels.length - 1].height) > tileSize) levels.push(halveRaster(levels[levels.length - 1], bands, noData));
	return serialize(levels.map((level, i) => {
		const across = Math.ceil(level.width / tileSize);
		const down = Math.ceil(level.height / tileSize);
		const tiles = [];
		for (let ty = 0; ty < down; ty++) for (let tx = 0; tx < across; tx++) tiles.push(rasterTile(level, tx * tileSize, ty * tileSize, tileSize, bands, noData));
		const entries = [
			{
				tag: 254,
				type: LONG,
				values: [i === 0 ? 0 : 1]
			},
			{
				tag: 256,
				type: LONG,
				values: [level.width]
			},
			{
				tag: 257,
				type: LONG,
				values: [level.height]
			},
			{
				tag: 258,
				type: SHORT,
				values: new Array(bands).fill(bits)
			},
			{
				tag: 259,
				type: SHORT,
				values: [1]
			},
			{
				tag: 262,
				type: SHORT,
				values: [raster.photometric ?? (bands >= 3 ? 2 : 1)]
			},
			{
				tag: 277,
				type: SHORT,
				values: [bands]
			},
			{
				tag: 284,
				type: SHORT,
				values: [1]
			},
			{
				tag: 322,
				type: LONG,
				values: [tileSize]
			},
			{
				tag: 323,
				type: LONG,
				values: [tileSize]
			},
			{
				tag: 324,
				type: LONG,
				values: new Array(tiles.length).fill(0)
			},
			{
				tag: 325,
				type: LONG,
				values: tiles.map((t) => t.length)
			}
		];
		if (raster.extraSamples?.length) entries.push({
			tag: 338,
			type: SHORT,
			values: [...raster.extraSamples]
		});
		entries.push({
			tag: 339,
			type: SHORT,
			values: new Array(bands).fill(format)
		});
		if (i === 0) {
			const g = raster.geo;
			if (g.modelPixelScale) entries.push({
				tag: 33550,
				type: DOUBLE,
				values: [...g.modelPixelScale]
			});
			if (g.modelTiepoint) entries.push({
				tag: 33922,
				type: DOUBLE,
				values: [...g.modelTiepoint]
			});
			if (g.modelTransformation) entries.push({
				tag: 34264,
				type: DOUBLE,
				values: [...g.modelTransformation]
			});
			if (g.geoKeyDirectory) entries.push({
				tag: 34735,
				type: SHORT,
				values: [...g.geoKeyDirectory]
			});
			if (g.geoDoubleParams) entries.push({
				tag: 34736,
				type: DOUBLE,
				values: [...g.geoDoubleParams]
			});
			if (g.geoAsciiParams) entries.push({
				tag: 34737,
				type: ASCII,
				values: ascii(g.geoAsciiParams)
			});
		}
		if (metadata) entries.push({
			tag: 42112,
			type: ASCII,
			values: ascii(metadata)
		});
		if (noData !== null) entries.push({
			tag: 42113,
			type: ASCII,
			values: ascii(String(noData))
		});
		entries.sort((a, b) => a.tag - b.tag);
		return {
			entries,
			tiles
		};
	}));
}
/** GDAL metadata XML with each band's lowest and highest value, or null when every sample is no-data. */
function gdalStatistics(data, bands, noData) {
	const min = new Array(bands).fill(Infinity);
	const max = new Array(bands).fill(-Infinity);
	for (let i = 0; i < data.length; i += bands) for (let b = 0; b < bands; b++) {
		const v = data[i + b];
		if (v !== v || v === noData) continue;
		if (v < min[b]) min[b] = v;
		if (v > max[b]) max[b] = v;
	}
	if (!(min[0] <= max[0])) return null;
	return `<GDALMetadata>${min.flatMap((_, b) => min[b] <= max[b] ? [`<Item name="STATISTICS_MINIMUM" sample="${b}">${min[b]}</Item>`, `<Item name="STATISTICS_MAXIMUM" sample="${b}">${max[b]}</Item>`] : []).join("")}</GDALMetadata>`;
}
function ascii(text) {
	const codes = Array.from(text, (c) => c.charCodeAt(0) & 127);
	if (codes[codes.length - 1] !== 0) codes.push(0);
	return codes;
}
function sampleType(data) {
	const bits = data.BYTES_PER_ELEMENT * 8;
	if (data instanceof Float32Array || data instanceof Float64Array) return {
		bits,
		format: 3
	};
	if (data instanceof Int8Array || data instanceof Int16Array || data instanceof Int32Array) return {
		bits,
		format: 2
	};
	return {
		bits,
		format: 1
	};
}
/** One tile of a raster, as little-endian bytes; no-data (or zero) past the raster's edge. */
function rasterTile(level, x0, y0, size, bands, noData) {
	const Type = level.data.constructor;
	const out = new Type(size * size * bands);
	if (noData !== null && noData !== 0) out.fill(noData);
	const w = Math.min(size, level.width - x0);
	const h = Math.min(size, level.height - y0);
	for (let y = 0; y < h; y++) {
		const from = ((y0 + y) * level.width + x0) * bands;
		out.set(level.data.subarray(from, from + w * bands), y * size * bands);
	}
	return littleEndian(out);
}
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
function littleEndian(a) {
	const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
	if (LITTLE_ENDIAN || a.BYTES_PER_ELEMENT === 1) return bytes;
	const out = new Uint8Array(bytes.length);
	const n = a.BYTES_PER_ELEMENT;
	for (let i = 0; i < bytes.length; i += n) for (let k = 0; k < n; k++) out[i + k] = bytes[i + n - 1 - k];
	return out;
}
/** The raster at half the size (rounded up), each sample the mean of up to 2×2, without no-data and NaN. */
function halveRaster(level, bands, noData) {
	const { width, height, data } = level;
	const w = Math.ceil(width / 2);
	const h = Math.ceil(height / 2);
	const Type = data.constructor;
	const out = new Type(w * h * bands);
	const float = data instanceof Float32Array || data instanceof Float64Array;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let b = 0; b < bands; b++) {
		let sum = 0;
		let n = 0;
		for (let dy = 0; dy < 2; dy++) {
			const sy = 2 * y + dy;
			if (sy >= height) continue;
			for (let dx = 0; dx < 2; dx++) {
				const sx = 2 * x + dx;
				if (sx >= width) continue;
				const v = data[(sy * width + sx) * bands + b];
				if (v !== v || v === noData) continue;
				sum += v;
				n++;
			}
		}
		out[(y * w + x) * bands + b] = n === 0 ? noData ?? (float ? NaN : 0) : float ? sum / n : Math.round(sum / n);
	}
	return {
		width: w,
		height: h,
		data: out
	};
}
/** The TIFF file: header, then each IFD with its out-of-line values, then the tiles. */
function serialize(ifds) {
	const ifdSize = (entries) => 2 + entries.length * 12 + 4 + outOfLineSize(entries);
	let offset = 8;
	const ifdOffsets = ifds.map(({ entries }) => {
		const at = offset;
		offset += ifdSize(entries);
		offset += offset & 1;
		return at;
	});
	for (const ifd of ifds) {
		const offsets = ifd.entries.find((e) => e.tag === 324).values;
		ifd.tiles.forEach((t, k) => {
			offsets[k] = offset;
			offset += t.length;
		});
	}
	if (offset > 4294967295) throw new RangeError("The image is too large for a GeoTIFF of this kind (over 4 GB).");
	const buffer = new ArrayBuffer(offset);
	const view = new DataView(buffer);
	const bytes = new Uint8Array(buffer);
	view.setUint16(0, 18761);
	view.setUint16(2, 42, true);
	view.setUint32(4, ifdOffsets[0], true);
	ifds.forEach(({ entries, tiles }, i) => {
		let at = ifdOffsets[i];
		let extra = at + 2 + entries.length * 12 + 4;
		view.setUint16(at, entries.length, true);
		at += 2;
		for (const e of entries) {
			const size = TYPE_SIZE[e.type] * e.values.length;
			view.setUint16(at, e.tag, true);
			view.setUint16(at + 2, e.type, true);
			view.setUint32(at + 4, e.values.length, true);
			if (size <= 4) writeValues(view, at + 8, e);
			else {
				view.setUint32(at + 8, extra, true);
				writeValues(view, extra, e);
				extra += size + (size & 1);
			}
			at += 12;
		}
		view.setUint32(at, i + 1 < ifds.length ? ifdOffsets[i + 1] : 0, true);
		const offsets = entries.find((e) => e.tag === 324).values;
		tiles.forEach((t, k) => bytes.set(t, offsets[k]));
	});
	return new Blob([buffer], { type: "image/tiff" });
}
function outOfLineSize(entries) {
	let n = 0;
	for (const e of entries) {
		const size = TYPE_SIZE[e.type] * e.values.length;
		if (size > 4) n += size + (size & 1);
	}
	return n;
}
function writeValues(view, at, e) {
	const step = TYPE_SIZE[e.type];
	e.values.forEach((v, k) => {
		if (e.type === ASCII) view.setUint8(at + k, v);
		else if (e.type === SHORT) view.setUint16(at + k * step, v, true);
		else if (e.type === LONG) view.setUint32(at + k * step, v, true);
		else view.setFloat64(at + k * step, v, true);
	});
}
/** Whether every visible pixel is gray, and whether any pixel is not fully opaque. */
function inspect(data) {
	let gray = true;
	let alpha = false;
	for (let i = 0; i < data.length; i += 4) {
		const a = data[i + 3];
		if (a !== 255) alpha = true;
		if (gray && a !== 0 && (data[i] !== data[i + 1] || data[i] !== data[i + 2])) gray = false;
		if (alpha && !gray) break;
	}
	return {
		gray,
		alpha
	};
}
/** One tile, `size`×`size` pixels, with the image's bands; transparent (zero) past the image's edge. */
function tile(level, x0, y0, size, bands, gray) {
	const out = new Uint8Array(size * size * bands);
	const w = Math.min(size, level.width - x0);
	const h = Math.min(size, level.height - y0);
	const src = level.data;
	for (let y = 0; y < h; y++) {
		let i = ((y0 + y) * level.width + x0) * 4;
		let o = y * size * bands;
		for (let x = 0; x < w; x++, i += 4) {
			if (gray) out[o++] = src[i];
			else {
				out[o++] = src[i];
				out[o++] = src[i + 1];
				out[o++] = src[i + 2];
			}
			if (bands === 2 || bands === 4) out[o++] = src[i + 3];
		}
	}
	return out;
}
/** The image at half the size (rounded up), each pixel the alpha-weighted mean of up to 2×2. */
function halve(level) {
	const { width, height, data } = level;
	const w = Math.ceil(width / 2);
	const h = Math.ceil(height / 2);
	const out = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		let r = 0, g = 0, b = 0, a = 0, n = 0;
		for (let dy = 0; dy < 2; dy++) {
			const sy = 2 * y + dy;
			if (sy >= height) continue;
			for (let dx = 0; dx < 2; dx++) {
				const sx = 2 * x + dx;
				if (sx >= width) continue;
				const i = (sy * width + sx) * 4;
				const wa = data[i + 3];
				r += data[i] * wa;
				g += data[i + 1] * wa;
				b += data[i + 2] * wa;
				a += wa;
				n++;
			}
		}
		const o = (y * w + x) * 4;
		if (a > 0) {
			out[o] = Math.round(r / a);
			out[o + 1] = Math.round(g / a);
			out[o + 2] = Math.round(b / a);
		}
		out[o + 3] = Math.round(a / n);
	}
	return {
		width: w,
		height: h,
		data: out
	};
}
//#endregion
export { imageToGeoTIFF, rasterToGeoTIFF };

//# sourceMappingURL=geotiff-writer.js.map