import { describe, expect, it } from 'vitest';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import MultiLineString from 'ol/geom/MultiLineString.js';
import { findLink, linksOf, parseCollections, parseConformance, splitOgcUrl, conformsTo, conformance } from '../src/services/ogc-api.js';
import { itemsUrl, parseQueryables, readPages, simpleFilter } from '../src/services/ogc-features.js';
import { isWebMercatorQuad, itemTemplate, MVT_TYPE, parseTilesets, tileUrl } from '../src/services/ogc-tiles.js';
import { coveragePlan, getCoverageUrl, type CoverageGrid } from '../src/services/wcs.js';
import { cellsOf, coverageUrl } from '../src/services/ogc-coverage.js';
import { fitScale, MAX_SIDE, tiffName, withFileName } from '../src/services/coverage.js';
import { drawableOf, gmlGeometry, latitudeFirst, parseTransactionResponse, transactionXml, type WfsSchema } from '../src/services/wfs-t.js';
import { parseConfig } from '../src/config.js';

describe('OGC API common', () => {
  it('splits a URL into the landing page and the collection, keeping the query but f', () => {
    expect(splitOgcUrl('https://x.test/ogc/collections/roads/items?f=json&key=1')).toMatchObject({ landing: 'https://x.test/ogc', collection: 'roads' });
    expect(splitOgcUrl('https://x.test/ogc/collections/roads/items?f=json&key=1').query.toString()).toBe('key=1');
    expect(splitOgcUrl('https://x.test/ogc/')).toMatchObject({ landing: 'https://x.test/ogc', collection: null });
    expect(splitOgcUrl('https://x.test/ogc/collections')).toMatchObject({ landing: 'https://x.test/ogc', collection: null });
    expect(splitOgcUrl('https://x.test/ogc/conformance').landing).toBe('https://x.test/ogc');
    expect(splitOgcUrl('https://x.test/collections/%E9%81%93')).toMatchObject({ collection: '道' });
  });

  it('reads links (relative ones resolved, templates kept) and finds them by rel and type', () => {
    const links = linksOf(
      [
        { rel: 'items', href: 'items?f=html', type: 'text/html' },
        { rel: 'items', href: 'https://x.test/c/a/items', type: 'application/geo+json' },
        { rel: '[ogc-rel:tilesets-vector]', href: 'tiles/{tileMatrix}' },
        { rel: 'x', href: 'javascript:alert(1)' },
        { href: 'no-rel' },
      ],
      'https://x.test/c/a',
    );
    expect(links).toHaveLength(3);
    expect(findLink(links, ['items'], [/geo\+json/])?.href).toBe('https://x.test/c/a/items');
    expect(findLink(links, ['tilesets-vector'])?.href).toBe('https://x.test/c/tiles/{tileMatrix}');
  });

  it('reads collections and conformance', () => {
    const collections = parseCollections(
      {
        collections: [
          { id: 'a', title: 'A', extent: { spatial: { bbox: [[139, 35, 140, 36]], grid: [{ cellsCount: 100 }, { resolution: 0.01 }] } }, crs: ['http://www.opengis.net/def/crs/EPSG/0/3857'], itemType: 'feature' },
          { id: 'b', extent: { spatial: { bbox: [1, 2, 0, 3, 4, 9] } } },
          { title: 'no id' },
        ],
      },
      'https://x.test/collections',
    );
    expect(collections.map((c) => [c.id, c.title, c.bbox])).toEqual([
      ['a', 'A', [139, 35, 140, 36]],
      ['b', 'b', [1, 2, 3, 4]],
    ]);
    expect(collections[0].grid).toEqual([{ cellsCount: 100, resolution: undefined }, { cellsCount: undefined, resolution: 0.01 }]);
    const classes = parseConformance({ conformsTo: ['http://www.opengis.net/spec/ogcapi-features-3/1.0/conf/filter', 'http://www.opengis.net/spec/cql2/1.0/conf/cql2-text', 7] });
    expect(classes).toHaveLength(2);
    expect(conformsTo(classes, conformance.cql2Text)).toBe(true);
    expect(conformsTo(classes, conformance.edit)).toBe(false);
  });
});

describe('OGC API – Features', () => {
  it('builds the first items request: limit, box, CRS and filter', () => {
    const url = new URL(itemsUrl('https://x.test/c/a/items?f=json&key=1', { limit: 1000, bbox: [139.1, 35.2, 139.3, 35.4], crs: 'http://www.opengis.net/def/crs/EPSG/0/3857', filter: "name = 'x'", cql2: true }));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      key: '1',
      limit: '1000',
      bbox: '139.1,35.2,139.3,35.4',
      crs: 'http://www.opengis.net/def/crs/EPSG/0/3857',
      filter: "name = 'x'",
      'filter-lang': 'cql2-text',
    });
    const simple = new URL(itemsUrl('https://x.test/items', { limit: 10, filter: "kind=park AND city='東京'", cql2: false }));
    expect(Object.fromEntries(simple.searchParams)).toEqual({ limit: '10', kind: 'park', city: '東京' });
  });

  it('refuses simple filters that are not name=value or that use the API parameters', () => {
    expect(simpleFilter('a=1&b = 2')).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
    expect(() => simpleFilter('a > 1')).toThrow('属性=値');
    expect(() => simpleFilter('limit=5')).toThrow('limit');
  });

  it('reads queryables as fields, leaving the geometry out', () => {
    const fields = parseQueryables({
      properties: {
        geometry: { $ref: 'https://geojson.org/schema/Geometry.json' },
        name: { type: 'string', title: '名前', maxLength: 20 },
        pop: { type: 'integer' },
        area: { type: ['number', 'null'] },
        kind: { type: 'string', enum: ['a', 'b'] },
        shape: { format: 'geometry-polygon' },
      },
    });
    expect(fields.map((f) => [f.name, f.alias, f.type])).toEqual([
      ['name', '名前', 'string'],
      ['pop', 'pop', 'integer'],
      ['area', 'area', 'double'],
      ['kind', 'kind', 'string'],
    ]);
    expect(fields[0].length).toBe(20);
    expect(fields[3].codes).toEqual([
      { code: 'a', name: 'a' },
      { code: 'b', name: 'b' },
    ]);
  });

  it('follows next links on the same server, up to the cap', async () => {
    const pages: Record<string, unknown> = {
      'https://x.test/items?limit=2': { features: [1, 2], links: [{ rel: 'next', href: 'https://x.test/items?offset=2' }] },
      'https://x.test/items?offset=2': { features: [3, 4], links: [{ rel: 'next', href: 'https://evil.test/items?offset=4' }] },
    };
    const asked: string[] = [];
    const fetchPage = async (u: string) => (asked.push(u), pages[u]);
    expect(await readPages('https://x.test/items?limit=2', 10, fetchPage)).toEqual({ features: [1, 2, 3, 4], more: false });
    expect(asked).toHaveLength(2);
    expect(await readPages('https://x.test/items?limit=2', 3, fetchPage)).toEqual({ features: [1, 2, 3], more: true });
    await expect(readPages('https://x.test/items?limit=2', 3, async () => ({ type: 'Feature' }))).rejects.toThrow('FeatureCollection');
  });
});

describe('OGC API – Tiles', () => {
  const list = parseTilesets(
    {
      tilesets: [
        { dataType: 'vector', tileMatrixSetURI: 'http://www.opengis.net/def/tilematrixset/OGC/1.0/WorldCRS84Quad', links: [] },
        {
          dataType: 'vector',
          tileMatrixSetURI: 'http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad',
          tileMatrixSetLimits: [{ tileMatrix: '2' }, { tileMatrix: '14' }],
          links: [
            { rel: 'self', href: 'https://x.test/tiles/WebMercatorQuad' },
            { rel: 'item', type: 'application/vnd.mapbox-vector-tile', href: 'https://x.test/tiles/WebMercatorQuad/{tileMatrix}/{tileRow}/{tileCol}?f=mvt', templated: true },
          ],
        },
        { dataType: 'map', links: [{ rel: 'self', href: 'tiles/WebMercatorQuad' }, { rel: 'item', type: 'image/png', href: 'tiles/WebMercatorQuad/{tileMatrix}/{tileRow}/{tileCol}.png' }] },
      ],
    },
    'https://x.test/c/a/',
  );

  it('reads tilesets, their limits, and which are WebMercatorQuad', () => {
    expect(list.map(isWebMercatorQuad)).toEqual([false, true, true]);
    expect(list[1]).toMatchObject({ maxZoom: 14, minZoom: 2 });
    expect(itemTemplate(list[1], MVT_TYPE)).toBe('https://x.test/tiles/WebMercatorQuad/{tileMatrix}/{tileRow}/{tileCol}?f=mvt');
    expect(itemTemplate(list[2], 'image/jpeg')).toBe('https://x.test/c/a/tiles/WebMercatorQuad/{tileMatrix}/{tileRow}/{tileCol}.png');
  });

  it('fills in tile templates', () => {
    expect(tileUrl('https://x.test/{tileMatrix}/{tileRow}/{tileCol}?f=mvt', 5, 28, 12)).toBe('https://x.test/5/12/28?f=mvt');
    expect(tileUrl('https://x.test/{z}/{x}/{y}.png', 1, 2, 3)).toBe('https://x.test/1/2/3.png');
  });
});

describe('WCS', () => {
  // GeoServer's way: the envelope latitude first, 1000 × 500 cells over 10° × 5°.
  const grid: CoverageGrid = { id: 'dem', crs: 'http://www.opengis.net/def/crs/EPSG/0/4326', labels: ['Lat', 'Long'], lower: [30, 130], upper: [35, 140], size: [500, 1000], x: 1, y: 0 };

  it('subsets the area in the coverage axes, clipped to the coverage', () => {
    const plan = coveragePlan(grid, [139, 34, 141, 36], false);
    expect(plan).toEqual({ subsets: [['Long', 139, 140], ['Lat', 34, 35]], width: 100, height: 100, scale: 1 });
    const url = new URL(getCoverageUrl('https://x.test/ows?map=a&request=GetCapabilities', '2.0.1', 'dem', 'image/tiff', plan));
    expect(url.searchParams.get('map')).toBe('a');
    expect(url.searchParams.get('REQUEST')).toBe('GetCoverage');
    expect(url.searchParams.get('COVERAGEID')).toBe('dem');
    expect(url.searchParams.getAll('SUBSET')).toEqual(['Long(139,140)', 'Lat(34,35)']);
    expect(url.searchParams.has('SCALEFACTOR')).toBe(false);
  });

  it('scales an area over the caps down, or refuses it without the scaling extension', () => {
    const big: CoverageGrid = { ...grid, size: [50_000, 100_000] };
    const plan = coveragePlan(big, null, true);
    expect(plan.subsets).toEqual([]);
    expect(plan.scale).toBeCloseTo(MAX_SIDE / 100_000);
    expect(new URL(getCoverageUrl('https://x.test/ows', '2.0.1', 'dem', 'image/tiff', plan)).searchParams.get('SCALEFACTOR')).toBe(String(Math.floor(plan.scale * 1e6) / 1e6));
    expect(() => coveragePlan(big, null, false)).toThrow('範囲が大きすぎ');
    expect(() => coveragePlan(grid, [0, 0, 1, 1], true)).toThrow('重なりなし');
  });

  it('caps a side and the pixel count', () => {
    expect(fitScale(100, 100)).toBe(1);
    expect(fitScale(16384, 100)).toBe(0.5);
    expect(fitScale(8000, 8000)).toBeCloseTo(Math.sqrt(40_000_000 / 64_000_000));
  });

  it('names the file and keeps the name in the URL fragment', () => {
    expect(tiffName('ns:dem 10m')).toBe('ns_dem_10m.tif');
    expect(tiffName('a.tiff')).toBe('a.tiff');
    expect(withFileName('https://x.test/ows?a=1#x', 'dem.tif')).toBe('https://x.test/ows?a=1#file=dem.tif');
  });
});

describe('OGC API – Coverages', () => {
  const [collection] = parseCollections(
    { id: 'dem', extent: { spatial: { bbox: [130, 30, 140, 35], grid: [{ cellsCount: 1000 }, { cellsCount: 500 }] } }, links: [{ rel: 'http://www.opengis.net/def/rel/ogc/1.0/coverage', href: 'https://x.test/collections/dem/coverage?f=json' }] },
    'https://x.test/collections/dem',
  );

  it('asks for the box as GeoTIFF', () => {
    const url = new URL(coverageUrl({ landing: 'https://x.test', query: new URLSearchParams() }, collection, [139, 34, 140, 35]));
    expect(url.pathname).toBe('/collections/dem/coverage');
    expect(Object.fromEntries(url.searchParams)).toEqual({ bbox: '139,34,140,35', f: 'geotiff' });
  });

  it('counts the cells of a box from the grid', () => {
    expect(cellsOf(collection, [139, 34, 141, 36])).toEqual([100, 100]);
    expect(cellsOf(collection, null)).toEqual([1000, 500]);
    expect(cellsOf({ ...collection, grid: undefined }, null)).toBeNull();
  });
});

describe('WFS-T', () => {
  const schema: WfsSchema = { typeName: 'test:parks', namespace: 'http://example.com/test', geometryName: 'geom', geometryType: 'Point', order: ['name', 'geom', 'area'] };

  it('writes GML of each version', () => {
    expect(gmlGeometry(new Point([1, 2]), '2.0.0', 'urn:ogc:def:crs:EPSG::3857', false)).toBe('<gml:Point srsName="urn:ogc:def:crs:EPSG::3857" gml:id="g1"><gml:pos srsDimension="2">1 2</gml:pos></gml:Point>');
    expect(gmlGeometry(new Point([139, 35]), '1.1.0', 'urn:ogc:def:crs:EPSG::4326', true)).toBe('<gml:Point srsName="urn:ogc:def:crs:EPSG::4326"><gml:pos srsDimension="2">35 139</gml:pos></gml:Point>');
    expect(gmlGeometry(new Polygon([[[0, 0], [1, 0], [1, 1], [0, 0]]]), '1.0.0', 'EPSG:4326', false)).toBe(
      '<gml:Polygon srsName="EPSG:4326"><gml:outerBoundaryIs><gml:LinearRing><gml:coordinates decimal="." cs="," ts=" ">0,0 1,0 1,1 0,0</gml:coordinates></gml:LinearRing></gml:outerBoundaryIs></gml:Polygon>',
    );
    expect(gmlGeometry(new MultiLineString([[[0, 0], [1, 1]]]), '1.1.0', 'EPSG:3857', false)).toBe(
      '<gml:MultiCurve srsName="EPSG:3857"><gml:curveMember><gml:LineString><gml:posList srsDimension="2">0 0 1 1</gml:posList></gml:LineString></gml:curveMember></gml:MultiCurve>',
    );
  });

  it('writes one 2.0.0 Transaction with Insert, Update and Delete', () => {
    const xml = transactionXml({
      version: '2.0.0',
      schema,
      srsName: 'urn:ogc:def:crs:EPSG::3857',
      swap: false,
      inserts: [{ properties: { area: 5, name: 'A & B', extra: null }, geometry: new Point([10, 20]) }],
      updates: [
        { id: 'parks.1', properties: { name: '<x>', area: null } },
        { id: 'parks.2', properties: {}, geometry: new Point([3, 4]) },
      ],
      deletes: ['parks.3'],
    });
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<wfs:Transaction service="WFS" version="2.0.0" xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:fes="http://www.opengis.net/fes/2.0" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:test="http://example.com/test">' +
        '<wfs:Insert><test:parks><test:name>A &amp; B</test:name><test:geom><gml:Point srsName="urn:ogc:def:crs:EPSG::3857" gml:id="g1"><gml:pos srsDimension="2">10 20</gml:pos></gml:Point></test:geom><test:area>5</test:area></test:parks></wfs:Insert>' +
        '<wfs:Update typeName="test:parks"><wfs:Property><wfs:ValueReference>name</wfs:ValueReference><wfs:Value>&lt;x&gt;</wfs:Value></wfs:Property><wfs:Property><wfs:ValueReference>area</wfs:ValueReference></wfs:Property><fes:Filter><fes:ResourceId rid="parks.1"/></fes:Filter></wfs:Update>' +
        '<wfs:Update typeName="test:parks"><wfs:Property><wfs:ValueReference>geom</wfs:ValueReference><wfs:Value><gml:Point srsName="urn:ogc:def:crs:EPSG::3857" gml:id="g2"><gml:pos srsDimension="2">3 4</gml:pos></gml:Point></wfs:Value></wfs:Property><fes:Filter><fes:ResourceId rid="parks.2"/></fes:Filter></wfs:Update>' +
        '<wfs:Delete typeName="test:parks"><fes:Filter><fes:ResourceId rid="parks.3"/></fes:Filter></wfs:Delete>' +
        '</wfs:Transaction>',
    );
  });

  it('writes 1.1.0 with Filter 1.1 feature ids, and a type without a prefix', () => {
    const xml = transactionXml({ version: '1.1.0', schema: { ...schema, typeName: 'parks' }, srsName: 'EPSG:3857', swap: false, inserts: [], updates: [{ id: 'p.1', properties: { name: 'x' } }], deletes: ['p.2'] });
    expect(xml).toContain('xmlns:wfs="http://www.opengis.net/wfs" xmlns:ogc="http://www.opengis.net/ogc" xmlns:gml="http://www.opengis.net/gml" xmlns:feature="http://example.com/test"');
    expect(xml).toContain('<wfs:Update typeName="feature:parks"><wfs:Property><wfs:Name>name</wfs:Name><wfs:Value>x</wfs:Value></wfs:Property><ogc:Filter><ogc:FeatureId fid="p.1"/></ogc:Filter></wfs:Update>');
    expect(xml).toContain('<wfs:Delete typeName="feature:parks"><ogc:Filter><ogc:FeatureId fid="p.2"/></ogc:Filter></wfs:Delete>');
  });

  it('reads transaction responses and exceptions', () => {
    expect(
      parseTransactionResponse(
        '<wfs:TransactionResponse xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:fes="http://www.opengis.net/fes/2.0"><wfs:TransactionSummary><wfs:totalInserted>2</wfs:totalInserted><wfs:totalUpdated>1</wfs:totalUpdated><wfs:totalDeleted>0</wfs:totalDeleted></wfs:TransactionSummary><wfs:InsertResults><wfs:Feature><fes:ResourceId rid="parks.7"/></wfs:Feature><wfs:Feature><fes:ResourceId rid="parks.8"/></wfs:Feature></wfs:InsertResults></wfs:TransactionResponse>',
      ),
    ).toEqual({ ok: true, inserted: 2, updated: 1, deleted: 0, insertIds: ['parks.7', 'parks.8'] });
    expect(parseTransactionResponse('<wfs:WFS_TransactionResponse><wfs:InsertResult><ogc:FeatureId fid="p.9"/></wfs:InsertResult><wfs:TransactionResult><wfs:Status><wfs:SUCCESS/></wfs:Status></wfs:TransactionResult></wfs:WFS_TransactionResponse>')).toMatchObject({ ok: true, inserted: 1, insertIds: ['p.9'] });
    expect(parseTransactionResponse('<ows:ExceptionReport><ows:Exception><ows:ExceptionText>Value &lt;x&gt; too long</ows:ExceptionText></ows:Exception></ows:ExceptionReport>')).toMatchObject({ ok: false, message: 'Value <x> too long' });
    expect(parseTransactionResponse('<html>oops</html>')).toMatchObject({ ok: false });
  });

  it('knows geometry types and axis order', () => {
    expect(drawableOf('gml:MultiSurfacePropertyType')).toBe('MultiPolygon');
    expect(drawableOf('gml:PointPropertyType')).toBe('Point');
    expect(drawableOf('gml:GeometryPropertyType')).toBeNull();
    expect(latitudeFirst('urn:ogc:def:crs:EPSG::4326', true)).toBe(true);
    expect(latitudeFirst('EPSG:4326', true)).toBe(false);
    expect(latitudeFirst('urn:ogc:def:crs:EPSG::3857', false)).toBe(false);
  });
});

describe('config layers of the OGC kinds', () => {
  it('keeps them with their box and condition, and reports a bad box', () => {
    const { config, problems } = parseConfig({
      layers: [
        { type: 'ogc-features', url: 'https://x.test/ogc', layer: 'roads', filter: " kind = 'a' ", bbox: [139, 35, 140, 36] },
        { type: 'ogc-tiles', url: 'https://x.test/ogc', layer: '*', format: 'image/png' },
        { type: 'wcs', url: 'https://x.test/ows', layer: 'dem', bbox: [1, 2] },
        { type: 'ogc-coverage', url: 'https://x.test/ogc', layer: 'dem' },
      ],
    });
    expect(config.layers).toEqual([
      { type: 'ogc-features', url: 'https://x.test/ogc', layer: 'roads', filter: "kind = 'a'", bbox: [139, 35, 140, 36] },
      { type: 'ogc-tiles', url: 'https://x.test/ogc', layer: '*', format: 'image/png' },
      { type: 'wcs', url: 'https://x.test/ows', layer: 'dem' },
      { type: 'ogc-coverage', url: 'https://x.test/ogc', layer: 'dem' },
    ]);
    expect(problems).toEqual(['layers[2].bbox は [西, 南, 東, 北]（度）の 4 つの数で指定']);
  });
});
