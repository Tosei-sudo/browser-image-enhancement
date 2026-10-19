/** The stand-in image catalog of the watch tests (catalog-watch.spec.ts, catalog-watch-sw.spec.ts). */
import type { BrowserContext, Page } from '@playwright/test';

export const layerUrl = 'http://localhost:4175/svc/watch/FeatureServer/0';
export const catalog = {
  label: '監視カタログ',
  url: layerUrl,
  fields: { id: 'IMG_ID', acquired: 'ACQ_TIME', registered: 'REG_TIME', sensor: 'SENSOR', angle: 'OFF_NADIR', source: 'COG_URL' },
};
const ring = (x0: number, y0: number, x1: number, y1: number) => [[[x0, y0], [x0, y1], [x1, y1], [x1, y0], [x0, y0]]];
export const image = (id: string, objectId: number, sensor = 'S1') => ({
  attributes: { OBJECTID: objectId, IMG_ID: id, ACQ_TIME: Date.UTC(2026, 9, objectId), REG_TIME: Date.now(), SENSOR: sensor, OFF_NADIR: 10, COG_URL: 'http://localhost:4175/fixture.tif' },
  geometry: { rings: ring(139.6, 35.6, 139.9, 35.75) },
});

/** Serves the stand-in catalog (page or service worker); returns the `where` of each query. */
export async function serveCatalog(target: Page | BrowserContext, list: ReturnType<typeof image>[]): Promise<string[]> {
  const queries: string[] = [];
  await target.route(`${layerUrl}**`, async (route) => {
    const request = route.request();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (!request.url().includes('/query')) {
      return json({
        fields: [
          { name: 'OBJECTID', type: 'esriFieldTypeOID' },
          { name: 'IMG_ID', type: 'esriFieldTypeString' },
          { name: 'ACQ_TIME', type: 'esriFieldTypeDate' },
          { name: 'REG_TIME', type: 'esriFieldTypeDate' },
          { name: 'SENSOR', type: 'esriFieldTypeString' },
        ],
        advancedQueryCapabilities: { supportsPagination: true, supportsOrderBy: true },
      });
    }
    const form = new URLSearchParams(request.postData() ?? '');
    if (form.get('returnDistinctValues') === 'true') return json({ features: [{ attributes: { SENSOR: 'S1' } }, { attributes: { SENSOR: 'S2' } }] });
    const where = form.get('where') ?? '';
    const sensor = /SENSOR = '([^']*)'/.exec(where)?.[1];
    const found = list.filter((f) => !sensor || f.attributes.SENSOR === sensor);
    if (form.get('returnCountOnly') === 'true') return json({ count: found.length });
    queries.push(where);
    return json({ objectIdFieldName: 'OBJECTID', geometryType: 'esriGeometryPolygon', spatialReference: { wkid: 4326 }, features: found });
  });
  return queries;
}
