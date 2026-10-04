/**
 * Reading a service from its URL. With `auto`, an ArcGIS REST URL is an Esri
 * service; otherwise the URL is fetched as given and its capabilities
 * document tells WMS, WMTS and WFS apart, and failing that each service's
 * GetCapabilities is tried in turn.
 */
import { request, ServiceError, type ServiceCatalog, type ServiceKind } from './common.js';
import { isEsriUrl, readEsri } from './esri.js';
import { readWfs } from './wfs.js';
import { readWms } from './wms.js';
import { readWmts } from './wmts.js';

export * from './common.js';

const readers: Record<ServiceKind, (url: string, token?: string) => Promise<ServiceCatalog>> = {
  wms: readWms,
  wmts: readWmts,
  wfs: readWfs,
  esri: readEsri,
};

export async function readService(url: string, kind: ServiceKind | 'auto', token?: string): Promise<ServiceCatalog> {
  if (kind !== 'auto') return readers[kind](url, token);
  if (isEsriUrl(url)) return readEsri(url, token);
  const named = new URL(url, location.href).searchParams;
  const service = [...named].find(([k]) => k.toLowerCase() === 'service')?.[1]?.toLowerCase();
  if (service === 'wms' || service === 'wmts' || service === 'wfs') return readers[service](url);
  if (/WMTSCapabilities\.xml/i.test(url) || /\/wmts\b/i.test(url)) return readWmts(url);

  // What the URL itself returns, when it is a capabilities document already.
  const root = await request(url)
    .then((r) => r.text())
    .then((text) => new DOMParser().parseFromString(text, 'application/xml').documentElement?.localName)
    .catch(() => undefined);
  if (root === 'WMS_Capabilities' || root === 'WMT_MS_Capabilities') return readWms(url);
  if (root === 'Capabilities') return readWmts(url);
  if (root === 'WFS_Capabilities') return readWfs(url);

  for (const read of [readWms, readWmts, readWfs]) {
    try {
      return await read(url);
    } catch {
      // next kind
    }
  }
  throw new ServiceError('WMS・WMTS・WFS・Esri のどれとしても読めませんでした。種類を選んでもう一度試してください');
}
