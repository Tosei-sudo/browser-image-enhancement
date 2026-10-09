//#region src/openlayers/reproject-kernel.ts
let scratchDone = /* @__PURE__ */ new Uint8Array(0);
/** The target tile's pixels (`bands` per pixel; 0 outside the triangles). */
function drawTriangles(job) {
	const { stitch, sw, sh, bands: outBands, width: outWidth, height: outHeight, corners, linear } = job;
	const [bx0, bx1, by0, by1] = job.bounds;
	const out = stitch instanceof Float32Array ? new Float32Array(outWidth * outHeight * outBands) : new Uint8ClampedArray(outWidth * outHeight * outBands);
	const pixels = outWidth * outHeight;
	if (scratchDone.length < pixels) scratchDone = new Uint8Array(pixels);
	const done = scratchDone;
	done.fill(0, 0, pixels);
	for (let i = 0; i < corners.length; i += 12) {
		const u0 = corners[i];
		const v0 = corners[i + 1];
		const u1 = corners[i + 2];
		const v1 = corners[i + 3];
		const u2 = corners[i + 4];
		const v2 = corners[i + 5];
		const s0 = corners[i + 6];
		const t0 = corners[i + 7];
		const s1 = corners[i + 8];
		const t1 = corners[i + 9];
		const s2 = corners[i + 10];
		const t2 = corners[i + 11];
		const det = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
		if (det === 0) continue;
		const a = ((s1 - s0) * (v2 - v0) - (s2 - s0) * (v1 - v0)) / det;
		const b = ((s2 - s0) * (u1 - u0) - (s1 - s0) * (u2 - u0)) / det;
		const c = s0 - a * u0 - b * v0;
		const d = ((t1 - t0) * (v2 - v0) - (t2 - t0) * (v1 - v0)) / det;
		const e = ((t2 - t0) * (u1 - u0) - (t1 - t0) * (u2 - u0)) / det;
		const f = t0 - d * u0 - e * v0;
		const sign = det > 0 ? 1 : -1;
		const eps = -1e-7 * Math.abs(det);
		const ya = Math.max(0, Math.floor(Math.min(v0, v1, v2)));
		const yb = Math.min(outHeight - 1, Math.ceil(Math.max(v0, v1, v2)));
		const edges = [
			[
				u1,
				v1,
				u2,
				v2
			],
			[
				u2,
				v2,
				u0,
				v0
			],
			[
				u0,
				v0,
				u1,
				v1
			]
		];
		for (let y = ya; y <= yb; y++) {
			const pv = y + .5;
			let lo = 0;
			let hi = outWidth - 1;
			for (const [pa, qa, pb, qb] of edges) {
				const k = sign * (qa - qb);
				const m = sign * (pa * (qb - pv) - pb * (qa - pv));
				if (k === 0) {
					if (m < eps) hi = -1;
				} else if (k > 0) lo = Math.max(lo, Math.ceil((eps - m) / k - .5));
				else hi = Math.min(hi, Math.floor((eps - m) / k - .5));
			}
			let sx = a * (lo + .5) + b * pv + c;
			let sy = d * (lo + .5) + e * pv + f;
			for (let x = lo; x <= hi; x++, sx += a, sy += d) {
				const index = y * outWidth + x;
				if (done[index]) continue;
				if (sx < bx0 || sx > bx1 || sy < by0 || sy > by1) continue;
				done[index] = 1;
				const o = index * outBands;
				if (linear) {
					let fx = sx - .5;
					let fy = sy - .5;
					if (fx < 0) fx = 0;
					else if (fx > sw - 1) fx = sw - 1;
					if (fy < 0) fy = 0;
					else if (fy > sh - 1) fy = sh - 1;
					const ix = Math.floor(fx);
					const iy = Math.floor(fy);
					const ix1 = ix + 1 < sw ? ix + 1 : ix;
					const iy1 = iy + 1 < sh ? iy + 1 : iy;
					const ax = fx - ix;
					const ay = fy - iy;
					const p00 = (iy * sw + ix) * outBands;
					const p10 = (iy * sw + ix1) * outBands;
					const p01 = (iy1 * sw + ix) * outBands;
					const p11 = (iy1 * sw + ix1) * outBands;
					const w00 = (1 - ax) * (1 - ay);
					const w10 = ax * (1 - ay);
					const w01 = (1 - ax) * ay;
					const w11 = ax * ay;
					for (let k = 0; k < outBands; k++) out[o + k] = stitch[p00 + k] * w00 + stitch[p10 + k] * w10 + stitch[p01 + k] * w01 + stitch[p11 + k] * w11;
				} else {
					let ix = Math.floor(sx);
					let iy = Math.floor(sy);
					if (ix < 0) ix = 0;
					else if (ix > sw - 1) ix = sw - 1;
					if (iy < 0) iy = 0;
					else if (iy > sh - 1) iy = sh - 1;
					const p = (iy * sw + ix) * outBands;
					for (let k = 0; k < outBands; k++) out[o + k] = stitch[p + k];
				}
			}
		}
	}
	return out;
}
//#endregion
export { drawTriangles };

//# sourceMappingURL=reproject-kernel.js.map