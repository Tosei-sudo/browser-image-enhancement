import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config.js';
import {
  assetPresets,
  datetimeOf,
  defaultChoice,
  DEFAULT_STAC_CATALOGS,
  headersFor,
  matchesSearch,
  nextRequest,
  parseCollections,
  parseItem,
  parseItemCollection,
  PcSigner,
  searchBody,
  searchParams,
  searchStac,
  searchUrl,
  signingFetch,
  stacCatalogOf,
  walkStatic,
  type StacSearch,
} from '../src/stac.js';

const search: StacSearch = { bbox: [139.6, 35.6, 139.9, 35.75], from: '2026-09-01', to: '2026-09-30', maxCloud: 20, collections: ['sentinel-2-l2a'], limit: 50 };

/** A Sentinel-2 item as Earth Search gives it. */
const s2 = {
  type: 'Feature',
  stac_version: '1.0.0',
  id: 'S2B_54SUE_20260915_0_L2A',
  collection: 'sentinel-2-l2a',
  bbox: [139.6, 35.6, 139.9, 35.75],
  geometry: { type: 'Polygon', coordinates: [[[139.6, 35.6], [139.9, 35.6], [139.9, 35.75], [139.6, 35.75], [139.6, 35.6]]] },
  properties: { datetime: '2026-09-15T01:23:45Z', 'eo:cloud_cover': 3.25, platform: 'sentinel-2b' },
  links: [{ rel: 'self', href: 'https://stac.example.com/collections/sentinel-2-l2a/items/S2B_54SUE_20260915_0_L2A' }],
  assets: {
    thumbnail: { href: 'https://data.example.com/s2/preview.jpg', type: 'image/jpeg', roles: ['thumbnail'] },
    visual: { href: 'https://data.example.com/s2/TCI.tif', type: 'image/tiff; application=geotiff; profile=cloud-optimized', roles: ['visual'], title: 'True color image' },
    red: { href: 'https://data.example.com/s2/B04.tif', type: 'image/tiff; application=geotiff; profile=cloud-optimized', roles: ['data'], title: 'Red (band 4) - 10m', 'eo:bands': [{ name: 'B04', common_name: 'red' }] },
    green: { href: 'https://data.example.com/s2/B03.tif', type: 'image/tiff; application=geotiff; profile=cloud-optimized', roles: ['data'], 'eo:bands': [{ name: 'B03', common_name: 'green' }] },
    blue: { href: 'https://data.example.com/s2/B02.tif', type: 'image/tiff; application=geotiff; profile=cloud-optimized', roles: ['data'], 'eo:bands': [{ name: 'B02', common_name: 'blue' }] },
    nir: { href: 'https://data.example.com/s2/B08.tif', type: 'image/tiff; application=geotiff; profile=cloud-optimized', roles: ['data'], 'eo:bands': [{ name: 'B08', common_name: 'nir' }] },
    scl: { href: 's3://bucket/s2/SCL.tif', type: 'image/tiff; application=geotiff' },
    'tileinfo_metadata': { href: 'https://data.example.com/s2/tileInfo.json', type: 'application/json' },
  },
};

describe('config', () => {
  it('defaults to Earth Search, and [] turns STAC off', () => {
    expect(parseConfig({}).config.stacCatalogs).toEqual(DEFAULT_STAC_CATALOGS);
    expect(DEFAULT_STAC_CATALOGS[0].url).toBe('https://earth-search.aws.element84.com/v1');
    expect(parseConfig({ stacCatalogs: [] }).config.stacCatalogs).toEqual([]);
  });

  it('reads catalogs one by one, with tokens, headers and signing', () => {
    const { config, problems } = parseConfig({
      stacCatalogs: [
        { label: '社内', url: 'https://stac.example.com/api', collections: ['a', 'b', 'a'], token: 'xyz', cloudFilter: 'filter' },
        { url: 'https://planetarycomputer.microsoft.com/api/stac/v1', sign: 'planetary-computer', headers: { 'X-Key': 'k', 'Bad Header': 'v', Evil: 'a\r\nb' } },
        'https://other.example.com/stac',
        { label: 'no url' },
        { url: 'javascript:alert(1)' },
        { url: 'https://x.example.com', sign: 'other' },
      ],
    });
    expect(config.stacCatalogs).toEqual([
      { label: '社内', url: 'https://stac.example.com/api', collections: ['a', 'b'], headers: { Authorization: 'Bearer xyz' }, cloudFilter: 'filter' },
      { label: 'https://planetarycomputer.microsoft.com/api/stac/v1', url: 'https://planetarycomputer.microsoft.com/api/stac/v1', collections: [], headers: { 'X-Key': 'k' }, sign: 'planetary-computer' },
      { label: 'https://other.example.com/stac', url: 'https://other.example.com/stac', collections: [] },
      { label: 'https://x.example.com', url: 'https://x.example.com', collections: [] },
    ]);
    expect(problems).toHaveLength(5);
    expect(parseConfig({ stacCatalogs: 'x' }).problems).toEqual(['stacCatalogs が配列ではありません']);
    expect(stacCatalogOf({ url: './stac/catalog.json' }, [], 0)?.url).toBe('./stac/catalog.json');
  });
});

describe('queries', () => {
  it('builds the POST body with the sort and the query extension', () => {
    expect(searchBody(search, {})).toEqual({
      limit: 50,
      bbox: [139.6, 35.6, 139.9, 35.75],
      datetime: '2026-09-01T00:00:00Z/2026-09-30T23:59:59Z',
      collections: ['sentinel-2-l2a'],
      query: { 'eo:cloud_cover': { lte: 20 } },
      sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    });
  });

  it('asks for the cloud cover in CQL2 when told, and leaves out what is not asked', () => {
    const body = searchBody({ ...search, bbox: null, from: '', to: '', collections: [] }, { cloudFilter: 'filter' }, false);
    expect(body).toEqual({ limit: 50, filter: { op: '<=', args: [{ property: 'eo:cloud_cover' }, 20] }, 'filter-lang': 'cql2-json' });
  });

  it('writes open date ranges', () => {
    expect(datetimeOf('2026-01-01', '')).toBe('2026-01-01T00:00:00Z/..');
    expect(datetimeOf('', '2026-01-31')).toBe('../2026-01-31T23:59:59Z');
    expect(datetimeOf('', 'bad')).toBeUndefined();
  });

  it('writes the same search as GET parameters', () => {
    const params = searchParams(searchBody(search, {}));
    expect(params.get('bbox')).toBe('139.6,35.6,139.9,35.75');
    expect(params.get('collections')).toBe('sentinel-2-l2a');
    expect(params.get('sortby')).toBe('-properties.datetime');
    expect(JSON.parse(params.get('query')!)).toEqual({ 'eo:cloud_cover': { lte: 20 } });
    expect(params.get('limit')).toBe('50');
  });

  it('finds /search under the root', () => {
    expect(searchUrl('https://earth-search.aws.element84.com/v1/')).toBe('https://earth-search.aws.element84.com/v1/search');
  });

  it('follows next links: GET, POST with its own body, or merged', () => {
    const previous = { url: 'https://s/search', method: 'POST' as const, body: { limit: 10, bbox: [0, 0, 1, 1] } };
    expect(nextRequest({ href: 'https://s/search?page=2', method: 'GET', merge: false }, previous)).toEqual({ url: 'https://s/search?page=2', method: 'GET' });
    expect(nextRequest({ href: 'https://s/search', method: 'POST', body: { token: 'n2' }, merge: true }, previous).body).toEqual({ limit: 10, bbox: [0, 0, 1, 1], token: 'n2' });
    expect(nextRequest({ href: 'https://s/search', method: 'POST', body: { token: 'n2' }, merge: false }, previous).body).toEqual({ token: 'n2' });
  });
});

describe('responses', () => {
  it('reads an item: time, cloud, footprint, thumbnail and its GeoTIFF assets', () => {
    const item = parseItem(s2)!;
    expect(item.id).toBe('S2B_54SUE_20260915_0_L2A');
    expect(item.time).toBe(Date.UTC(2026, 8, 15, 1, 23, 45));
    expect(item.cloud).toBe(3.25);
    expect(item.polygons).toHaveLength(1);
    expect(item.thumbnail).toBe('https://data.example.com/s2/preview.jpg');
    // The s3:// asset cannot be opened in a browser and is dropped.
    expect(item.assets.map((a) => a.key)).toEqual(['thumbnail', 'visual', 'red', 'green', 'blue', 'nir', 'tileinfo_metadata']);
    expect(item.assets.filter((a) => a.cog).map((a) => a.key)).toEqual(['visual', 'red', 'green', 'blue', 'nir']);
    expect(item.assets.find((a) => a.key === 'red')).toMatchObject({ commonName: 'red', bands: ['red'] });
  });

  it('opens visual by default, and offers RGB, false color and each asset', () => {
    const item = parseItem(s2)!;
    expect(defaultChoice(item)).toMatchObject({ kind: 'single', asset: { key: 'visual' } });
    const presets = assetPresets(item);
    expect(presets.map((p) => p.id)).toEqual(['visual', 'rgb', 'false-color', 'asset:visual', 'asset:red', 'asset:green', 'asset:blue', 'asset:nir']);
    const rgb = presets[1].choice;
    expect(rgb.kind === 'rgb' && rgb.assets.map((a) => a.key)).toEqual(['red', 'green', 'blue']);
    expect(presets[2].label).toBe('フォールスカラー（nir・red・green）');
  });

  it('composes red, green and blue when there is no visual asset (band names from eo:bands, or the keys)', () => {
    const assets: Record<string, unknown> = { ...s2.assets };
    delete assets.visual;
    const item = parseItem({ ...s2, assets: { ...assets, B04: { href: 'B04.TIF' }, nir08: { href: 'https://d/x.tif' } } }, 'https://stac.example.com/x/item.json')!;
    expect(defaultChoice(item)).toMatchObject({ kind: 'rgb' });
    // Relative hrefs against the item's self link; a .tif without a type is a GeoTIFF too.
    expect(item.assets.find((a) => a.key === 'B04')).toMatchObject({ href: 'https://stac.example.com/collections/sentinel-2-l2a/items/B04.TIF', cog: true });
    const only = parseItem({ ...s2, assets: { B1: { href: 'https://d/b1.tif', type: 'image/tiff' } } })!;
    expect(defaultChoice(only)).toMatchObject({ kind: 'single', asset: { key: 'B1' } });
    expect(defaultChoice(parseItem({ ...s2, assets: {} })!)).toBeNull();
  });

  it('refuses bad geometries and unsafe links', () => {
    const bad = parseItem({ ...s2, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 'x'], [1, 1], [0, 0]]] }, assets: { thumbnail: { href: 'javascript:alert(1)', type: 'image/png' } } })!;
    // The bbox stands in for the footprint.
    expect(bad.polygons[0][0]).toHaveLength(5);
    expect(bad.thumbnail).toBeNull();
    expect(bad.assets).toEqual([]);
    expect(parseItem({ type: 'Feature', properties: {} })).toBeNull();
    expect(parseItem({ ...s2, assets: { thumbnail: { href: 'https://x/t.svg', type: 'image/svg+xml' } } })!.thumbnail).toBeNull();
  });

  it('reads an ItemCollection with its next link and count', () => {
    const page = parseItemCollection(
      { type: 'FeatureCollection', features: [s2, { nope: 1 }], context: { matched: 120 }, links: [{ rel: 'next', href: 'https://s/search', method: 'POST', body: { next: 'abc' }, merge: true }] },
      'https://s/search',
    );
    expect(page.items).toHaveLength(1);
    expect(page.matched).toBe(120);
    expect(page.next).toEqual({ href: 'https://s/search', method: 'POST', body: { next: 'abc' }, merge: true });
    expect(parseItemCollection({ type: 'FeatureCollection', features: [], numberMatched: 0, links: [{ rel: 'next', href: 'ftp://x' }] }).next).toBeNull();
    expect(() => parseItemCollection({ code: 'BadRequest', description: 'bad bbox' })).toThrow('bad bbox');
  });

  it('reads collections', () => {
    expect(parseCollections({ collections: [{ id: 'a', title: 'A' }, { id: 'b' }, { title: 'x' }] })).toEqual([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'b' },
    ]);
  });

  it('filters static items by date, cloud cover and collection', () => {
    const item = parseItem(s2)!;
    expect(matchesSearch(item, search)).toBe(true);
    expect(matchesSearch(item, { ...search, maxCloud: 1 })).toBe(false);
    expect(matchesSearch(item, { ...search, from: '2026-09-16' })).toBe(false);
    expect(matchesSearch(item, { ...search, collections: ['landsat-c2-l2'] })).toBe(false);
  });
});

describe('network', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends headers only to the catalog’s origin', () => {
    const catalog = { url: 'https://stac.example.com/v1', headers: { Authorization: 'Bearer t' } };
    expect(headersFor('https://stac.example.com/v1/search', catalog)).toEqual({ Authorization: 'Bearer t' });
    expect(headersFor('https://evil.example.com/search', catalog)).toEqual({});
  });

  it('falls back to GET, and drops the sort when the API refuses it', async () => {
    const calls: Array<{ url: string; method: string; body?: string; auth?: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ url, method: init.method!, body: init.body as string | undefined, auth: headers.Authorization });
      if (init.method === 'POST') return new Response('', { status: 405 });
      if (url.includes('sortby')) return new Response(JSON.stringify({ description: 'sortby not supported' }), { status: 400 });
      return new Response(JSON.stringify({ type: 'FeatureCollection', features: [s2] }), { status: 200 });
    });
    const { page, request } = await searchStac({ label: 'x', url: 'https://stac.example.com/v1', collections: [], headers: { Authorization: 'Bearer t' } }, search);
    expect(page.items).toHaveLength(1);
    expect(request.method).toBe('GET');
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'POST', 'GET']);
    expect(calls[3].url).not.toContain('sortby');
    expect(calls.every((c) => c.auth === 'Bearer t')).toBe(true);
  });

  it('says why a search failed', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ description: 'Collection not found' }), { status: 404 }));
    await expect(searchStac({ label: 'x', url: 'https://s/v1', collections: [] }, search)).rejects.toThrow('HTTP 404: Collection not found');
  });

  it('walks a static catalog: children and items, within limits', async () => {
    const docs: Record<string, unknown> = {
      'https://s/catalog.json': { type: 'Catalog', links: [{ rel: 'child', href: './c1/collection.json' }, { rel: 'child', href: './c2/collection.json' }, { rel: 'self', href: './catalog.json' }] },
      'https://s/c1/collection.json': { type: 'Collection', links: [{ rel: 'item', href: './a/a.json' }, { rel: 'item', href: './b/b.json' }, { rel: 'parent', href: '../catalog.json' }] },
      'https://s/c2/collection.json': { type: 'Collection', links: [{ rel: 'item', href: 'https://s/c2/c.json' }, { rel: 'item', href: 'file:///etc/passwd' }] },
      'https://s/c1/a/a.json': { ...s2, id: 'a', links: [], assets: { visual: { href: './a.tif', type: 'image/tiff' } } },
      'https://s/c1/b/b.json': { ...s2, id: 'b', links: [] },
      'https://s/c2/c.json': { ...s2, id: 'c', links: [] },
    };
    const fetched: string[] = [];
    const get = async (url: string) => (fetched.push(url), docs[url]);
    const all = await walkStatic('https://s/catalog.json', get);
    expect(all.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(all.truncated).toBe(false);
    expect(all.items[0].assets[0].href).toBe('https://s/c1/a/a.tif');
    expect(fetched).not.toContain('file:///etc/passwd');
    const capped = await walkStatic('https://s/catalog.json', get, { items: 2, fetches: 100, depth: 4 });
    expect(capped.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(capped.truncated).toBe(true);
    const single = await walkStatic('https://s/c2/c.json', get);
    expect(single.items.map((i) => i.id)).toEqual(['c']);
    await expect(walkStatic('https://s/none.json', async () => 'x')).rejects.toThrow();
  });

  it('signs Planetary Computer blobs with their container’s token, once', async () => {
    const asked: string[] = [];
    const signer = new PcSigner(async (url) => (asked.push(url), { token: 'st=1&se=2&sig=abc%3D', 'msft:expiry': new Date(Date.now() + 3600_000).toISOString() }));
    expect(await signer.sign('https://sentinel2l2a01.blob.core.windows.net/sentinel2-l2/B04.tif')).toBe('https://sentinel2l2a01.blob.core.windows.net/sentinel2-l2/B04.tif?st=1&se=2&sig=abc%3D');
    expect(await signer.sign('https://sentinel2l2a01.blob.core.windows.net/sentinel2-l2/B03.tif')).toContain('sig=abc');
    expect(asked).toEqual(['https://planetarycomputer.microsoft.com/api/sas/v1/token/sentinel2l2a01/sentinel2-l2']);
    // Other hosts, and URLs signed already, are left as they are.
    expect(await signer.sign('https://example.com/a.tif')).toBe('https://example.com/a.tif');
    expect(PcSigner.containerOf('https://a01.blob.core.windows.net/c01/x.tif?sig=x')).toBeNull();
    // No token (a bad answer, or none): unsigned, and not asked again at once.
    const calls: string[] = [];
    const bad = new PcSigner(async (url) => (calls.push(url), { token: '<script>' }));
    expect(await bad.sign('https://acct.blob.core.windows.net/cont/x.tif')).toBe('https://acct.blob.core.windows.net/cont/x.tif');
    await bad.sign('https://acct.blob.core.windows.net/cont/y.tif');
    expect(calls).toHaveLength(1);
  });

  it('signs only the requests, keeping the URL unsigned', async () => {
    const sent: string[] = [];
    const base = (async (input: RequestInfo | URL) => (sent.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url), new Response('ok'))) as typeof fetch;
    const signed = signingFetch(base, new PcSigner(async () => ({ token: 'sig=t' })));
    const blob = 'https://acct.blob.core.windows.net/cont/x.tif';
    await signed(blob, { headers: { Range: 'bytes=0-1' } });
    await signed(new Request(blob));
    await signed('https://example.com/x.tif');
    expect(sent).toEqual([`${blob}?sig=t`, `${blob}?sig=t`, 'https://example.com/x.tif']);
  });
});
