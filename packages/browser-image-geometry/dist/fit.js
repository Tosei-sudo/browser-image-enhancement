import { DegenerateError, leastSquares, multiply3 } from "./linalg.js";
import { pointFunction, polynomialTerms } from "./transform.js";
//#region src/fit.ts
/** Estimating a transform from control points by least squares. */
/** Fewest control points each model needs. */
const MIN_POINTS = {
	affine: 3,
	projective: 4,
	polynomial2: 6,
	polynomial3: 10
};
/** Centroid and RMS radius, so fitted coordinates are around unit size. */
function normalization(points) {
	let mx = 0;
	let my = 0;
	for (const [x, y] of points) {
		mx += x;
		my += y;
	}
	mx /= points.length;
	my /= points.length;
	let r = 0;
	for (const [x, y] of points) r += (x - mx) ** 2 + (y - my) ** 2;
	const scale = Math.sqrt(r / points.length) || 1;
	return {
		origin: [mx, my],
		scale
	};
}
function fitAffine(src, dst) {
	const { origin, scale } = normalization(src);
	const n = src.length;
	const a = new Float64Array(n * 3);
	const bx = new Float64Array(n);
	const by = new Float64Array(n);
	src.forEach(([x, y], i) => {
		a.set([
			(x - origin[0]) / scale,
			(y - origin[1]) / scale,
			1
		], i * 3);
		bx[i] = dst[i][0];
		by[i] = dst[i][1];
	});
	const [px, py] = leastSquares(a, n, 3, [bx, by]);
	const lift = (p) => [
		p[0] / scale,
		p[1] / scale,
		p[2] - (p[0] * origin[0] + p[1] * origin[1]) / scale
	];
	return [...lift(px), ...lift(py)];
}
function fitProjective(src, dst) {
	const ns = normalization(src);
	const nd = normalization(dst);
	const n = src.length;
	const a = new Float64Array(2 * n * 8);
	const b = new Float64Array(2 * n);
	for (let i = 0; i < n; i++) {
		const x = (src[i][0] - ns.origin[0]) / ns.scale;
		const y = (src[i][1] - ns.origin[1]) / ns.scale;
		const X = (dst[i][0] - nd.origin[0]) / nd.scale;
		const Y = (dst[i][1] - nd.origin[1]) / nd.scale;
		a.set([
			x,
			y,
			1,
			0,
			0,
			0,
			-X * x,
			-X * y
		], 2 * i * 8);
		a.set([
			0,
			0,
			0,
			x,
			y,
			1,
			-Y * x,
			-Y * y
		], (2 * i + 1) * 8);
		b[2 * i] = X;
		b[2 * i + 1] = Y;
	}
	const [h] = leastSquares(a, 2 * n, 8, [b]);
	let side = 0;
	for (let i = 0; i < n; i++) {
		const w = h[6] * a[2 * i * 8] + h[7] * a[2 * i * 8 + 1] + 1;
		if (!(Math.abs(w) > 1e-6) || side !== 0 && Math.sign(w) !== side) throw new DegenerateError("The control points are degenerate (for example, three of four on one line).");
		side = Math.sign(w);
	}
	if (!h.every((v) => Math.abs(v) < 1e6)) throw new DegenerateError("The control points are degenerate (for example, three of four on one line).");
	const hn = [...h, 1];
	const ts = [
		1 / ns.scale,
		0,
		-ns.origin[0] / ns.scale,
		0,
		1 / ns.scale,
		-ns.origin[1] / ns.scale,
		0,
		0,
		1
	];
	const tdInv = [
		nd.scale,
		0,
		nd.origin[0],
		0,
		nd.scale,
		nd.origin[1],
		0,
		0,
		1
	];
	const m = multiply3(tdInv, multiply3(hn, ts));
	const s = m[8];
	if (!(Math.abs(s) > 0)) throw new DegenerateError("The control points are degenerate.");
	return m.map((v) => v / s);
}
function fitPolynomialMap(order, src, dst) {
	const { origin, scale } = normalization(src);
	const n = src.length;
	const k = order === 2 ? 6 : 10;
	const a = new Float64Array(n * k);
	const row = new Float64Array(k);
	const bx = new Float64Array(n);
	const by = new Float64Array(n);
	src.forEach(([x, y], i) => {
		polynomialTerms(order, (x - origin[0]) / scale, (y - origin[1]) / scale, row);
		a.set(row, i * k);
		bx[i] = dst[i][0];
		by[i] = dst[i][1];
	});
	const [cx, cy] = leastSquares(a, n, k, [bx, by]);
	return {
		origin,
		scale,
		x: Array.from(cx),
		y: Array.from(cy)
	};
}
function checkPoints(points) {
	if (!Array.isArray(points)) throw new TypeError("Expected an array of control points.");
	for (const p of points) if (!(p && [p.pixel, p.world].every((q) => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite)))) throw new TypeError("Each control point needs `pixel: [x, y]` and `world: [x, y]` with finite numbers.");
}
/**
* Estimates the transform that maps each control point's `pixel` onto its `world`
* position, by least squares. With more points than the minimum, `residuals`
* show how well they agree. Throws DegenerateError when the points cannot
* determine the model (too few, or for example all on one line).
*/
function fitTransform(points, options = {}) {
	checkPoints(points);
	const model = options.model ?? "affine";
	const min = MIN_POINTS[model];
	if (min === void 0) throw new TypeError(`Unknown model: ${String(model)}`);
	if (points.length < min) throw new DegenerateError(`The ${model} model needs at least ${min} control points (got ${points.length}).`);
	const yUp = (options.target ?? "map") === "map" ? { yUp: true } : {};
	const src = points.map((p) => p.pixel);
	const dst = points.map((p) => p.world);
	let transform;
	if (model === "affine") transform = {
		type: "affine",
		matrix: fitAffine(src, dst),
		...yUp
	};
	else if (model === "projective") transform = {
		type: "projective",
		matrix: fitProjective(src, dst),
		...yUp
	};
	else {
		const order = model === "polynomial2" ? 2 : 3;
		transform = {
			type: "polynomial",
			order,
			forward: fitPolynomialMap(order, src, dst),
			inverse: fitPolynomialMap(order, dst, src),
			...yUp
		};
	}
	const apply = pointFunction(transform);
	const out = [0, 0];
	let sum = 0;
	const residuals = points.map(({ pixel, world }) => {
		apply(pixel[0], pixel[1], out);
		const dx = out[0] - world[0];
		const dy = out[1] - world[1];
		const distance = Math.hypot(dx, dy);
		sum += distance * distance;
		return {
			dx,
			dy,
			distance
		};
	});
	return {
		transform,
		rms: Math.sqrt(sum / points.length),
		residuals
	};
}
//#endregion
export { MIN_POINTS, fitTransform };

//# sourceMappingURL=fit.js.map