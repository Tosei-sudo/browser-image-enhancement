//#region src/linalg.ts
/** Small dense linear algebra for fitting transforms. */
/** Thrown when control points cannot determine a transform (too few, or degenerate). */
var DegenerateError = class extends RangeError {
	name = "DegenerateError";
};
/**
* Least-squares solution of `A·x ≈ b` for each right-hand side, by Householder QR.
* `a` is row-major with `rows × cols` entries. Throws DegenerateError when the
* columns are (numerically) linearly dependent.
*/
function leastSquares(a, rows, cols, rhs) {
	if (rows < cols) throw new DegenerateError(`Need at least ${cols} equations, got ${rows}.`);
	const m = Float64Array.from(a);
	const bs = rhs.map((b) => Float64Array.from(b));
	const diag = new Float64Array(cols);
	let maxNorm = 0;
	for (let k = 0; k < cols; k++) {
		let norm = 0;
		for (let i = k; i < rows; i++) norm = Math.hypot(norm, m[i * cols + k]);
		maxNorm = Math.max(maxNorm, norm);
		if (norm === 0) {
			diag[k] = 0;
			continue;
		}
		const alpha = m[k * cols + k] > 0 ? -norm : norm;
		m[k * cols + k] -= alpha;
		let vv = 0;
		for (let i = k; i < rows; i++) vv += m[i * cols + k] ** 2;
		if (vv > 0) {
			for (let j = k + 1; j < cols; j++) {
				let dot = 0;
				for (let i = k; i < rows; i++) dot += m[i * cols + k] * m[i * cols + j];
				const f = 2 * dot / vv;
				for (let i = k; i < rows; i++) m[i * cols + j] -= f * m[i * cols + k];
			}
			for (const b of bs) {
				let dot = 0;
				for (let i = k; i < rows; i++) dot += m[i * cols + k] * b[i];
				const f = 2 * dot / vv;
				for (let i = k; i < rows; i++) b[i] -= f * m[i * cols + k];
			}
		}
		diag[k] = alpha;
	}
	const tol = maxNorm * 1e-10 * Math.max(rows, cols);
	for (let k = 0; k < cols; k++) if (!(Math.abs(diag[k]) > tol)) throw new DegenerateError("The control points are degenerate (for example, all on one line).");
	return bs.map((b) => {
		const x = new Float64Array(cols);
		for (let k = cols - 1; k >= 0; k--) {
			let s = b[k];
			for (let j = k + 1; j < cols; j++) s -= m[k * cols + j] * x[j];
			x[k] = s / diag[k];
		}
		return x;
	});
}
/** Inverse of a row-major 3×3 matrix. Throws DegenerateError if it is singular. */
function invert3(m) {
	const [a, b, c, d, e, f, g, h, i] = Array.from(m);
	const A = e * i - f * h;
	const B = -(d * i - f * g);
	const C = d * h - e * g;
	const det = a * A + b * B + c * C;
	const norm = (j) => Math.hypot(m[j], m[3 + j], m[6 + j]);
	if (!(Math.abs(det) > 1e-12 * norm(0) * norm(1) * norm(2))) throw new DegenerateError("The transform is not invertible.");
	return [
		A / det,
		-(b * i - c * h) / det,
		(b * f - c * e) / det,
		B / det,
		(a * i - c * g) / det,
		-(a * f - c * d) / det,
		C / det,
		-(a * h - b * g) / det,
		(a * e - b * d) / det
	];
}
/** Product of two row-major 3×3 matrices. */
function multiply3(p, q) {
	const r = new Array(9);
	for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = p[i * 3] * q[j] + p[i * 3 + 1] * q[3 + j] + p[i * 3 + 2] * q[6 + j];
	return r;
}
//#endregion
export { DegenerateError, invert3, leastSquares, multiply3 };

//# sourceMappingURL=linalg.js.map