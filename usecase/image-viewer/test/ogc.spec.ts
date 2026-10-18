import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { writeArrayBuffer } from 'geotiff';

/*
 * OGC API – Features (paging, filter, Part 4 editing), OGC API – Tiles (map
 * and vector tiles), raw values from WCS 2.0 and OGC API – Coverages opened
 * as GeoTIFFs, and WFS-T editing, against stand-ins answered in the page
 * (same origin, under /ogc/, /wcs and /wfst).
 */

const base = 'http://localhost:4175';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

/** 40 × 30 cells of 0.01° from 139.5 E, 35.9 N, values 100 + column. */
function demTiff(): Buffer {
  const width = 40;
  const height = 30;
  const values = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) values[y * width + x] = 100 + x;
  return Buffer.from(
    writeArrayBuffer(values, {
      width,
      height,
      SamplesPerPixel: 1,
      BitsPerSample: [16],
      SampleFormat: [1],
      PhotometricInterpretation: 1,
      ModelPixelScale: [0.01, 0.01, 0],
      ModelTiepoint: [0, 0, 0, 139.5, 35.9, 0],
      GeographicTypeGeoKey: 4326,
      GTModelTypeGeoKey: 2,
      GTRasterTypeGeoKey: 1,
    }),
  );
}

async function open(page: Page) {
  await page.route(/cyberjapandata\.gsi\.go\.jp|tile\.openstreetmap\.org/, (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto('/index.html');
  await page.waitForFunction(() => window.viewer !== undefined);
}

async function addService(page: Page, url: string, options: { kind?: string; layers?: number; setup?: (dialog: Locator) => Promise<void> } = {}) {
  await page.getByRole('button', { name: 'サービスを追加' }).click();
  const dialog = page.getByRole('dialog', { name: 'サービスを追加' });
  await dialog.getByRole('textbox', { name: 'サービスの URL' }).fill(url);
  await dialog.getByRole('combobox', { name: 'サービスの種類' }).selectOption(options.kind ?? 'auto');
  await dialog.getByRole('button', { name: '読み込む' }).click();
  await expect(dialog.locator('.service-layer')).toHaveCount(options.layers ?? 1);
  await dialog.locator('.service-layer input[type=checkbox]').first().check();
  await options.setup?.(dialog);
  await dialog.getByRole('button', { name: '追加', exact: true }).click();
  await expect(dialog).toBeHidden();
}

const json = (route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers });

const rows = (page: Page) => page.locator('.attributes tbody tr[data-index]');

const parks = [
  { type: 'Feature', id: 'p1', geometry: { type: 'Point', coordinates: [139.70, 35.68] }, properties: { name: '代々木', area: 54 } },
  { type: 'Feature', id: 'p2', geometry: { type: 'Point', coordinates: [139.77, 35.71] }, properties: { name: '上野', area: 53 } },
  { type: 'Feature', id: 'p3', geometry: { type: 'Point', coordinates: [139.71, 35.68] }, properties: { name: '新宿御苑', area: 58 } },
];

/** An OGC API with a feature collection (paged by 2), map and vector tiles of it, and a coverage. Records what was asked. */
async function ogcApi(page: Page, options: { editable?: boolean } = {}) {
  const asked: Array<{ method: string; url: URL; body?: string }> = [];
  const root = `${base}/ogc`;
  await page.route(`${root}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    asked.push({ method: request.method(), url, body: request.postData() ?? undefined });
    const path = url.pathname.replace(/^\/ogc/, '');
    if (path === '/' || path === '') return json(route, { title: 'テスト OGC API', links: [{ rel: 'conformance', href: `${root}/conformance` }, { rel: 'data', href: `${root}/collections`, type: 'application/json' }] });
    if (path === '/conformance')
      return json(route, {
        conformsTo: [
          'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core',
          'http://www.opengis.net/spec/ogcapi-features-3/1.0/conf/filter',
          'http://www.opengis.net/spec/cql2/1.0/conf/cql2-text',
          'http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/core',
          ...(options.editable ? ['http://www.opengis.net/spec/ogcapi-features-4/1.0/conf/create-replace-delete'] : []),
        ],
      });
    const collection = {
      id: 'parks',
      title: '公園',
      itemType: 'feature',
      extent: { spatial: { bbox: [[139.6, 35.6, 139.8, 35.8]] } },
      links: [
        { rel: 'items', href: `${root}/collections/parks/items`, type: 'application/geo+json' },
        { rel: 'http://www.opengis.net/def/rel/ogc/1.0/tilesets-map', href: `${root}/collections/parks/map/tiles`, type: 'application/json' },
        { rel: 'http://www.opengis.net/def/rel/ogc/1.0/tilesets-vector', href: `${root}/collections/parks/tiles`, type: 'application/json' },
      ],
    };
    const dem = {
      id: 'dem',
      title: '標高',
      itemType: 'coverage',
      extent: { spatial: { bbox: [[139.5, 35.6, 139.9, 35.9]], grid: [{ cellsCount: 40 }, { cellsCount: 30 }] } },
      links: [{ rel: 'http://www.opengis.net/def/rel/ogc/1.0/coverage', href: `${root}/collections/dem/coverage`, type: 'image/tiff; application=geotiff' }],
    };
    if (path === '/collections') return json(route, { collections: [collection, dem] });
    if (path === '/collections/parks') return json(route, collection);
    if (path === '/collections/dem') return json(route, dem);
    if (path === '/collections/parks/queryables') return json(route, { properties: { name: { type: 'string', title: '名称' }, area: { type: 'number' } } });
    if (path === '/collections/parks/items' && request.method() === 'GET') {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const all = url.searchParams.get('filter') ? parks.filter((p) => p.properties.area > 53) : parks;
      const page = all.slice(offset, offset + 2);
      const next = offset + 2 < all.length ? [{ rel: 'next', type: 'application/geo+json', href: `${root}/collections/parks/items?offset=${offset + 2}&${url.searchParams.has('filter') ? `filter=${encodeURIComponent(url.searchParams.get('filter')!)}&` : ''}limit=2` }] : [];
      return json(route, { type: 'FeatureCollection', features: page, links: next }, 200, { 'Content-Type': 'application/geo+json' });
    }
    if (path === '/collections/parks/items' && request.method() === 'POST') return route.fulfill({ status: 201, headers: { Location: `${root}/collections/parks/items/p9` }, body: '' });
    if (/^\/collections\/parks\/items\/[^/]+$/.test(path)) return route.fulfill({ status: request.method() === 'DELETE' ? 204 : 200, body: '' });
    if (path === '/collections/parks/map/tiles')
      return json(route, {
        tilesets: [
          {
            dataType: 'map',
            tileMatrixSetURI: 'http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad',
            links: [{ rel: 'self', href: `${root}/collections/parks/map/tiles/WebMercatorQuad` }],
          },
        ],
      });
    if (path === '/collections/parks/map/tiles/WebMercatorQuad')
      return json(route, {
        dataType: 'map',
        tileMatrixSetURI: 'http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad',
        tileMatrixSetLimits: [{ tileMatrix: '0' }, { tileMatrix: '16' }],
        links: [{ rel: 'item', type: 'image/png', templated: true, href: `${root}/collections/parks/map/tiles/WebMercatorQuad/{tileMatrix}/{tileRow}/{tileCol}?f=png` }],
      });
    if (path.startsWith('/collections/parks/map/tiles/WebMercatorQuad/')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG, headers: { 'Access-Control-Allow-Origin': '*' } });
    if (path === '/collections/parks/tiles')
      return json(route, {
        tilesets: [
          {
            dataType: 'vector',
            tileMatrixSetURI: 'http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad',
            links: [
              { rel: 'self', href: `${root}/collections/parks/tiles/WebMercatorQuad` },
              { rel: 'item', type: 'application/vnd.mapbox-vector-tile', href: `${root}/collections/parks/tiles/WebMercatorQuad/{tileMatrix}/{tileRow}/{tileCol}?f=mvt` },
            ],
            tileMatrixSetLimits: [{ tileMatrix: '0' }, { tileMatrix: '14' }],
          },
        ],
      });
    if (path.startsWith('/collections/parks/tiles/WebMercatorQuad/')) return route.fulfill({ status: 200, contentType: 'application/vnd.mapbox-vector-tile', body: Buffer.alloc(0) });
    if (path === '/collections/dem/coverage') return route.fulfill({ status: 200, contentType: 'image/tiff', body: demTiff() });
    return route.fulfill({ status: 404, body: '' });
  });
  return asked;
}

test('OGC API – Features: collections listed, items read page by page, filtered with CQL2, edited with Part 4', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await open(page);
  const asked = await ogcApi(page, { editable: true });

  // The landing page: the feature collection only (the coverage is not features).
  await addService(page, `${base}/ogc/`);
  await expect(page.locator('#images .name')).toHaveText(['OGC公園']);
  await expect(page.locator('.table-count')).toContainText('全 3 件');
  await expect(page.locator('.attributes th:not(.check)')).toHaveText(['名称', 'area']);
  await expect(page.locator('#info')).toContainText('OGC API – Features');
  // Two pages: the first asks for CRS84 (no Part 2), the second is the server's `next`.
  const items = asked.filter((a) => a.url.pathname.endsWith('/items'));
  expect(items.map((a) => a.url.searchParams.get('offset'))).toEqual([null, '2']);
  expect(items[0].url.searchParams.get('crs')).toBeNull();
  expect(page.url()).toContain('service=');

  // Part 4: change a name and delete a park, saved as PUT and DELETE of their items.
  await page.locator('#images li').getByRole('button', { name: '編集' }).click();
  await expect(page.getByRole('toolbar', { name: '編集' })).toBeVisible();
  const name = rows(page).first().getByRole('textbox', { name: '名称' });
  await name.fill('代々木公園');
  await name.press('Enter');
  await rows(page).nth(1).locator('td.check input').check();
  await page.getByRole('button', { name: '削除' }).click();
  await page.getByRole('button', { name: '保存 (2)' }).click();
  await expect(page.locator('#status')).toContainText('2 件の変更を保存しました');
  const put = asked.find((a) => a.method === 'PUT')!;
  expect(put.url.pathname).toBe('/ogc/collections/parks/items/p1');
  expect(JSON.parse(put.body!)).toMatchObject({ type: 'Feature', geometry: { type: 'Point' }, properties: { name: '代々木公園', area: 54 } });
  expect(JSON.parse(put.body!).geometry.coordinates[0]).toBeCloseTo(139.7, 6);
  expect(asked.find((a) => a.method === 'DELETE')?.url.pathname).toBe('/ogc/collections/parks/items/p2');
  await page.getByRole('button', { name: '編集終了' }).click();

  // A CQL2 condition, under 「詳細」, and only the area shown.
  await addService(page, `${base}/ogc/collections/parks`, {
    kind: 'ogc-features',
    setup: async (dialog) => {
      await dialog.getByLabel('範囲').selectOption('view');
      await dialog.getByText('詳細').click();
      await dialog.getByLabel('条件（CQL2）').fill('area > 53');
    },
  });
  await expect(page.locator('.table-count')).toContainText('全 2 件');
  const filtered = asked.filter((a) => a.url.pathname.endsWith('/items') && a.url.searchParams.has('filter'));
  expect(filtered[0].url.searchParams.get('filter')).toBe('area > 53');
  expect(filtered[0].url.searchParams.get('filter-lang')).toBe('cql2-text');
  expect(filtered[0].url.searchParams.get('bbox')?.split(',')).toHaveLength(4);
  await expect(page.locator('#info')).toContainText('area > 53');
  expect(errors).toEqual([]);
});

test('OGC API – Tiles: map tiles (corrected like WMTS) and vector tiles in WebMercatorQuad', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  const asked = await ogcApi(page);
  await addService(page, `${base}/ogc/`, {
    kind: 'ogc-tiles',
    setup: async (dialog) => {
      await dialog.locator('.service-layer').first().getByLabel('形式').selectOption('image/png');
    },
  });
  await expect(page.locator('#images .name')).toHaveText(['OGC公園']);
  await expect(page.locator('#info')).toContainText('地図タイル');
  await expect.poll(() => asked.filter((a) => /\/map\/tiles\/WebMercatorQuad\/\d+\/\d+\/\d+$/.test(a.url.pathname)).length).toBeGreaterThan(0);
  if (await page.evaluate(() => window.viewer.onGpu)) {
    expect(await page.evaluate(() => window.viewer.images.layers().some((l) => l.type === 'service' && !!l.service.correction))).toBe(true);
  }

  await addService(page, `${base}/ogc/`, { kind: 'ogc-tiles' });
  await expect(page.locator('#images .name')).toHaveText(['OGC公園', 'OGC公園']);
  await expect(page.locator('#info')).toContainText('ベクタータイル');
  await expect.poll(() => asked.filter((a) => /\/parks\/tiles\/WebMercatorQuad\/\d+\/\d+\/\d+$/.test(a.url.pathname) && a.url.searchParams.get('f') === 'mvt').length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('WCS 2.0 and OGC API – Coverages: the values of the area shown open as a GeoTIFF', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  const asked = await ogcApi(page);
  const coverages: URL[] = [];
  await page.route(`${base}/wcs**`, async (route) => {
    const url = new URL(route.request().url());
    const p = Object.fromEntries([...url.searchParams].map(([k, v]) => [k.toUpperCase(), v]));
    if (p.REQUEST === 'GetCapabilities')
      return route.fulfill({
        contentType: 'text/xml',
        body: `<?xml version="1.0"?><wcs:Capabilities version="2.0.1" xmlns:wcs="http://www.opengis.net/wcs/2.0" xmlns:ows="http://www.opengis.net/ows/2.0" xmlns:xlink="http://www.w3.org/1999/xlink">
          <ows:ServiceIdentification><ows:Title>テスト WCS</ows:Title><ows:Profile>http://www.opengis.net/spec/WCS_service-extension_scaling/1.0/conf/scaling</ows:Profile></ows:ServiceIdentification>
          <ows:OperationsMetadata><ows:Operation name="GetCoverage"><ows:DCP><ows:HTTP><ows:Get xlink:href="${base}/wcs?"/></ows:HTTP></ows:DCP></ows:Operation></ows:OperationsMetadata>
          <wcs:ServiceMetadata><wcs:formatSupported>image/png</wcs:formatSupported><wcs:formatSupported>image/tiff</wcs:formatSupported></wcs:ServiceMetadata>
          <wcs:Contents><wcs:CoverageSummary><wcs:CoverageId>test__dem</wcs:CoverageId><ows:Title>標高</ows:Title></wcs:CoverageSummary></wcs:Contents></wcs:Capabilities>`,
      });
    if (p.REQUEST === 'DescribeCoverage')
      return route.fulfill({
        contentType: 'text/xml',
        body: `<?xml version="1.0"?><wcs:CoverageDescriptions xmlns:wcs="http://www.opengis.net/wcs/2.0" xmlns:gml="http://www.opengis.net/gml/3.2"><wcs:CoverageDescription gml:id="test__dem">
          <gml:boundedBy><gml:Envelope srsName="http://www.opengis.net/def/crs/EPSG/0/4326" axisLabels="Lat Long" srsDimension="2"><gml:lowerCorner>35.6 139.5</gml:lowerCorner><gml:upperCorner>35.9 139.9</gml:upperCorner></gml:Envelope></gml:boundedBy>
          <wcs:CoverageId>test__dem</wcs:CoverageId>
          <gml:domainSet><gml:RectifiedGrid dimension="2" gml:id="grid"><gml:limits><gml:GridEnvelope><gml:low>0 0</gml:low><gml:high>39 29</gml:high></gml:GridEnvelope></gml:limits><gml:axisLabels>i j</gml:axisLabels>
          <gml:offsetVector>0 0.01</gml:offsetVector><gml:offsetVector>-0.01 0</gml:offsetVector></gml:RectifiedGrid></gml:domainSet>
          </wcs:CoverageDescription></wcs:CoverageDescriptions>`,
      });
    if (p.REQUEST === 'GetCoverage') {
      coverages.push(url);
      return route.fulfill({ contentType: 'image/tiff', body: demTiff() });
    }
    return route.fulfill({ status: 400, body: '' });
  });
  // Look at part of the coverage, so the subset is the view.
  await page.evaluate(() => {
    const view = window.viewer.map.getView();
    view.setCenter([(139.7 * 20037508.342789244) / 180, Math.log(Math.tan(((90 + 35.75) * Math.PI) / 360)) * 6378137]);
    view.setZoom(12);
  });

  await addService(page, `${base}/wcs?SERVICE=WCS`);
  await expect(page.locator('#images .name')).toHaveText(['test__dem.tif']);
  expect(coverages).toHaveLength(1);
  expect(coverages[0].searchParams.get('FORMAT')).toBe('image/tiff');
  const subsets = coverages[0].searchParams.getAll('SUBSET');
  expect(subsets.map((s) => s.replace(/\(.*/, ''))).toEqual(['Long', 'Lat']);
  const [w, e] = subsets[0].replace(/^.*\(|\)$/g, '').split(',').map(Number);
  expect(w).toBeGreaterThan(139.5);
  expect(e).toBeLessThan(139.9);
  // A GeoTIFF of values: the information panel reads its size and CRS like a local one.
  await expect(page.locator('#info')).toContainText('40');
  await expect(page.locator('#info')).toContainText('4326');

  // OGC API – Coverages: the whole coverage, as `coverage?bbox=…&f=geotiff`.
  await addService(page, `${base}/ogc/collections/dem`, { kind: 'ogc-coverage', setup: async (d) => void (await d.getByLabel('範囲').selectOption('all')) });
  await expect(page.locator('#images .name')).toHaveText(['dem.tif', 'test__dem.tif']);
  const coverage = asked.find((a) => a.url.pathname === '/ogc/collections/dem/coverage')!;
  expect(coverage.url.searchParams.get('f')).toBe('geotiff');
  expect(coverage.url.searchParams.has('bbox')).toBe(false);
  await page.screenshot({ path: '/mnt/project-files/integrations/ogc-coverage.png' }).catch(() => {});
  expect(errors).toEqual([]);
});

test('WFS-T: an editable feature type saves its edits as one Transaction and reports the summary', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await open(page);
  const posted: string[] = [];
  await page.route(`${base}/wfst**`, async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      posted.push(request.postData() ?? '');
      if (/NG/.test(request.postData() ?? ''))
        return route.fulfill({ contentType: 'text/xml', body: '<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1"><ows:Exception><ows:ExceptionText>name が不正です</ows:ExceptionText></ows:Exception></ows:ExceptionReport>' });
      return route.fulfill({
        contentType: 'text/xml',
        body: `<wfs:TransactionResponse xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:fes="http://www.opengis.net/fes/2.0" version="2.0.0"><wfs:TransactionSummary><wfs:totalInserted>1</wfs:totalInserted><wfs:totalUpdated>1</wfs:totalUpdated><wfs:totalDeleted>1</wfs:totalDeleted></wfs:TransactionSummary><wfs:InsertResults><wfs:Feature><fes:ResourceId rid="parks.9"/></wfs:Feature></wfs:InsertResults></wfs:TransactionResponse>`,
      });
    }
    const url = new URL(request.url());
    const p = Object.fromEntries([...url.searchParams].map(([k, v]) => [k.toUpperCase(), v]));
    if (p.REQUEST === 'GetCapabilities')
      return route.fulfill({
        contentType: 'text/xml',
        body: `<?xml version="1.0"?><wfs:WFS_Capabilities version="2.0.0" xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ows="http://www.opengis.net/ows/1.1" xmlns:xlink="http://www.w3.org/1999/xlink">
          <ows:ServiceIdentification><ows:Title>テスト WFS-T</ows:Title></ows:ServiceIdentification>
          <ows:OperationsMetadata>
            <ows:Operation name="GetFeature"><ows:DCP><ows:HTTP><ows:Get xlink:href="${base}/wfst?"/></ows:HTTP></ows:DCP><ows:Parameter name="outputFormat"><ows:AllowedValues><ows:Value>application/json</ows:Value></ows:AllowedValues></ows:Parameter></ows:Operation>
            <ows:Operation name="Transaction"><ows:DCP><ows:HTTP><ows:Post xlink:href="${base}/wfst?post"/></ows:HTTP></ows:DCP></ows:Operation>
            <ows:Constraint name="ImplementsTransactionalWFS"><ows:NoValues/><ows:DefaultValue>TRUE</ows:DefaultValue></ows:Constraint>
          </ows:OperationsMetadata>
          <wfs:FeatureTypeList><wfs:FeatureType><wfs:Name>test:parks</wfs:Name><wfs:Title>WFS公園</wfs:Title><wfs:DefaultCRS>urn:ogc:def:crs:EPSG::3857</wfs:DefaultCRS>
            <ows:WGS84BoundingBox><ows:LowerCorner>139.6 35.6</ows:LowerCorner><ows:UpperCorner>139.8 35.8</ows:UpperCorner></ows:WGS84BoundingBox></wfs:FeatureType></wfs:FeatureTypeList>
          </wfs:WFS_Capabilities>`,
      });
    if (p.REQUEST === 'DescribeFeatureType')
      return route.fulfill({
        contentType: 'text/xml',
        body: `<?xml version="1.0"?><xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:gml="http://www.opengis.net/gml/3.2" targetNamespace="http://example.com/test" elementFormDefault="qualified">
          <xsd:complexType name="parksType"><xsd:complexContent><xsd:extension base="gml:AbstractFeatureType"><xsd:sequence>
            <xsd:element name="name" type="xsd:string" nillable="true"/><xsd:element name="area" type="xsd:double" nillable="true"/><xsd:element name="geom" type="gml:PointPropertyType"/>
          </xsd:sequence></xsd:extension></xsd:complexContent></xsd:complexType><xsd:element name="parks" type="parksType" substitutionGroup="gml:AbstractFeature"/></xsd:schema>`,
      });
    if (p.REQUEST === 'GetFeature') {
      const merc = ([lon, lat]: number[]) => [(lon * 20037508.342789244) / 180, Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * 6378137];
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ type: 'FeatureCollection', features: parks.map((f, i) => ({ ...f, id: `parks.${i + 1}`, geometry_name: 'geom', geometry: { type: 'Point', coordinates: merc(f.geometry.coordinates) } })) }),
      });
    }
    return route.fulfill({ status: 400, body: '' });
  });

  await addService(page, `${base}/wfst`);
  await expect(page.locator('#images .name')).toHaveText(['WFSWFS公園']);
  await expect(page.locator('.table-count')).toContainText('全 3 件');
  await expect(page.locator('#info')).toContainText('追加・更新・削除（WFS-T）');

  await page.locator('#images li').getByRole('button', { name: '編集' }).click();
  const name = rows(page).first().getByRole('textbox', { name: 'name' });
  await name.fill('代々木公園');
  await name.press('Enter');
  await rows(page).nth(2).locator('td.check input').check();
  await page.getByRole('button', { name: '削除' }).click();
  // A new point on the map.
  await page.getByRole('button', { name: '追加', exact: true }).click();
  await page.waitForFunction(() => !window.viewer.map.getView().getAnimating());
  const box = (await page.locator('#map').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByRole('button', { name: '追加', exact: true }).click();
  await page.screenshot({ path: '/mnt/project-files/integrations/ogc-wfst-edit.png' }).catch(() => {});
  await page.getByRole('button', { name: '保存 (3)' }).click();
  await expect(page.locator('#status')).toContainText('3 件の変更を保存しました（WFS-T: 追加 1・更新 1・削除 1）');

  expect(posted).toHaveLength(1);
  const xml = posted[0];
  expect(xml).toContain('<wfs:Transaction service="WFS" version="2.0.0"');
  expect(xml).toContain('xmlns:test="http://example.com/test"');
  expect(xml).toMatch(/<wfs:Insert><test:parks><test:geom><gml:Point srsName="urn:ogc:def:crs:EPSG::3857" gml:id="g1"><gml:pos srsDimension="2">[-\d.]+ [-\d.]+<\/gml:pos><\/gml:Point><\/test:geom><\/test:parks><\/wfs:Insert>/);
  expect(xml).toContain('<wfs:Update typeName="test:parks"><wfs:Property><wfs:ValueReference>name</wfs:ValueReference><wfs:Value>代々木公園</wfs:Value></wfs:Property><fes:Filter><fes:ResourceId rid="parks.1"/></fes:Filter></wfs:Update>');
  expect(xml).toContain('<wfs:Delete typeName="test:parks"><fes:Filter><fes:ResourceId rid="parks.3"/></fes:Filter></wfs:Delete>');
  // The inserted feature took the id the server gave it.
  expect(await page.evaluate(() => window.viewer.images.layers().flatMap((l) => (l.type === 'service' ? l.service.vector!.source.getFeatures().map((f) => f.getId()) : [])))).toContain('parks.9');

  // An exception refuses the whole transaction, with its text.
  await rows(page).first().getByRole('textbox', { name: 'name' }).fill('NG');
  await rows(page).first().getByRole('textbox', { name: 'name' }).press('Enter');
  await page.getByRole('button', { name: '保存 (1)' }).click();
  await expect(page.locator('#status')).toContainText('name が不正です');
  expect(errors).toEqual([]);
});
