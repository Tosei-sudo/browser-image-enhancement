/**
 * Reading the metadata GDAL writes into a GeoTIFF: the `GDAL_METADATA` tag
 * (an XML list of `<Item>`s, for the dataset or for one band) and the band
 * names in it (`DESCRIPTION`, as `gdal_translate` or QGIS write them, e.g.
 * `NIR`). Works on the images of geotiff.js without importing it.
 */

/** One `<Item>` of GDAL's metadata XML. */
export interface GdalMetadataItem {
  /** The item's name, e.g. `DESCRIPTION`, `STATISTICS_MEAN`, `AREA_OR_POINT`. */
  name: string;
  /** Its text, with XML entities decoded. */
  value: string;
  /** The band (0-based) the item is about; absent for the dataset. */
  sample?: number;
  /** `description`, `offset`, `scale`, `unittype` for the band's own properties; absent for plain metadata. */
  role?: string;
  /** The metadata domain (`IMAGERY`, `RPC`...); absent for the default one. */
  domain?: string;
}

/** The parts of a geotiff.js image read here (geotiff.js 2 and 3). */
export interface TiffImageLike {
  /** The number of bands. */
  getSamplesPerPixel(): number;
  /** The tags: an `ImageFileDirectory` (geotiff.js 3) or a plain object (geotiff.js 2). */
  fileDirectory: unknown;
}

const ITEM = /<Item\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Item\s*>)/g;
const ATTRIBUTE = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** The items of GDAL's metadata XML (`<GDALMetadata><Item name="…" sample="0">…</Item></GDALMetadata>`), in order. */
export function parseGdalMetadata(xml: string): GdalMetadataItem[] {
  const items: GdalMetadataItem[] = [];
  for (const [, attributes, inner = ''] of xml.matchAll(ITEM)) {
    const attrs: Record<string, string> = {};
    for (const [, key, d, s] of attributes.matchAll(ATTRIBUTE)) attrs[key.toLowerCase()] = decodeXml(d ?? s ?? '');
    if (attrs.name === undefined) continue;
    const item: GdalMetadataItem = { name: attrs.name, value: decodeXml(inner.trim()) };
    const sample = Number(attrs.sample);
    if (attrs.sample !== undefined && Number.isInteger(sample) && sample >= 0) item.sample = sample;
    if (attrs.role) item.role = attrs.role;
    if (attrs.domain) item.domain = attrs.domain;
    items.push(item);
  }
  return items;
}

/** Item names other software uses for a band's name when there is no `DESCRIPTION`. */
const NAME_ITEMS = ['BAND_NAME', 'BANDNAME', 'NAME'];

/**
 * The name of each of `samples` bands in GDAL's metadata items: the band's
 * `DESCRIPTION` (what GDAL's `SetDescription` writes), else a `BAND_NAME`
 * item of the band; null for a band without one.
 */
export function bandNamesFromGdalMetadata(items: readonly GdalMetadataItem[], samples: number): Array<string | null> {
  const names: Array<string | null> = new Array(samples).fill(null);
  const rank = new Array(samples).fill(Infinity);
  for (const item of items) {
    if (item.sample === undefined || item.sample >= samples || item.domain || !item.value) continue;
    const name = item.name.toUpperCase();
    const r = name === 'DESCRIPTION' ? 0 : NAME_ITEMS.indexOf(name) + 1 || Infinity;
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
export async function readGdalMetadataXml(image: TiffImageLike): Promise<string | null> {
  const value = await readTag(image, 'GDAL_METADATA');
  return typeof value === 'string' ? value.replace(/\0+$/, '') : null;
}

/** The band names of a geotiff.js image (see {@link bandNamesFromGdalMetadata}); null for unnamed bands. */
export async function readBandNames(image: TiffImageLike): Promise<Array<string | null>> {
  const samples = image.getSamplesPerPixel();
  const xml = await readGdalMetadataXml(image).catch(() => null);
  return xml ? bandNamesFromGdalMetadata(parseGdalMetadata(xml), samples) : new Array(samples).fill(null);
}

interface DirectoryV3 {
  hasTag(tag: string | number): boolean;
  loadValue(tag: string | number): Promise<unknown>;
}

/**
 * A tag of a geotiff.js image by name or number, or undefined. geotiff.js 3
 * keeps tags in an `ImageFileDirectory` that loads big ones on demand;
 * geotiff.js 2 in a plain object.
 */
export async function readTag(image: TiffImageLike, tag: string | number): Promise<unknown> {
  const dir = image.fileDirectory as DirectoryV3 | Record<string | number, unknown> | null;
  if (!dir) return undefined;
  if (typeof (dir as DirectoryV3).hasTag === 'function') {
    const d = dir as DirectoryV3;
    return d.hasTag(tag) ? d.loadValue(tag) : undefined;
  }
  return (dir as Record<string | number, unknown>)[tag];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}
