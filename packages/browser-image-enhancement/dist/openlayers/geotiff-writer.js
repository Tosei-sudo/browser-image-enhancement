//#region src/openlayers/geotiff-writer.ts
const SHORT = 3;
const LONG = 4;
const DOUBLE = 12;
const TYPE_SIZE = {
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
	const ifds = levels.map((level, i) => {
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
	});
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
		if (e.type === SHORT) view.setUint16(at + k * step, v, true);
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
export { imageToGeoTIFF };

//# sourceMappingURL=geotiff-writer.js.map