//#region src/openlayers/lzw.ts
/**
* A fast decoder for TIFF's LZW compression (the usual one of GDAL and
* ArcGIS exports), with TIFF's predictors undone.
*
* geotiff.js's own LZW decoder builds each tile in a plain array, one value
* at a time, with a new array for every code read: about 6 MB/s, so a 12
* megapixel RGB image takes seconds. This one writes straight into a byte
* array, each dictionary string copied from where it was first written, and
* reads codes from a bit buffer: tens of times faster, with the same output
* (including geotiff.js's handling of a full 12-bit table without a clear
* code, and of data that ends without an end code).
*/
const CLEAR = 256;
const END = 257;
const FIRST = 258;
const MAX_CODES = 4096;
/**
* The bytes LZW-compressed in `input`. `expected` (the size the block
* should have, when known) sizes the output; it grows when there is more.
*/
function decodeLzw(input, expected = 0) {
	const start = new Int32Array(MAX_CODES);
	const length = new Uint16Array(MAX_CODES);
	let out = new Uint8Array(Math.max(expected, input.length * 2, 1024));
	let pos = 0;
	let next = FIRST;
	let bits = 9;
	let previous = -1;
	let previousStart = 0;
	const end = input.length * 8;
	let acc = 0;
	let held = 0;
	let read = 0;
	for (;;) {
		if (read * 8 - held >= end) break;
		while (held < bits) {
			acc = (acc << 8 | (read < input.length ? input[read] : 0)) & 16777215;
			read++;
			held += 8;
		}
		held -= bits;
		const code = acc >>> held & (1 << bits) - 1;
		if (code === END) break;
		if (code === CLEAR) {
			next = FIRST;
			bits = 9;
			previous = -1;
			continue;
		}
		const at = pos;
		if (code < next) {
			if (code < CLEAR) {
				if (pos + 1 > out.length) out = grow(out, pos, pos + 1);
				out[pos++] = code;
			} else {
				const len = length[code];
				if (pos + len > out.length) out = grow(out, pos, pos + len);
				const from = start[code];
				if (len < 32) for (let k = 0; k < len; k++) out[pos + k] = out[from + k];
				else out.copyWithin(pos, from, from + len);
				pos += len;
			}
		} else {
			if (previous < 0) throw new Error(`Invalid LZW code: ${code} with no previous code`);
			const len = previous < CLEAR ? 1 : length[previous];
			if (pos + len + 1 > out.length) out = grow(out, pos, pos + len + 1);
			if (len < 32) for (let k = 0; k < len; k++) out[pos + k] = out[previousStart + k];
			else out.copyWithin(pos, previousStart, previousStart + len);
			out[pos + len] = out[pos];
			pos += len + 1;
		}
		if (previous >= 0) {
			start[next] = previousStart;
			length[next] = (previous < CLEAR ? 1 : length[previous]) + 1;
			next++;
		}
		previous = code;
		previousStart = at;
		if (next + 1 >= 1 << bits) {
			if (bits === 12) previous = -1;
			else bits++;
		}
	}
	return out.subarray(0, pos);
}
/** `out` with room for `need` bytes, its first `used` kept. */
function grow(out, used, need) {
	let size = out.length * 2;
	while (size < need) size *= 2;
	const bigger = new Uint8Array(size);
	bigger.set(out.subarray(0, used));
	return bigger;
}
/** Undoes the predictor of a decoded block, in place, as geotiff.js does (rows of the machine's byte order). */
function undoPredictor(block, parameters) {
	const { predictor, tileWidth: width, tileHeight: height, planarConfiguration } = parameters;
	if (!predictor || predictor === 1) return block;
	const bits = typeof parameters.bitsPerSample === "number" ? [parameters.bitsPerSample] : Array.from(parameters.bitsPerSample);
	for (const b of bits) {
		if (b % 8 !== 0) throw new Error("When decoding with predictor, only multiple of 8 bits are supported.");
		if (b !== bits[0]) throw new Error("When decoding with predictor, all samples must have the same size.");
	}
	const bytes = bits[0] / 8;
	const stride = planarConfiguration === 2 ? 1 : bits.length;
	const rowBytes = stride * width * bytes;
	for (let i = 0; i < height; i++) {
		if (i * rowBytes >= block.byteLength) break;
		if (predictor === 2) {
			const at = i * rowBytes;
			if (bits[0] === 8) accumulate(new Uint8Array(block, at, rowBytes), stride);
			else if (bits[0] === 16) accumulate(new Uint16Array(block, at, rowBytes / 2), stride);
			else if (bits[0] === 32) accumulate(new Uint32Array(block, at, rowBytes / 4), stride);
			else throw new Error(`Predictor 2 not allowed with ${bits[0]} bits per sample.`);
		} else if (predictor === 3) floatingPoint(new Uint8Array(block, i * rowBytes, rowBytes), stride, bytes);
	}
	return block;
}
function accumulate(row, stride) {
	for (let i = stride; i < row.length; i++) row[i] += row[i - stride];
}
function floatingPoint(row, stride, bytes) {
	for (let i = stride; i < row.length; i++) row[i] += row[i - stride];
	const count = row.length / bytes;
	const copy = row.slice();
	for (let i = 0; i < count; i++) for (let b = 0; b < bytes; b++) row[bytes * i + b] = copy[(bytes - b - 1) * count + i];
}
/** An LZW block of a TIFF decoded, its predictor undone: what geotiff.js's LZW decoder gives, much faster. */
function decodeLzwBlock(buffer, parameters) {
	const bits = typeof parameters.bitsPerSample === "number" ? [parameters.bitsPerSample] : Array.from(parameters.bitsPerSample);
	const samples = parameters.planarConfiguration === 2 ? 1 : bits.length;
	const expected = Math.ceil(parameters.tileWidth * parameters.tileHeight * samples * bits[0] / 8);
	const out = decodeLzw(new Uint8Array(buffer), expected);
	return undoPredictor(out.byteLength === out.buffer.byteLength ? out.buffer : out.slice().buffer, parameters);
}
//#endregion
export { decodeLzw, decodeLzwBlock, undoPredictor };

//# sourceMappingURL=lzw.js.map