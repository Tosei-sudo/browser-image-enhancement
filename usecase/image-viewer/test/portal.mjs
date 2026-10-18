// A stand-in ArcGIS portal for the web map tests (webmap.spec.ts), under
// /svc/portal/: a public web map item and a secured one (token `secret`),
// their data, the signed-in user, a folder, and addItem / update, which keep
// what is saved (read back from /svc/portal/saved).

export const WEBMAP_ID = '0123456789abcdef0123456789abcdef';
export const SECURE_ID = 'fedcba9876543210fedcba9876543210';
const FOLDER = { id: 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0', title: '地図' };

/** What was saved: addItem and update requests, with their fields. */
const saved = [];
let nextItem = 1;

const webmap = (base) => ({
  version: '2.28',
  spatialReference: { wkid: 102100, latestWkid: 3857 },
  operationalLayers: [
    {
      id: 'parks',
      title: 'Web マップの公園',
      layerType: 'ArcGISFeatureLayer',
      url: `${base}/svc/arcgis/rest/services/Test/FeatureServer/0`,
      visibility: true,
      opacity: 0.8,
      layerDefinition: {
        definitionExpression: 'KIND = 1',
        drawingInfo: {
          renderer: { type: 'simple', symbol: { type: 'esriSMS', style: 'esriSMSDiamond', color: [200, 0, 200, 255], size: 12, outline: { color: [255, 255, 255, 255], width: 1 } } },
          labelingInfo: [{ labelExpressionInfo: { expression: '$feature.NAME' } }],
        },
      },
    },
    {
      title: 'メモ',
      featureCollection: {
        layers: [
          {
            layerDefinition: {
              name: 'メモ',
              geometryType: 'esriGeometryPoint',
              fields: [
                { name: 'OBJECTID', type: 'esriFieldTypeOID' },
                { name: 'TEXT', type: 'esriFieldTypeString', alias: '内容' },
              ],
              drawingInfo: { renderer: { type: 'simple', symbol: { type: 'esriSMS', style: 'esriSMSCircle', color: [255, 140, 0, 255], size: 10 } } },
            },
            featureSet: {
              geometryType: 'esriGeometryPoint',
              spatialReference: { wkid: 4326 },
              features: [{ geometry: { x: 139.7671, y: 35.6812 }, attributes: { OBJECTID: 1, TEXT: '東京駅' } }],
            },
          },
        ],
      },
    },
    { title: 'KML の層', layerType: 'KML', url: `${base}/a.kml` },
  ],
  baseMap: { title: 'テストの背景', baseMapLayers: [{ id: 'tiles', title: 'テストのタイル', layerType: 'WebTiledLayer', templateUrl: `${base}/svc/wmts/tile/{level}/{row}/{col}` }] },
  initialState: { viewpoint: { targetGeometry: { xmin: 15550000, ymin: 4250000, xmax: 15565000, ymax: 4265000, spatialReference: { wkid: 102100 } } } },
  bookmarks: [{ name: '皇居の周り', extent: { xmin: 15556000, ymin: 4256000, xmax: 15560000, ymax: 4260000, spatialReference: { wkid: 102100 } } }],
});

/** Answers a request of the stand-in portal; `form` holds the query or the POST body. */
export function servePortal(path, form, json, base) {
  const rest = path.slice('/svc/portal'.length);
  const token = form.get('token');
  const denied = () => json({ error: { code: 498, message: 'Invalid token', details: [] } });
  if (rest === '/saved') return json(saved);
  if (rest === '/reset') {
    saved.length = 0;
    return json({ ok: true });
  }
  const item = /^\/sharing\/rest\/content\/items\/([0-9a-f]{32})(\/data)?$/.exec(rest);
  if (item) {
    const [, id, data] = item;
    if (id === SECURE_ID && token !== 'secret') return json({ error: { code: 403, message: 'You do not have permissions to access this resource or perform this operation.', details: [] } });
    if (id !== WEBMAP_ID && id !== SECURE_ID) return json({ error: { code: 400, message: 'Item does not exist or is inaccessible.', details: [] } });
    if (data) return json(webmap(base));
    return json({ id, owner: 'tester', title: id === SECURE_ID ? '非公開の地図' : '東京の公園', type: 'Web Map', extent: [[139.6, 35.6], [139.9, 35.75]] });
  }
  if (rest === '/sharing/rest/community/self') return token === 'secret' ? json({ username: 'tester', fullName: 'テスト' }) : denied();
  const user = /^\/sharing\/rest\/content\/users\/([^/]+)(?:\/([0-9a-f]{32}))?(?:\/(addItem|items\/([0-9a-f]{32})\/update))?$/.exec(rest);
  if (user) {
    if (token !== 'secret' || user[1] !== 'tester') return denied();
    const [, , folder, op, updated] = user;
    if (!op) return json({ username: 'tester', folders: [FOLDER], items: [] });
    if (folder && folder !== FOLDER.id) return json({ error: { code: 400, message: 'Folder not found' } });
    const fields = Object.fromEntries([...form].filter(([k]) => k !== 'token'));
    if (op === 'addItem') {
      const id = String(nextItem++).padStart(32, 'a');
      saved.push({ op: 'addItem', id, folder: folder ?? null, ...fields });
      return json({ success: true, id, folder: folder ?? '' });
    }
    saved.push({ op: 'update', id: updated, ...fields });
    return json({ success: true, id: updated });
  }
  return json({ error: { code: 400, message: 'Not found' } });
}
