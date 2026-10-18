// Stand-ins for signing in, for the browser test (auth.spec.ts): an ArcGIS
// portal under /portal/ (OAuth 2.0 authorize with PKCE, token, portals/self,
// its federated servers), a federated server under /fedserver/ whose feature
// layer needs the portal's token, and a COG and tiles under /secure/ that
// need the header of config.json's authRules.
import { createHash, randomBytes } from 'node:crypto';
import { URL, URLSearchParams } from 'node:url';
import { png } from './services.mjs';

const CLIENT_ID = 'viewer-app';
/** Codes given out: code → { challenge, redirect }. */
const codes = new Map();
/** Valid access tokens, and refresh tokens. */
const tokens = new Set();
const refreshTokens = new Set();
/** What was asked, for the test. */
export const authLog = { tokenRequests: [], featureTokens: [], secureHeaders: [] };

const tile = png(256, 256, [200, 40, 160]);
const feature = (id, lon, lat, name) => {
  const x = (lon * 20037508.342789244) / 180;
  const y = Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * 6378137;
  return { attributes: { OBJECTID: id, NAME: name }, geometry: { x, y } };
};
const features = [feature(1, 139.76, 35.68, '本社'), feature(2, 139.7, 35.69, '支社')];
const layer = {
  id: 0,
  name: '拠点',
  type: 'Feature Layer',
  geometryType: 'esriGeometryPoint',
  objectIdField: 'OBJECTID',
  maxRecordCount: 1000,
  capabilities: 'Query',
  extent: { xmin: 15550000, ymin: 4250000, xmax: 15570000, ymax: 4260000, spatialReference: { wkid: 102100, latestWkid: 3857 } },
  fields: [
    { name: 'OBJECTID', type: 'esriFieldTypeOID', alias: 'OBJECTID' },
    { name: 'NAME', type: 'esriFieldTypeString', alias: '名前', length: 50 },
  ],
};

export function resetAuth() {
  codes.clear();
  tokens.clear();
  refreshTokens.clear();
  authLog.tokenRequests.length = 0;
  authLog.featureTokens.length = 0;
  authLog.secureHeaders.length = 0;
}

/** Answers /portal/, /fedserver/ and /secure/ requests; false for others. `files` are the GeoTIFFs by path. */
export async function serveAuth(req, res, url, base, files) {
  const path = url.pathname;
  if (!/^\/(portal|fedserver|secure|auth-test)\//.test(path)) return false;
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'x-api-key, range', 'access-control-expose-headers': 'content-range, content-length', 'cache-control': 'no-store' };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end(), true;
  const json = (body, status = 200) => (res.writeHead(status, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(body)), true);
  let form = url.searchParams;
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    form = new URLSearchParams(body);
  }

  if (path === '/auth-test/reset') return (resetAuth(), json({ ok: true }));
  if (path === '/auth-test/log') return json(authLog);
  // Makes every access token invalid, as when one expires on the server.
  if (path === '/auth-test/expire') return (tokens.clear(), json({ ok: true }));

  if (path === '/portal/sharing/rest/oauth2/authorize') {
    const redirect = url.searchParams.get('redirect_uri') ?? '';
    if (url.searchParams.get('client_id') !== CLIENT_ID || !redirect.startsWith(`${base}/`) || url.searchParams.get('code_challenge_method') !== 'S256') {
      return res.writeHead(400, { 'content-type': 'text/plain' }).end('bad request'), true;
    }
    const code = randomBytes(8).toString('hex');
    codes.set(code, { challenge: url.searchParams.get('code_challenge'), redirect });
    const back = new URL(redirect);
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state') ?? '');
    // A sign-in page would come first; the stand-in signs in at once.
    return res.writeHead(302, { location: back.href }).end(), true;
  }
  if (path === '/portal/sharing/rest/oauth2/token') {
    const grant = form.get('grant_type');
    authLog.tokenRequests.push(grant);
    if (form.get('client_id') !== CLIENT_ID) return json({ error: { code: 400, message: 'Invalid client_id' } });
    if (grant === 'authorization_code') {
      const given = codes.get(form.get('code'));
      codes.delete(form.get('code'));
      const verifier = form.get('code_verifier') ?? '';
      if (!given || given.redirect !== form.get('redirect_uri') || createHash('sha256').update(verifier).digest('base64url') !== given.challenge) {
        return json({ error: { code: 400, message: 'Invalid authorization code' } });
      }
    } else if (grant === 'refresh_token') {
      if (!refreshTokens.has(form.get('refresh_token'))) return json({ error: { code: 498, message: 'Invalid refresh_token' } });
    } else return json({ error: { code: 400, message: 'Unsupported grant_type' } });
    const token = `tok-${randomBytes(6).toString('hex')}`;
    tokens.add(token);
    const refresh = grant === 'authorization_code' ? `ref-${randomBytes(6).toString('hex')}` : form.get('refresh_token');
    refreshTokens.add(refresh);
    return json({ access_token: token, expires_in: 1800, username: 'taro', ...(grant === 'authorization_code' ? { refresh_token: refresh, refresh_token_expires_in: 1209600 } : {}) });
  }
  if (path === '/portal/sharing/rest/oauth2/revokeToken') {
    refreshTokens.delete(form.get('auth_token'));
    return json({ success: true });
  }
  if (path === '/portal/sharing/rest/portals/self') {
    if (!tokens.has(form.get('token'))) return json({ error: { code: 498, message: 'Invalid token' } });
    return json({ id: 'org1', name: 'テスト組織', isPortal: true, user: { username: 'taro', fullName: '山田 太郎' } });
  }
  if (path === '/portal/sharing/rest/portals/self/servers') {
    if (!tokens.has(form.get('token'))) return json({ error: { code: 498, message: 'Invalid token' } });
    return json({ servers: [{ id: 's1', name: 'fed', url: `${base}/fedserver`, adminUrl: `${base}/fedserver`, serverRole: 'FEDERATED_SERVER' }] });
  }

  const esri = /^\/fedserver\/rest\/services\/Sites\/FeatureServer(?:\/(\d+))?(?:\/(query))?$/.exec(path);
  if (esri) {
    const token = form.get('token');
    authLog.featureTokens.push(token ? 'token' : 'none');
    if (!token) return json({ error: { code: 499, message: 'Token Required', details: [] } });
    if (!tokens.has(token)) return json({ error: { code: 498, message: 'Invalid Token', details: [] } });
    const [, id, op] = esri;
    if (id === undefined) return json({ currentVersion: 11.1, layers: [{ id: 0, name: '拠点', type: 'Feature Layer', geometryType: 'esriGeometryPoint' }], tables: [] });
    if (!op) return json(layer);
    if (form.get('returnIdsOnly') === 'true') return json({ objectIdFieldName: 'OBJECTID', objectIds: features.map((f) => f.attributes.OBJECTID) });
    const ids = (form.get('objectIds') ?? '').split(',').map(Number);
    return json({ objectIdFieldName: 'OBJECTID', geometryType: 'esriGeometryPoint', spatialReference: { wkid: 102100, latestWkid: 3857 }, fields: layer.fields, features: features.filter((f) => ids.includes(f.attributes.OBJECTID)) });
  }

  // /secure/…: only with the header authRules adds.
  if (path.startsWith('/secure/')) {
    const key = req.headers['x-api-key'];
    authLog.secureHeaders.push(`${path.startsWith('/secure/tiles/') ? 'tile' : 'cog'}:${key ?? 'none'}`);
    if (key !== 'secret-key') return res.writeHead(403, { ...cors, 'content-type': 'text/plain' }).end('forbidden'), true;
    if (path.startsWith('/secure/tiles/')) return res.writeHead(200, { ...cors, 'content-type': 'image/png' }).end(tile), true;
    const body = files[path.slice('/secure'.length)];
    if (!body) return res.writeHead(404, cors).end('not found'), true;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (!range) return res.writeHead(200, { ...cors, 'content-type': 'image/tiff', 'accept-ranges': 'bytes' }).end(body), true;
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : body.length - 1, body.length - 1);
    return res.writeHead(206, { ...cors, 'content-type': 'image/tiff', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${body.length}` }).end(body.subarray(start, end + 1)), true;
  }
  return res.writeHead(404, cors).end('not found'), true;
}
