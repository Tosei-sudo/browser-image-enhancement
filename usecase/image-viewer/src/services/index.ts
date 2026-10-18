/**
 * Reading a service from its URL. With `auto`, an ArcGIS REST URL is an Esri
 * service; otherwise the URL is fetched as given and its capabilities
 * document tells WMS, WMTS and WFS apart, and failing that each service's
 * GetCapabilities is tried in turn. A URL that answers JSON is an OGC API:
 * Features, Tiles or Coverages by what it conforms to and links.
 */
import { request, ServiceError, type ServiceCatalog, type ServiceKind } from './common.js';
import { isEsriUrl, readEsri } from './esri.js';
import { readWfs } from './wfs.js';
import { readWms } from './wms.js';
import { readWmts } from './wmts.js';
import { readOgcFeatures } from './ogc-features.js';
import { readOgcTiles } from './ogc-tiles.js';
import { readOgcCoverage } from './ogc-coverage.js';
import { readWcs } from './wcs.js';
import { conformance, conformsTo, readOgcService } from './ogc-api.js';
import { isXyzUrl, readXyz } from './xyz.js';

export * from './common.js';

const readers: Record<ServiceKind, (url: string, token?: string) => Promise<ServiceCatalog>> = {
  wms: readWms,
  wmts: readWmts,
  wfs: readWfs,
  esri: readEsri,
  'ogc-features': readOgcFeatures,
  'ogc-tiles': readOgcTiles,
  wcs: readWcs,
  'ogc-coverage': readOgcCoverage,
  xyz: readXyz,
};

export async function readService(url: string, kind: ServiceKind | 'auto', token?: string): Promise<ServiceCatalog> {
  if (kind !== 'auto') return readers[kind](url, token);
  if (isEsriUrl(url)) return readEsri(url, token);
  if (isXyzUrl(url)) return readXyz(url);
  const named = new URL(url, location.href).searchParams;
  const service = [...named].find(([k]) => k.toLowerCase() === 'service')?.[1]?.toLowerCase();
  if (service === 'wms' || service === 'wmts' || service === 'wfs' || service === 'wcs') return readers[service](url);
  if (/WMTSCapabilities\.xml/i.test(url) || /\/wmts\b/i.test(url)) return readWmts(url);

  // What the URL itself returns, when it is a capabilities document already (or JSON: an OGC API).
  const text = await request(url, { headers: { Accept: 'application/json, application/xml;q=0.9, */*;q=0.5' } })
    .then((r) => r.text())
    .catch(() => '');
  if (/^\s*[{[]/.test(text)) return readOgcApi(url);
  const element = /^\s*</.test(text) ? new DOMParser().parseFromString(text, 'application/xml').documentElement : null;
  const root = element?.localName;
  if (root === 'WMS_Capabilities' || root === 'WMT_MS_Capabilities') return readWms(url);
  if (root === 'Capabilities' && /\/wcs\//.test(element?.namespaceURI ?? '')) return readWcs(url);
  if (root === 'Capabilities') return readWmts(url);
  if (root === 'WFS_Capabilities') return readWfs(url);
  if (/\/collections(\/|$)/.test(new URL(url, location.href).pathname)) return readOgcApi(url);

  for (const read of [readWms, readWmts, readWfs, readWcs, readOgcApi]) {
    try {
      return await read(url);
    } catch {
      // next kind
    }
  }
  throw new ServiceError('WMS・WMTS・WFS・WCS・OGC API・Esri のどれとしても読めませんでした。種類を選んでもう一度試してください');
}

/** An OGC API: Features when it has feature collections, else Tiles, else Coverages (choose the kind to read another). */
async function readOgcApi(url: string): Promise<ServiceCatalog> {
  const service = await readOgcService(url);
  const has = (rel: RegExp) => service.collections.some((c) => c.links.some((l) => rel.test(l.rel))) || service.links.some((l) => rel.test(l.rel));
  if (conformsTo(service.classes, conformance.featuresCore) || service.collections.some((c) => c.itemType === 'feature' || c.links.some((l) => l.rel === 'items'))) return readOgcFeatures(url);
  if (has(/tilesets-(vector|map)\]?$/)) return readOgcTiles(url);
  if (has(/(^|\/|:)coverage\]?$/) || conformsTo(service.classes, conformance.coverages)) return readOgcCoverage(url);
  throw new ServiceError('OGC API ですが、地物・タイル・カバレッジのどれもありません');
}
