import { forward, toPoint } from "mgrs";
//#region src/utm.ts
/**
* UTM on WGS 84 without proj4: the transverse Mercator projection in
* Krüger's series to sixth order in n (Karney 2011), accurate to well under a
* millimetre within a zone and its neighbours.
*/
const a = 6378137;
const f = 1 / 298.257223563;
const k0 = .9996;
const e = Math.sqrt(f * 1.9966471893352524);
const n = f / 1.9966471893352524;
const n4 = n * n * n * n;
const n5 = n4 * n;
const n6 = n5 * n;
/** Radius of the rectifying sphere, times the scale on the central meridian. */
const kA = k0 * a / 1.0016792203863838 * 1.000000704945401;
const alpha = [
	.0008377318206244698,
	7.608527773802082e-7 - 1983433 / 1935360 * n6,
	1.1976455033294527e-9,
	24291706072013587e-28,
	34729 / 80640 * n5 - 3418889 / 1995840 * n6,
	212378941 / 319334400 * n6
];
const beta = [
	.0008377321640579488,
	5.9058701528681994e-8 - 1118711 / 3870720 * n6,
	16734826652839968e-26,
	4397 / 161280 * n4 - 11 / 504 * n5 - 830251 / 7257600 * n6,
	4583 / 161280 * n5 - 108847 / 3991680 * n6,
	20648693 / 638668800 * n6
];
const RAD = Math.PI / 180;
function centralMeridian(zone) {
	return (zone * 6 - 183) * RAD;
}
/** Conformal latitude's tangent from the geodetic latitude's tangent. */
function conformalTan(tau) {
	const sigma = Math.sinh(e * Math.atanh(e * tau / Math.hypot(1, tau)));
	return tau * Math.hypot(1, sigma) - sigma * Math.hypot(1, tau);
}
/** `[lon, lat]` in degrees → `[easting, northing]` in metres in the given zone. */
function toUtm([lon, lat], zone, north) {
	const lambda = lon * RAD - centralMeridian(zone);
	const tauP = conformalTan(Math.tan(lat * RAD));
	const cosL = Math.cos(lambda);
	const xiP = Math.atan2(tauP, cosL);
	const etaP = Math.asinh(Math.sin(lambda) / Math.hypot(tauP, cosL));
	let xi = xiP;
	let eta = etaP;
	for (let j = 1; j <= 6; j++) {
		xi += alpha[j - 1] * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
		eta += alpha[j - 1] * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
	}
	return [5e5 + kA * eta, kA * xi + (north ? 0 : 1e7)];
}
/** `[easting, northing]` in metres in the given zone → `[lon, lat]` in degrees. */
function fromUtm([easting, northing], zone, north) {
	const xi = (northing - (north ? 0 : 1e7)) / kA;
	const eta = (easting - 5e5) / kA;
	let xiP = xi;
	let etaP = eta;
	for (let j = 1; j <= 6; j++) {
		xiP -= beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
		etaP -= beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
	}
	const sinhEta = Math.sinh(etaP);
	const cosXi = Math.cos(xiP);
	const tauP = Math.sin(xiP) / Math.hypot(sinhEta, cosXi);
	const e2 = e * e;
	let tau = tauP;
	for (let i = 0; i < 10; i++) {
		const tauI = conformalTan(tau);
		const delta = (tauP - tauI) / Math.hypot(1, tauI) * ((1 + (1 - e2) * tau * tau) / ((1 - e2) * Math.hypot(1, tau)));
		tau += delta;
		if (Math.abs(delta) < 1e-12) break;
	}
	return [(Math.atan2(sinhEta, cosXi) + centralMeridian(zone)) / RAD, Math.atan(tau) / RAD];
}
//#endregion
//#region src/index.ts
/**
* Coordinate notations: latitude / longitude (decimal or degrees, minutes,
* seconds), MGRS and UTM, written and read. Everything goes through WGS 84
* longitude / latitude (`[lon, lat]`).
*
* UTM is written `54N 386543 3950123`: the zone, then N or S for the
* hemisphere (as in "WGS 84 / UTM zone 54N"), easting and northing in metres.
*/
/** `35.681240, 139.767100` (latitude first). */
function formatLatLon([lon, lat]) {
	return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}
/** `54S UE 88433 49290` (1 m precision); null outside the MGRS area (the poles). */
function formatMgrs(lonLat) {
	try {
		const m = /^(\d{1,2}[A-Z])([A-Z]{2})(\d{5})(\d{5})$/.exec(forward(lonLat, 5));
		return m ? `${m[1]} ${m[2]} ${m[3]} ${m[4]}` : null;
	} catch {
		return null;
	}
}
/** The UTM zone of a point, with the Norway and Svalbard exceptions (as MGRS uses). */
function utmZone(lonLat) {
	try {
		return Number(/^\d{1,2}/.exec(forward(lonLat, 1))[0]);
	} catch {
		return null;
	}
}
/** The EPSG code of a UTM zone on WGS 84. */
function utmEpsg(zone, north) {
	return `EPSG:${(north ? 32600 : 32700) + zone}`;
}
/** `54N 386543 3950123`; null outside UTM (beyond 84°N / 80°S). */
function formatUtm(lonLat) {
	const zone = utmZone(lonLat);
	if (zone === null) return null;
	const north = lonLat[1] >= 0;
	const [e, n] = toUtm(lonLat, zone, north);
	return `${zone}${north ? "N" : "S"} ${Math.round(e)} ${Math.round(n)}`;
}
/**
* Reads a coordinate typed in any of the supported notations:
* - latitude, longitude, in decimal degrees or degrees, minutes and seconds:
*   `35.6812, 139.7671`, `N35.6812 E139.7671`, `139.7671E 35.6812N`,
*   `35°40'52.3"N 139°46'1.6"E`, `35 40 52.3 139 46 1.6`, `35d40m52s N`,
*   `北緯35度40分52秒 東経139度46分1秒`, packed `354052N 1394601E`,
*   `lat 35.68 lon 139.76`, `POINT(139.76 35.68)` (WKT, longitude first),
*   full-width digits and Japanese punctuation. Without N/S/E/W or a label,
*   latitude comes first, unless only the first value can be a longitude
*   (`139.76, 35.68`);
* - MGRS: `54SUE8843349290`, `54S UE 88433 49290` (any even number of digits);
* - UTM: `54N 386543 3950123` (zone, N or S, easting, northing; `E`/`N` or `m` after the numbers are allowed).
* Returns `[lon, lat]`, or null when the text is none of them.
*/
function parseCoordinate(text) {
	const t = normalize(text);
	if (!t) return null;
	return parseMgrs(t) ?? parseUtm(t) ?? parseWkt(t) ?? parseLatLon(t);
}
/** Full-width characters, Japanese words and marks, labels and odd minus signs to one plain form. */
function normalize(text) {
	return text.normalize("NFKC").replace(/[\u2010-\u2015\u2212\uFE63\uFF0D]/g, "-").replace(/[、，;；|\t]/g, ",").replace(/緯度\s*[:=]?\s*/g, " N ").replace(/経度\s*[:=]?\s*/g, " E ").replace(/北緯/g, " N ").replace(/南緯/g, " S ").replace(/東経/g, " E ").replace(/西経/g, " W ").replace(/度/g, "°").replace(/分/g, "'").replace(/秒/g, "\"").toUpperCase().replace(/(?:LATITUDE|LAT)\s*[:=]?\s*/g, " N ").replace(/(?:LONGITUDE|LONG|LNG|LON)\s*[:=]?\s*/g, " E ").replace(/[()[\]{}]/g, " ").replace(/\s+/g, " ").trim();
}
/** WKT `POINT(lon lat)`. */
function parseWkt(t) {
	const m = /^POINT ?Z? ?(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)(?: -?\d+(?:\.\d+)?)?$/.exec(t);
	return m ? valid([Number(m[1]), Number(m[2])]) : null;
}
function parseMgrs(t) {
	const compact = t.replace(/ /g, "");
	const m = /^(\d{1,2})([C-HJ-NP-X])([A-HJ-NP-Z]{2})(\d*)$/.exec(compact);
	if (!m || m[4].length % 2 !== 0 || m[4].length > 10 || Number(m[1]) < 1 || Number(m[1]) > 60) return null;
	try {
		const [lon, lat] = toPoint(compact);
		return valid([lon, lat]);
	} catch {
		return null;
	}
}
function parseUtm(t) {
	const m = /^(\d{1,2}) ?([NS])[ ,]+(\d+(?:\.\d+)?) ?(?:M ?)?E?[ ,]+(\d+(?:\.\d+)?) ?(?:M ?)?N?$/.exec(t);
	if (!m) return null;
	const zone = Number(m[1]);
	const easting = Number(m[3]);
	const northing = Number(m[4]);
	if (zone < 1 || zone > 60 || easting < 1e5 || easting > 9e5 || northing > 1e7) return null;
	const [lon, lat] = fromUtm([easting, northing], zone, m[2] === "N");
	return valid([lon, lat]);
}
function parseLatLon(t) {
	const s = t.replace(/(\d) ?M ?(\d+(?:\.\d+)?) ?S(?![\d.])/g, "$1 $2 ").replace(/(\d) ?D ?(?=[\d ]|$)/g, "$1 ").replace(/(\d) ?M(?=[ \d]|$)/g, "$1 ").replace(/[°º˚'’′‘`"”″“]/g, " ").replace(/ ?, ?/g, ",").replace(/\s+/g, " ").trim();
	let halves;
	if (s.includes(",")) halves = s.split(",").filter((h) => h.trim());
	else {
		const numbers = s.match(/[-+]?\d+(?:\.\d+)?/g) ?? [];
		if (/[NSEW]/.test(s)) halves = splitByLetters(s);
		else if (numbers.length === 2 || numbers.length === 4 || numbers.length === 6) {
			const k = numbers.length / 2;
			halves = [numbers.slice(0, k).join(" "), numbers.slice(k).join(" ")];
		} else return null;
	}
	if (halves.length !== 2) return null;
	const parts = halves.map(readAngle);
	if (parts.some((p) => p === null)) return null;
	const [a, b] = parts;
	let lat;
	let lon;
	if (a.axis === "lon" || b.axis === "lat") [lon, lat] = [a.value, b.value];
	else if (!a.axis && !b.axis && Math.abs(a.value) > 90 && Math.abs(b.value) <= 90) [lon, lat] = [a.value, b.value];
	else [lat, lon] = [a.value, b.value];
	return valid([lon, lat]);
}
/** `N35 40 52 E139 46 1` or `35 40 52 N 139 46 1 E` → the two halves. */
function splitByLetters(s) {
	const letters = [...s.matchAll(/[NSEW]/g)];
	if (letters.length !== 2) return [];
	const first = letters[0].index;
	const cut = !/\d/.test(s.slice(0, first)) ? letters[1].index : first + 1;
	return [s.slice(0, cut), s.slice(cut)];
}
function readAngle(half) {
	const letter = /[NSEW]/.exec(half)?.[0] ?? null;
	const rest = half.replace(/[NSEW]/g, " ").trim();
	if (!/^[-+]?\d+(?:\.\d+)?(?: \d+(?:\.\d+)?){0,2}$/.test(rest)) return null;
	const [d, m = 0, sec = 0] = rest.includes(" ") ? rest.split(" ").map(Number) : unpack(rest);
	if (m >= 60 || sec >= 60) return null;
	let value = Math.abs(d) + m / 60 + sec / 3600;
	if (d < 0 || rest.startsWith("-") || letter === "S" || letter === "W") value = -value;
	return {
		value,
		axis: letter === "N" || letter === "S" ? "lat" : letter === "E" || letter === "W" ? "lon" : null
	};
}
/**
* One number: decimal degrees, or degrees, minutes and seconds written
* together (`354052.3` = 35° 40′ 52.3″, `1394601`, `3540` = 35° 40′) when it
* is too large to be degrees.
*/
function unpack(text) {
	const value = Number(text);
	const digits = /^[-+]?(\d+)/.exec(text)[1];
	if (Math.abs(value) <= 180 || digits.length < 4 || digits.length > 7) return [value];
	const sign = text.startsWith("-") ? -1 : 1;
	const fraction = text.slice(text.indexOf(digits) + digits.length);
	if (digits.length <= 5) return [sign * Number(digits.slice(0, -2)), Number(digits.slice(-2) + fraction)];
	return [
		sign * Number(digits.slice(0, -4)),
		Number(digits.slice(-4, -2)),
		Number(digits.slice(-2) + fraction)
	];
}
function valid([lon, lat]) {
	return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lon, lat] : null;
}
//#endregion
export { formatLatLon, formatMgrs, formatUtm, parseCoordinate, utmEpsg, utmZone };

//# sourceMappingURL=index.js.map