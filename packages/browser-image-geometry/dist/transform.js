import { invert3, multiply3 } from "./linalg.js";
//#region src/transform.ts
/** Creating, applying, inverting and combining transforms. */
function finite(values, count, what) {
	if (!Array.isArray(values) || values.length !== count || !values.every(Number.isFinite)) throw new TypeError(`${what} must be ${count} finite numbers.`);
}
/** An affine transform from `[a, b, c, d, e, f]` (`X = a·x + b·y + c`, `Y = d·x + e·y + f`). */
function affine(matrix, options = {}) {
	finite(matrix, 6, "An affine matrix");
	return {
		type: "affine",
		matrix: [...matrix],
		...options.yUp ? { yUp: true } : {}
	};
}
/** A projective transform (homography) from a row-major 3×3 matrix. */
function projective(matrix, options = {}) {
	finite(matrix, 9, "A projective matrix");
	return {
		type: "projective",
		matrix: [...matrix],
		...options.yUp ? { yUp: true } : {}
	};
}
/** The identity transform. */
function identity() {
	return affine([
		1,
		0,
		0,
		0,
		1,
		0
	]);
}
/** Rotation by `degrees` (clockwise on screen, where y points down) about `center`. */
function rotation(degrees, center = [0, 0]) {
	const r = degrees * Math.PI / 180;
	const quarter = Math.round(degrees / 90);
	const exact = Math.abs(degrees - quarter * 90) < 1e-12;
	const cos = exact ? [
		1,
		0,
		-1,
		0
	][(quarter % 4 + 4) % 4] : Math.cos(r);
	const sin = exact ? [
		0,
		1,
		0,
		-1
	][(quarter % 4 + 4) % 4] : Math.sin(r);
	const [cx, cy] = center;
	return affine([
		cos,
		-sin,
		cx - cos * cx + sin * cy,
		sin,
		cos,
		cy - sin * cx - cos * cy
	]);
}
/** Scaling by `sx`, `sy` about the origin. */
function scaling(sx, sy = sx) {
	return affine([
		sx,
		0,
		0,
		0,
		sy,
		0
	]);
}
/** Translation by `tx`, `ty`. */
function translation(tx, ty) {
	return affine([
		1,
		0,
		tx,
		0,
		1,
		ty
	]);
}
const polyTerms = (order) => order === 2 ? 6 : 10;
/** Fills `out` with the polynomial terms of `(u, v)`. */
function polynomialTerms(order, u, v, out) {
	out[0] = 1;
	out[1] = u;
	out[2] = v;
	out[3] = u * u;
	out[4] = u * v;
	out[5] = v * v;
	if (order === 3) {
		out[6] = u * u * u;
		out[7] = u * u * v;
		out[8] = u * v * v;
		out[9] = v * v * v;
	}
}
function polynomialFunction(order, map) {
	const n = polyTerms(order);
	const [ox, oy] = map.origin;
	const s = map.scale;
	const cx = Float64Array.from(map.x);
	const cy = Float64Array.from(map.y);
	const t = new Float64Array(n);
	return (x, y, out) => {
		polynomialTerms(order, (x - ox) / s, (y - oy) / s, t);
		let X = 0;
		let Y = 0;
		for (let k = 0; k < n; k++) {
			X += cx[k] * t[k];
			Y += cy[k] * t[k];
		}
		out[0] = X;
		out[1] = Y;
	};
}
/** A fast function applying `t` (source → target), writing `[X, Y]` into `out`. */
function pointFunction(t) {
	switch (t.type) {
		case "affine": {
			const [a, b, c, d, e, f] = t.matrix;
			return (x, y, out) => {
				out[0] = a * x + b * y + c;
				out[1] = d * x + e * y + f;
			};
		}
		case "projective": {
			const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = t.matrix;
			return (x, y, out) => {
				const w = h6 * x + h7 * y + h8;
				out[0] = (h0 * x + h1 * y + h2) / w;
				out[1] = (h3 * x + h4 * y + h5) / w;
			};
		}
		case "polynomial": return polynomialFunction(t.order, t.forward);
		default: throw new TypeError(`Unknown transform type: ${String(t.type)}`);
	}
}
/** Applies `t` to one point (source → target). */
function applyTransform(t, point) {
	const out = [0, 0];
	pointFunction(t)(point[0], point[1], out);
	return out;
}
/** The transform from target back to source. */
function invertTransform(t) {
	switch (t.type) {
		case "affine": {
			const [a, b, c, d, e, f] = invert3([
				...t.matrix,
				0,
				0,
				1
			]);
			return {
				...t,
				matrix: [
					a,
					b,
					c,
					d,
					e,
					f
				]
			};
		}
		case "projective": return {
			...t,
			matrix: invert3(t.matrix)
		};
		case "polynomial": return {
			...t,
			forward: t.inverse,
			inverse: t.forward
		};
		default: throw new TypeError(`Unknown transform type: ${String(t.type)}`);
	}
}
/** Affine and projective transforms as 3×3 matrices; null for polynomials. */
function toMatrix3(t) {
	if (t.type === "affine") return [
		...t.matrix,
		0,
		0,
		1
	];
	if (t.type === "projective") return [...t.matrix];
	return null;
}
/**
* `second ∘ first`: apply `first`, then `second`. Both must be affine or projective;
* the result is affine when both are. Keeps `second`'s `yUp`.
*/
function composeTransforms(first, second) {
	const p = toMatrix3(first);
	const q = toMatrix3(second);
	if (!p || !q) throw new TypeError("Polynomial transforms cannot be composed.");
	const m = multiply3(q, p);
	const yUp = second.yUp ? { yUp: true } : {};
	if (first.type === "affine" && second.type === "affine") return {
		type: "affine",
		matrix: m.slice(0, 6),
		...yUp
	};
	const s = m[8] !== 0 ? m[8] : 1;
	return {
		type: "projective",
		matrix: m.map((v) => v / s),
		...yUp
	};
}
/** Throws unless `t` is a well-formed transform. */
function assertTransform(t) {
	if (!t || typeof t !== "object") throw new TypeError("Expected a transform object.");
	if (t.type === "affine") finite(t.matrix, 6, "An affine matrix");
	else if (t.type === "projective") finite(t.matrix, 9, "A projective matrix");
	else if (t.type === "polynomial") {
		if (t.order !== 2 && t.order !== 3) throw new TypeError("Polynomial order must be 2 or 3.");
		for (const map of [t.forward, t.inverse]) {
			if (!map) throw new TypeError("A polynomial transform needs both `forward` and `inverse` (use fitTransform).");
			finite(map.x, polyTerms(t.order), "Polynomial coefficients");
			finite(map.y, polyTerms(t.order), "Polynomial coefficients");
			if (!(map.scale > 0)) throw new TypeError("Polynomial scale must be positive.");
		}
	} else throw new TypeError(`Unknown transform type: ${String(t.type)}`);
}
//#endregion
export { affine, applyTransform, assertTransform, composeTransforms, identity, invertTransform, pointFunction, polynomialTerms, projective, rotation, scaling, toMatrix3, translation };

//# sourceMappingURL=transform.js.map