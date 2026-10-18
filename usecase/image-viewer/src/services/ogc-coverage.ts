/**
 * OGC API – Coverages: the coverages of a landing page's collections (or the
 * one a URL names), read as a GeoTIFF of the area asked for
 * (`coverage?bbox=…&f=geotiff`, the box in CRS84) and opened like a local
 * GeoTIFF. When the collection gives its grid, an area over the caps is
 * refused before anything is read.
 */
import type { Extent } from 'ol/extent.js';
import { getIntersection } from 'ol/extent.js';
import { ServiceError, type LayerChoice, type OpenContext, type OpenPick, type ServiceCatalog } from './common.js';
import { areaInDegrees, fetchGeoTiff, fitScale, withFileName } from './coverage.js';
import { conformance, conformsTo, findLink, ogcUrl, readOgcService, type OgcCollection, type OgcService } from './ogc-api.js';

const COVERAGE_RELS = ['coverage', 'http://www.opengis.net/def/rel/ogc/1.0/coverage'];

/** Reads the coverages at `url` (a landing page or a collection). */
export async function readOgcCoverage(url: string): Promise<ServiceCatalog> {
  const service = await readOgcService(url);
  const linked = service.collections.filter((c) => findLink(c.links, COVERAGE_RELS));
  // A server that conforms to Coverages but links no coverage: every collection that is not features.
  const collections = linked.length ? linked : conformsTo(service.classes, conformance.coverages) ? service.collections.filter((c) => c.itemType !== 'feature') : [];
  if (collections.length === 0) throw new ServiceError('カバレッジのコレクションがありません');
  const choices: LayerChoice[] = collections.map((c) => ({ name: c.id, title: c.title, abstract: c.description, area: 'raster' }));
  return {
    kind: 'ogc-coverage',
    url,
    title: service.title,
    choices,
    open: async (choice, context, pick = {}) => {
      await openCoverage(service, collections.find((c) => c.id === choice.name)!, context, pick);
      return null;
    },
  };
}

/** The coverage request of a collection for `bbox` (degrees; all of it when null). */
export function coverageUrl(service: Pick<OgcService, 'landing' | 'query'>, collection: OgcCollection, bbox: Extent | null): string {
  const link = findLink(collection.links, COVERAGE_RELS, [/geotiff/, /tiff/]);
  const u = new URL(link?.href ?? ogcUrl(service.landing, `/collections/${encodeURIComponent(collection.id)}/coverage`, service.query));
  for (const key of [...u.searchParams.keys()]) if (/^(f|bbox|bbox-crs)$/i.test(key)) u.searchParams.delete(key);
  if (bbox) u.searchParams.set('bbox', bbox.map((n) => +n.toFixed(8)).join(','));
  u.searchParams.set('f', 'geotiff');
  return u.href;
}

/** Cells of `bbox` (degrees) by the collection's grid, when it gives sizes in degrees; null when unknown. */
export function cellsOf(collection: OgcCollection, bbox: Extent | null): [number, number] | null {
  const [gx, gy] = collection.grid ?? [];
  const box = collection.bbox;
  if (!gx || !gy || !box) return null;
  const area = bbox ? getIntersection(box, bbox) : box;
  const along = (g: { cellsCount?: number; resolution?: number }, span: number, whole: number) =>
    g.resolution ? span / g.resolution : g.cellsCount && whole > 0 ? (g.cellsCount * span) / whole : null;
  const w = along(gx, area[2] - area[0], box[2] - box[0]);
  const h = along(gy, area[3] - area[1], box[3] - box[1]);
  return w && h ? [Math.ceil(w), Math.ceil(h)] : null;
}

async function openCoverage(service: OgcService, collection: OgcCollection, context: OpenContext, pick: OpenPick): Promise<void> {
  if (!context.openRaster) throw new ServiceError('画像として開けません');
  const bbox = areaInDegrees(context, pick);
  if (bbox && collection.bbox) {
    const overlap = getIntersection(collection.bbox, bbox);
    if (!(overlap[2] > overlap[0] && overlap[3] > overlap[1])) throw new ServiceError('範囲がカバレッジと重なりません');
  }
  const cells = cellsOf(collection, bbox);
  if (cells && fitScale(cells[0], cells[1]) < 1) throw new ServiceError(`範囲が大きすぎます（${cells[0].toLocaleString()} × ${cells[1].toLocaleString()} 画素）。表示範囲を狭めてください`);
  const url = coverageUrl(service, collection, bbox);
  context.say(`${collection.title} の画素値を読み込んでいます…`);
  const file = await fetchGeoTiff(url, collection.id, { headers: { Accept: 'image/tiff; application=geotiff, image/tiff;q=0.9' } });
  await context.openRaster(file, withFileName(url, file.name));
}
