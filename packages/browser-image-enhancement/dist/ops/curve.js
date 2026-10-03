import { warn } from "../warn.js";
//#region src/ops/curve.ts
/** The straight line from black to white. */
const IDENTITY_CURVE = [[0, 0], [1, 1]];
/**
* Validates curve points: drops points that are not two finite numbers,
* clamps them to [0, 1], sorts by input (keeping the last of equal inputs) and
* adds (0, 0) and (1, 1) when the curve does not reach input 0 or 1.
*/
function normalizeCurve(name, raw) {
	if (raw === void 0) return IDENTITY_CURVE.map((p) => [p[0], p[1]]);
	const list = Array.isArray(raw) ? raw : [];
	if (!Array.isArray(raw)) warn(`${name} must be an array of [input, output] points; using a straight line.`);
	const byX = /* @__PURE__ */ new Map();
	for (const p of list) {
		if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
			warn(`${name}: ${JSON.stringify(p)} is not an [input, output] point; ignored.`);
			continue;
		}
		const clamp = (v) => Math.min(1, Math.max(0, v));
		if (p[0] < 0 || p[0] > 1 || p[1] < 0 || p[1] > 1) warn(`${name}: point ${JSON.stringify(p)} is outside [0, 1]; clamped.`);
		byX.set(clamp(p[0]), clamp(p[1]));
	}
	const points = [...byX].sort((a, b) => a[0] - b[0]);
	if (points.length === 0 || points[0][0] > 0) points.unshift([0, 0]);
	if (points[points.length - 1][0] < 1) points.push([1, 1]);
	return points;
}
/** True when the curve is the straight line (every point on y = x). */
function isIdentityCurve(points) {
	return points.every(([x, y]) => x === y);
}
/** The curve as a function on [0, 1] (inputs outside are clamped). */
function curveFunction(points) {
	if (isIdentityCurve(points)) return (x) => x <= 0 ? 0 : x >= 1 ? 1 : x;
	const n = points.length;
	const xs = points.map((p) => p[0]);
	const ys = points.map((p) => p[1]);
	const d = [];
	for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
	const m = new Array(n);
	m[0] = d[0];
	m[n - 1] = d[n - 2];
	for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
	for (let i = 0; i < n - 1; i++) {
		if (d[i] === 0) {
			m[i] = 0;
			m[i + 1] = 0;
			continue;
		}
		const a = m[i] / d[i];
		const b = m[i + 1] / d[i];
		const h = a * a + b * b;
		if (h > 9) {
			const t = 3 / Math.sqrt(h);
			m[i] = t * a * d[i];
			m[i + 1] = t * b * d[i];
		}
	}
	return (x) => {
		if (!(x > xs[0])) return ys[0];
		if (x >= xs[n - 1]) return ys[n - 1];
		let i = 0;
		while (x > xs[i + 1]) i++;
		const h = xs[i + 1] - xs[i];
		const t = (x - xs[i]) / h;
		const t2 = t * t;
		const t3 = t2 * t;
		const y = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
		return y <= 0 ? 0 : y >= 1 ? 1 : y;
	};
}
//#endregion
export { IDENTITY_CURVE, curveFunction, isIdentityCurve, normalizeCurve };

//# sourceMappingURL=curve.js.map