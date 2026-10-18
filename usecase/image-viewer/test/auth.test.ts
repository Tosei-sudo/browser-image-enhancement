import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  arcgisPortalOf,
  authFetch,
  authorize,
  authorizeUrl,
  authRuleOf,
  base64url,
  configureAuth,
  currentUser,
  pkceChallenge,
  randomString,
  requestToken,
  ruleFor,
  scopesOf,
  sessionCovers,
  signOut,
  tokenFor,
  type AuthRule,
} from '../src/auth.js';
import { parseConfig } from '../src/config.js';

describe('PKCE', () => {
  it('gives the S256 challenge: base64url of the SHA-256 of the verifier', async () => {
    const verifier = randomString(48);
    expect(await pkceChallenge(verifier)).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(await pkceChallenge('abc')).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  });

  it('makes base64url random strings', () => {
    expect(base64url(new Uint8Array([251, 255, 191]))).toBe('-_-_');
    const a = randomString(48);
    expect(a).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(randomString(48)).not.toBe(a);
  });

  it('builds the authorize URL', () => {
    const url = new URL(authorizeUrl({ label: 'AGOL', url: 'https://www.arcgis.com', clientId: 'abc' }, { challenge: 'C', state: 'S', redirect: 'https://viewer.example.com/oauth-callback.html' }));
    expect(url.origin + url.pathname).toBe('https://www.arcgis.com/sharing/rest/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: 'abc', response_type: 'code', redirect_uri: 'https://viewer.example.com/oauth-callback.html', code_challenge: 'C', code_challenge_method: 'S256', state: 'S' });
  });
});

describe('config', () => {
  it('reads portals: https only, the root without /sharing', () => {
    const problems: string[] = [];
    expect(arcgisPortalOf({ label: '社内', url: 'https://gis.example.com/portal/sharing/rest/', clientId: 'Abc123' }, problems, 0)).toEqual({ label: '社内', url: 'https://gis.example.com/portal', clientId: 'Abc123' });
    expect(arcgisPortalOf({ url: 'http://localhost:4175/portal', clientId: 'x' }, problems, 1)?.label).toBe('localhost:4175');
    expect(problems).toEqual([]);
    expect(arcgisPortalOf({ url: 'http://gis.example.com/portal', clientId: 'x' }, problems, 2)).toBeNull();
    expect(arcgisPortalOf({ url: 'https://gis.example.com/portal' }, problems, 3)).toBeNull();
    expect(arcgisPortalOf({ url: 'https://gis.example.com/portal', clientId: 'a b' }, problems, 4)).toBeNull();
    expect(arcgisPortalOf({ url: 'https://user:pw@gis.example.com/', clientId: 'x' }, problems, 5)).toBeNull();
    expect(problems).toHaveLength(4);
  });

  it('reads rules, leaving out unsafe headers and loose prefixes', () => {
    const problems: string[] = [];
    expect(authRuleOf({ prefix: 'https://bucket.s3.example.com/cogs/', headers: { 'x-api-key': 'k', Cookie: 'c', 'bad name': 'v' }, query: { sig: 's' } }, problems, 0)).toEqual({
      prefix: 'https://bucket.s3.example.com/cogs/',
      headers: { 'x-api-key': 'k' },
      query: { sig: 's' },
    });
    expect(problems).toHaveLength(2);
    expect(authRuleOf({ prefix: 'https://bucket.s3.example.com', headers: { a: 'b' } }, problems, 1)).toBeNull();
    expect(authRuleOf({ prefix: 'http://tiles.example.com/', headers: { a: 'b' } }, problems, 2)).toBeNull();
    expect(authRuleOf({ prefix: 'https://tiles.example.com/' }, problems, 3)).toBeNull();
    expect(authRuleOf({ prefix: 'https://tiles.example.com/', headers: { a: 'line\r\nbreak' } }, problems, 4)).toBeNull();
    expect(authRuleOf({ prefix: 'http://localhost:4175/secure/', headers: { a: 'b' } }, problems, 5)).not.toBeNull();
  });

  it('parseConfig takes arcgisPortals and authRules', () => {
    const { config, problems } = parseConfig({
      arcgisPortals: [{ url: 'https://www.arcgis.com', clientId: 'id1' }, { url: 'https://www.arcgis.com/', clientId: 'id2' }, 'bad'],
      authRules: [{ prefix: 'https://tiles.example.com/', query: { key: 'k' } }, { prefix: 'ftp://x/' }],
    });
    expect(config.arcgisPortals).toEqual([{ label: 'www.arcgis.com', url: 'https://www.arcgis.com', clientId: 'id1' }]);
    expect(config.authRules).toEqual([{ prefix: 'https://tiles.example.com/', headers: {}, query: { key: 'k' } }]);
    expect(problems).toHaveLength(3);
    expect(parseConfig({ arcgisPortals: {}, authRules: 1 }).problems).toHaveLength(2);
  });
});

describe('rules', () => {
  const rules: AuthRule[] = [
    { prefix: 'https://bucket.example.com/', headers: { 'x-key': 'outer' }, query: {} },
    { prefix: 'https://bucket.example.com/private/', headers: { 'x-key': 'inner' }, query: { sig: 'a b' } },
  ];
  beforeEach(() => configureAuth({ portals: [], rules }));

  it('match by exact prefix, the longest winning', () => {
    expect(ruleFor('https://bucket.example.com/private/a.tif', rules)?.headers['x-key']).toBe('inner');
    expect(ruleFor('https://bucket.example.com/a.tif', rules)?.headers['x-key']).toBe('outer');
    expect(ruleFor('https://bucket.example.com.evil.net/a.tif', rules)).toBeUndefined();
    expect(ruleFor('http://bucket.example.com/a.tif', rules)).toBeUndefined();
  });

  it('authorize adds query parameters and headers to matching URLs only', () => {
    expect(authorize('https://bucket.example.com/private/{z}/{x}/{y}.png?x=1')).toEqual({ url: 'https://bucket.example.com/private/{z}/{x}/{y}.png?x=1&sig=a%20b', headers: { 'x-key': 'inner' } });
    expect(authorize('https://bucket.example.com/private/a.tif?SIG=given').url).toBe('https://bucket.example.com/private/a.tif?SIG=given');
    expect(authorize('https://other.example.com/a.tif')).toEqual({ url: 'https://other.example.com/a.tif', headers: {} });
  });

  it('authFetch sends the headers, the caller\'s winning', async () => {
    const fetch = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetch);
    await authFetch('https://bucket.example.com/a.tif', { headers: { range: 'bytes=0-1' } });
    const headers = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Headers;
    expect(headers.get('x-key')).toBe('outer');
    expect(headers.get('range')).toBe('bytes=0-1');
    await authFetch('https://other.example.com/a');
    expect(fetch.mock.calls[1]).toEqual(['https://other.example.com/a', {}]);
    vi.unstubAllGlobals();
  });
});

describe('sessions', () => {
  const portal = { label: '社内', url: 'https://gis.example.com/portal', clientId: 'app' };
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
  });
  afterEach(() => {
    signOut();
    vi.unstubAllGlobals();
  });
  const stored = (extra: Record<string, unknown> = {}) =>
    store.set('image-viewer.arcgis-sessions', JSON.stringify([{ portal: portal.url, clientId: 'app', token: 'T1', expires: Date.now() + 3_600_000, username: 'taro', scopes: ['https://gis.example.com/portal/', 'https://gis.example.com/server/'], ...extra }]));

  it('a restored session gives its token to its portal and federated servers only', () => {
    stored();
    configureAuth({ portals: [portal], rules: [] });
    expect(currentUser(portal.url)).toEqual({ portal: portal.url, label: '社内', username: 'taro' });
    expect(tokenFor('https://gis.example.com/server/rest/services/A/FeatureServer/0')).toBe('T1');
    expect(tokenFor('https://gis.example.com/portal/sharing/rest/content/items/1')).toBe('T1');
    expect(tokenFor('https://gis.example.com/other/rest/services')).toBeUndefined();
    expect(tokenFor('http://gis.example.com/server/rest/services')).toBeUndefined();
    expect(tokenFor('https://gis.example.com.evil.net/server/')).toBeUndefined();
    // Picture tiles carry it as a parameter, unless they have a token of their own.
    expect(authorize('https://gis.example.com/server/rest/services/I/ImageServer/tile/1/2/3', { token: true }).url).toBe('https://gis.example.com/server/rest/services/I/ImageServer/tile/1/2/3?token=T1');
    expect(authorize('https://gis.example.com/server/rest/services/I/ImageServer/tile/1/2/3?token=mine', { token: true }).url).toBe('https://gis.example.com/server/rest/services/I/ImageServer/tile/1/2/3?token=mine');
    expect(authorize('https://gis.example.com/server/rest/services/I/ImageServer/tile/1/2/3').url).not.toContain('token');
    signOut(portal.url);
    expect(tokenFor('https://gis.example.com/server/rest/services')).toBeUndefined();
    expect(store.has('image-viewer.arcgis-sessions')).toBe(false);
  });

  it('drops sessions of other portals or client ids, and expired ones', () => {
    stored({ clientId: 'other' });
    configureAuth({ portals: [portal], rules: [] });
    expect(currentUser()).toBeNull();
    stored({ expires: Date.now() - 1000 });
    configureAuth({ portals: [portal], rules: [] });
    expect(currentUser()).toBeNull();
  });

  it('an expired token is not given out', () => {
    stored({ expires: Date.now() - 1000, refreshToken: 'R', refreshExpires: Date.now() + 86_400_000 });
    configureAuth({ portals: [portal], rules: [] });
    expect(currentUser()?.username).toBe('taro');
    expect(tokenFor('https://gis.example.com/server/rest/services')).toBeUndefined();
  });
});

describe('portal answers', () => {
  it('scopes: the portal, the organization and federated servers; ArcGIS Online hosted services', () => {
    const s = scopesOf('https://www.arcgis.com', { isPortal: false, id: 'Org123', urlKey: 'myorg', customBaseUrl: 'maps.arcgis.com' }, { servers: [{ url: 'https://evil.example.com/x', adminUrl: 'http://plain.example.com/' }] });
    expect(s.scopes).toEqual(['https://www.arcgis.com/', 'https://myorg.maps.arcgis.com/', 'https://evil.example.com/x/']);
    expect(s.orgId).toBe('Org123');
    expect(sessionCovers(s, 'https://services3.arcgis.com/Org123/arcgis/rest/services/A/FeatureServer/0')).toBe(true);
    expect(sessionCovers(s, 'https://services3.arcgis.com/Other/arcgis/rest/services/A/FeatureServer/0')).toBe(false);
    expect(sessionCovers(s, 'https://basemaps.arcgis.com/arcgis/rest/services/OSM/VectorTileServer')).toBe(false);
    const enterprise = scopesOf('https://gis.example.com/portal', { isPortal: true, id: 'abc' }, null);
    expect(enterprise).toEqual({ scopes: ['https://gis.example.com/portal/'] });
  });

  it('reads the token endpoint answer, and its errors', async () => {
    const fetch = vi.fn(async () => Response.json({ access_token: 'A', expires_in: 1800, refresh_token: 'R', refresh_token_expires_in: 1209600, username: 'u' }));
    vi.stubGlobal('fetch', fetch);
    expect(await requestToken('https://p.example.com', { grant_type: 'authorization_code' }, 1000)).toEqual({ token: 'A', expires: 1000 + 1_800_000, refreshToken: 'R', refreshExpires: 1000 + 1_209_600_000, username: 'u' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://p.example.com/sharing/rest/oauth2/token');
    expect(String(init.body)).toContain('grant_type=authorization_code');
    fetch.mockImplementation(async () => Response.json({ error: { code: 400, message: 'Invalid code' } }));
    await expect(requestToken('https://p.example.com', {})).rejects.toThrow('Invalid code');
    vi.unstubAllGlobals();
  });
});
