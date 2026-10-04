//#region src/openlayers/tiff-metadata.ts
const ITEM = /<Item\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Item\s*>)/g;
const ATTRIBUTE = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** The items of GDAL's metadata XML (`<GDALMetadata><Item name="…" sample="0">…</Item></GDALMetadata>`), in order. */
function parseGdalMetadata(xml) {
	const items = [];
	for (const [, attributes, inner = ""] of xml.matchAll(ITEM)) {
		const attrs = {};
		for (const [, key, d, s] of attributes.matchAll(ATTRIBUTE)) attrs[key.toLowerCase()] = decodeXml(d ?? s ?? "");
		if (attrs.name === void 0) continue;
		const item = {
			name: attrs.name,
			value: decodeXml(inner.trim())
		};
		const sample = Number(attrs.sample);
		if (attrs.sample !== void 0 && Number.isInteger(sample) && sample >= 0) item.sample = sample;
		if (attrs.role) item.role = attrs.role;
		if (attrs.domain) item.domain = attrs.domain;
		items.push(item);
	}
	return items;
}
/** Item names other software uses for a band's name when there is no `DESCRIPTION`. */
const NAME_ITEMS = [
	"BAND_NAME",
	"BANDNAME",
	"NAME"
];
/**
* The name of each of `samples` bands in GDAL's metadata items: the band's
* `DESCRIPTION` (what GDAL's `SetDescription` writes), else a `BAND_NAME`
* item of the band; null for a band without one.
*/
function bandNamesFromGdalMetadata(items, samples) {
	const names = new Array(samples).fill(null);
	const rank = new Array(samples).fill(Infinity);
	for (const item of items) {
		if (item.sample === void 0 || item.sample >= samples || item.domain || !item.value) continue;
		const name = item.name.toUpperCase();
		const r = name === "DESCRIPTION" ? 0 : NAME_ITEMS.indexOf(name) + 1 || Infinity;
		if (r < rank[item.sample]) {
			rank[item.sample] = r;
			names[item.sample] = item.value;
		}
	}
	return names;
}
/**
* The `GDAL_METADATA` XML of a geotiff.js image, or null when it has none.
* Loads the tag when geotiff.js deferred it.
*/
async function readGdalMetadataXml(image) {
	const value = await readTag(image, "GDAL_METADATA");
	return typeof value === "string" ? value.replace(/\0+$/, "") : null;
}
/** The band names of a geotiff.js image (see {@link bandNamesFromGdalMetadata}); null for unnamed bands. */
async function readBandNames(image) {
	const samples = image.getSamplesPerPixel();
	const xml = await readGdalMetadataXml(image).catch(() => null);
	return xml ? bandNamesFromGdalMetadata(parseGdalMetadata(xml), samples) : new Array(samples).fill(null);
}
/**
* A tag of a geotiff.js image by name or number, or undefined. geotiff.js 3
* keeps tags in an `ImageFileDirectory` that loads big ones on demand;
* geotiff.js 2 in a plain object.
*/
async function readTag(image, tag) {
	const dir = image.fileDirectory;
	if (!dir) return void 0;
	if (typeof dir.hasTag === "function") {
		const d = dir;
		return d.hasTag(tag) ? d.loadValue(tag) : void 0;
	}
	return dir[tag];
}
const ENTITIES = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: "\"",
	apos: "'"
};
function decodeXml(text) {
	return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, e) => {
		if (e[0] === "#") {
			const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
		}
		return ENTITIES[e.toLowerCase()] ?? whole;
	});
}
//#endregion
export { bandNamesFromGdalMetadata, parseGdalMetadata, readBandNames, readGdalMetadataXml, readTag };

//# sourceMappingURL=tiff-metadata.js.map