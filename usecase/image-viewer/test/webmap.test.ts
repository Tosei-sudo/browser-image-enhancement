import { describe, expect, it } from 'vitest';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import { singleSpec } from '../src/vector-style.js';
import type { BaseMapConfig } from '../src/config.js';
import {
  buildWebMap,
  collectionFeatures,
  esriScaleOfSpec,
  labelFieldOf,
  matchBaseMap,
  parseItemInput,
  planWebMap,
  portalRoot,
  rendererOfSpec,
  specOfRenderer,
  specScaleOfEsri,
  styleOfRenderer,
  templateOf,
  tileUrls,
  tokenAllowed,
} from '../src/webmap.js';

const ID = '0123456789abcdef0123456789abcdef';

describe('parseItemInput', () => {
  it('reads item pages, Map Viewer links, REST URLs and bare ids', () => {
    expect(parseItemInput(`https://www.arcgis.com/home/item.html?id=${ID}`)).toEqual({ portal: 'https://www.arcgis.com', id: ID });
    expect(parseItemInput(`https://org.maps.arcgis.com/apps/mapviewer/index.html?webmap=${ID}`)).toEqual({ portal: 'https://org.maps.arcgis.com', id: ID });
    expect(parseItemInput(`https://gis.example.com/portal/home/webmap/viewer.html?webmap=${ID.toUpperCase()}`)).toEqual({ portal: 'https://gis.example.com/portal', id: ID });
    expect(parseItemInput(`https://gis.example.com/portal/sharing/rest/content/items/${ID}/data`)).toEqual({ portal: 'https://gis.example.com/portal', id: ID });
    expect(parseItemInput(ID, 'https://gis.example.com/portal/home/')).toEqual({ portal: 'https://gis.example.com/portal', id: ID });
    expect(parseItemInput(ID)).toEqual({ portal: 'https://www.arcgis.com', id: ID });
  });
  it('refuses what is not an item', () => {
    expect(parseItemInput('https://www.arcgis.com/home/item.html?id=abc')).toBeNull();
    expect(parseItemInput(`javascript:alert(1)//?id=${ID}`)).toBeNull();
    expect(parseItemInput('hello')).toBeNull();
    expect(portalRoot('ftp://x')).toBeNull();
  });
});

describe('tokenAllowed', () => {
  it('sends a token only to the portal host, or among ArcGIS Online hosts', () => {
    expect(tokenAllowed('https://gis.example.com/server/rest/services/A/FeatureServer/0', 'https://gis.example.com/portal')).toBe(true);
    expect(tokenAllowed('https://services1.arcgis.com/x/arcgis/rest/services/A/FeatureServer/0', 'https://org.maps.arcgis.com')).toBe(true);
    expect(tokenAllowed('https://evil.example.org/FeatureServer/0', 'https://gis.example.com/portal')).toBe(false);
    expect(tokenAllowed('http://gis.example.com/FeatureServer/0', 'https://gis.example.com/portal')).toBe(false);
    expect(tokenAllowed('http://localhost:4175/svc/x', 'http://localhost:4175/svc/portal')).toBe(true);
  });
});

const sms = (color: number[], size = 10) => ({ type: 'esriSMS', style: 'esriSMSSquare', color, size, outline: { color: [255, 255, 255, 255], width: 1 } });

const webmap = {
  version: '2.28',
  spatialReference: { wkid: 102100, latestWkid: 3857 },
  operationalLayers: [
    {
      id: 'parks',
      title: '公園',
      layerType: 'ArcGISFeatureLayer',
      url: 'https://example.com/arcgis/rest/services/Parks/FeatureServer/0',
      visibility: false,
      opacity: 0.8,
      minScale: 500000,
      layerDefinition: {
        definitionExpression: 'KIND = 1',
        drawingInfo: {
          renderer: { type: 'uniqueValue', field1: 'KIND', uniqueValueInfos: [{ value: '1', symbol: sms([34, 139, 34, 255]) }, { value: '2', symbol: sms([30, 144, 255, 255]) }] },
          labelingInfo: [{ labelExpressionInfo: { expression: '$feature.NAME' } }],
        },
      },
    },
    {
      title: 'グループ',
      layerType: 'GroupLayer',
      visibility: true,
      opacity: 0.5,
      layers: [
        { title: '地図', layerType: 'ArcGISMapServiceLayer', url: 'https://example.com/arcgis/rest/services/Base/MapServer', visibleLayers: [0, 2], layers: [{ id: 2, layerDefinition: { definitionExpression: "TYPE = 'A'" } }] },
        { title: '画像', layerType: 'ArcGISImageServiceLayer', url: 'https://example.com/arcgis/rest/services/Img/ImageServer', opacity: 0.5, renderingRule: { rasterFunction: 'NDVI' }, mosaicRule: { mosaicMethod: 'esriMosaicNone', where: 'Cloud < 0.2' } },
      ],
    },
    { title: 'WMS', layerType: 'WMS', url: 'https://example.com/wms', visibleLayers: ['a', 'b'] },
    { title: 'WMTS', layerType: 'WMTS', wmtsInfo: { url: 'https://example.com/wmts', layerIdentifier: 'ortho', tileMatrixSet: 'GoogleMapsCompatible' }, format: 'image/png' },
    { title: 'タイル', layerType: 'WebTiledLayer', templateUrl: 'https://{subDomain}.tiles.example.com/{level}/{col}/{row}.png', subDomains: ['a', 'b'] },
    { title: 'KML', layerType: 'KML', url: 'https://example.com/a.kml' },
    {
      title: '注記',
      featureCollection: {
        layers: [
          {
            layerDefinition: { name: '点', geometryType: 'esriGeometryPoint', fields: [{ name: 'OBJECTID', type: 'esriFieldTypeOID' }, { name: 'NAME', type: 'esriFieldTypeString' }], drawingInfo: { renderer: { type: 'simple', symbol: sms([255, 0, 0, 128], 12) } } },
            featureSet: { geometryType: 'esriGeometryPoint', spatialReference: { wkid: 102100 }, features: [{ geometry: { x: 15557000, y: 4257000 }, attributes: { OBJECTID: 1, NAME: '東京' } }] },
          },
        ],
      },
    },
  ],
  baseMap: { title: 'Topographic', baseMapLayers: [{ layerType: 'VectorTileLayer', title: 'World Topographic', styleUrl: 'https://basemaps.example.com/arcgis/rest/services/Topo/VectorTileServer/resources/styles/root.json' }] },
  initialState: { viewpoint: { targetGeometry: { xmin: 15540000, ymin: 4240000, xmax: 15580000, ymax: 4270000, spatialReference: { wkid: 102100 } } } },
  bookmarks: [{ name: '東京駅', extent: { xmin: 15558000, ymin: 4256000, xmax: 15560000, ymax: 4258000, spatialReference: { wkid: 102100 } } }],
};

describe('planWebMap', () => {
  const plan = planWebMap(webmap);
  it('reads feature layers with their definition expression, visibility, opacity, scales, renderer and labels', () => {
    const parks = plan.layers[0];
    expect(parks.type).toBe('service');
    if (parks.type !== 'service') return;
    expect(parks.ref).toEqual({ kind: 'esri', url: 'https://example.com/arcgis/rest/services/Parks/FeatureServer/0', layer: '0', settings: { where: 'KIND = 1' } });
    expect(parks).toMatchObject({ visible: false, opacity: 0.8, minScale: 500000, maxScale: null, labelField: 'NAME' });
    expect(parks.renderer?.type).toBe('uniqueValue');
  });
  it('flattens groups, multiplying their opacity, and reads map and image service settings', () => {
    const [map, image] = plan.layers.slice(1, 3);
    expect(map).toMatchObject({ title: '地図', opacity: 0.5, ref: { kind: 'esri', layer: 'map', settings: { layers: [0, 2], layerDefs: { '2': "TYPE = 'A'" } } } });
    expect(image).toMatchObject({ opacity: 0.25, ref: { layer: 'image', settings: { renderingRule: '{"rasterFunction":"NDVI"}', where: 'Cloud < 0.2', method: 'esriMosaicNone' } } });
  });
  it('reads WMS (one layer per name), WMTS and web tiled layers', () => {
    expect(plan.layers.slice(3, 5).map((l) => l.type === 'service' && l.ref.layer)).toEqual(['a', 'b']);
    expect(plan.layers[5]).toMatchObject({ ref: { kind: 'wmts', url: 'https://example.com/wmts', layer: 'ortho', matrixSet: 'GoogleMapsCompatible', format: 'image/png' } });
    expect(plan.layers[6]).toMatchObject({ type: 'tiles', urls: ['https://a.tiles.example.com/{z}/{x}/{y}.png', 'https://b.tiles.example.com/{z}/{x}/{y}.png'] });
  });
  it('reads feature collections and lists what it cannot show', () => {
    const notes = plan.layers[7];
    expect(notes.type).toBe('collection');
    if (notes.type !== 'collection') return;
    const features = collectionFeatures(notes.parts[0], 'EPSG:3857');
    expect(features).toHaveLength(1);
    expect(features[0].get('NAME')).toBe('東京');
    expect(plan.unsupported).toEqual([{ title: 'KML', reason: 'KML レイヤーには対応していません' }]);
  });
  it('reads the base map, the extent and the bookmarks', () => {
    expect(plan.basemap.title).toBe('Topographic');
    expect(plan.basemap.layers[0]).toMatchObject({ type: 'vector-tiles', url: 'https://basemaps.example.com/arcgis/rest/services/Topo/VectorTileServer', reference: false });
    expect(plan.extent).toEqual({ xmin: 15540000, ymin: 4240000, xmax: 15580000, ymax: 4270000, wkid: 102100 });
    expect(plan.bookmarks[0].name).toBe('東京駅');
  });
  it('matches the base map with config.json by URL', () => {
    const configs: BaseMapConfig[] = [
      { id: 'gsi', label: '地理院', type: 'xyz', url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', attributions: '', maxZoom: 18 },
      { id: 'topo', label: 'Topo', type: 'esri', url: 'https://basemaps.example.com/arcgis/rest/services/Topo/VectorTileServer', attributions: '', maxZoom: 22 },
    ];
    expect(matchBaseMap(plan.basemap, configs)?.id).toBe('topo');
    expect(matchBaseMap(plan.basemap, configs.slice(0, 1))).toBeUndefined();
  });
  it('refuses documents that are not web maps', () => {
    expect(() => planWebMap({ hello: 1 })).toThrow();
  });
});

describe('renderers', () => {
  it('maps a simple renderer onto one symbol', () => {
    const spec = specOfRenderer({ type: 'simple', symbol: { type: 'esriSFS', style: 'esriSFSSolid', color: [255, 0, 0, 128], outline: { color: [0, 0, 255, 255], width: 1.5, style: 'esriSLSDash' } } });
    expect(spec?.mode).toBe('single');
    expect(spec?.symbol).toMatchObject({ fill: '#ff0000', stroke: '#0000ff', strokeWidth: 2, dash: 'dash' });
    expect(spec?.symbol.fillOpacity).toBeCloseTo(128 / 255);
  });
  it('maps unique values onto categories, and class breaks onto ranges', () => {
    const categories = specOfRenderer({ type: 'uniqueValue', field1: 'KIND', defaultSymbol: sms([1, 2, 3, 255]), uniqueValueInfos: [{ value: '1', symbol: sms([34, 139, 34, 255]) }] });
    expect(categories).toMatchObject({ mode: 'categorized', field: 'KIND', othersVisible: true, categories: [{ value: '1', color: '#228b22', visible: true }] });
    expect(categories?.symbol.shape).toBe('square');
    const ranges = specOfRenderer({
      type: 'classBreaks',
      field: 'AREA',
      minValue: 0,
      classBreakInfos: [
        { classMaxValue: 500, symbol: { type: 'esriSLS', style: 'esriSLSSolid', color: [0, 0, 255, 255], width: 2 } },
        { classMaxValue: 100, symbol: { type: 'esriSLS', style: 'esriSLSSolid', color: [255, 0, 0, 255], width: 2 } },
      ],
    });
    expect(ranges).toMatchObject({ mode: 'graduated', field: 'AREA', othersVisible: false, classes: [{ min: 0, max: 100, color: '#ff0000' }, { min: 100, max: 500, color: '#0000ff' }] });
  });
  it('keeps renderers it cannot map as the layer own style', () => {
    expect(specOfRenderer({ type: 'simple', symbol: { type: 'esriPMS', url: 'a.png' } })).toBeNull();
    expect(styleOfRenderer({ type: 'uniqueValue', field1: 'A', field2: 'B', uniqueValueInfos: [{ value: '1,2', symbol: sms([0, 0, 0, 255]) }] }).mode).toBe('own');
  });
  it('writes the viewer style back as renderers', () => {
    const spec = singleSpec('#ff0000');
    expect(rendererOfSpec(spec, 'polygon')).toMatchObject({ type: 'simple', symbol: { type: 'esriSFS', style: 'esriSFSSolid', color: [255, 0, 0, 64] } });
    spec.mode = 'categorized';
    spec.field = 'KIND';
    spec.categories = [{ value: '1', color: '#00ff00', visible: true }, { value: '2', color: '#0000ff', visible: false }];
    const r = rendererOfSpec(spec, 'point');
    expect(r).toMatchObject({ type: 'uniqueValue', field1: 'KIND', uniqueValueInfos: [{ value: '1', symbol: { type: 'esriSMS', color: [0, 255, 0, 255] } }] });
    // Mapped back, the same categories.
    expect(specOfRenderer(r!)?.categories).toEqual([{ value: '1', color: '#00ff00', visible: true }]);
    expect(rendererOfSpec({ ...spec, mode: 'own' }, 'point')).toBeNull();
  });
  it('reads label expressions', () => {
    expect(labelFieldOf([{ labelExpressionInfo: { expression: '$feature["名 前"]' } }])).toBe('名 前');
    expect(labelFieldOf([{ labelExpression: '[NAME]' }])).toBe('NAME');
    expect(labelFieldOf([{ labelExpressionInfo: { expression: 'Upper($feature.NAME)' } }])).toBeNull();
  });
  it('converts scales both ways', () => {
    expect(esriScaleOfSpec(specScaleOfEsri(50000, 35), 35)).toBe(50000);
    expect(tileUrls('https://t/{level}/{row}/{col}', undefined)).toEqual(['https://t/{z}/{y}/{x}']);
    expect(templateOf('https://{a-c}.tile.example/{z}/{x}/{y}.png')).toBe('https://{subDomain}.tile.example/{level}/{col}/{row}.png');
  });
});

describe('buildWebMap', () => {
  it('writes service layers, feature collections, the view, the base map and bookmarks', () => {
    const style = singleSpec('#3366ff');
    style.label.field = 'NAME';
    const features = [new Feature({ geometry: new Point([15557000.123, 4257000]), NAME: '東京' }), new Feature({ geometry: new Polygon([[[0, 0], [10, 0], [10, 10], [0, 0]]]), NAME: '面' })];
    const result = buildWebMap({
      title: 'テスト',
      layers: [
        { type: 'ref', title: '公園', visible: true, opacity: 0.7, ref: { kind: 'esri', url: 'https://e.com/FeatureServer/0', layer: '0', settings: { where: 'KIND = 1' } }, spec: style, geometryType: 'esriGeometryPoint', minScale: 100000 },
        { type: 'ref', title: '地図', visible: false, opacity: 1, ref: { kind: 'esri', url: 'https://e.com/MapServer', layer: 'map', settings: { layers: [1], layerDefs: { '1': 'A = 1' } } } },
        { type: 'ref', title: 'WMS', visible: true, opacity: 1, ref: { kind: 'wms', url: 'https://e.com/wms?SERVICE=WMS&map=x', layer: 'roads' } },
        { type: 'features', title: '一時', visible: true, opacity: 1, features, fields: [{ name: 'NAME', alias: '名前', type: 'string', editable: true, nullable: true }] },
        { type: 'none', title: '画像.tif', visible: true, opacity: 1, reason: '画像は書けません' },
      ],
      extent: [0, 0, 100, 100],
      basemap: { config: { id: 'gsi', label: '地理院', type: 'xyz', url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', attributions: '<a href="x">国土地理院</a>', maxZoom: 18 } },
      bookmarks: [{ id: 'b', name: 'B', view: { projection: 'EPSG:3857', center: [50, 50], resolution: 1, rotation: 0 } }],
      bookmarkExtent: () => [40, 40, 60, 60],
    });
    // Read as plain JSON, as a portal would.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = JSON.parse(JSON.stringify(result.json)) as { operationalLayers: Array<Record<string, any>>; baseMap: any; initialState: any; bookmarks: any[]; version: string };
    expect(json.version).toMatch(/^2\./);
    expect(result.included).toEqual(['公園', '地図', 'WMS', '一時']);
    expect(result.skipped).toEqual([{ title: '画像.tif', reason: '画像は書けません' }]);
    const [parks, map, wms, temp] = json.operationalLayers;
    expect(parks).toMatchObject({ layerType: 'ArcGISFeatureLayer', url: 'https://e.com/FeatureServer/0', visibility: true, opacity: 0.7, minScale: 100000, showLabels: true });
    expect(parks.layerDefinition.definitionExpression).toBe('KIND = 1');
    expect(parks.layerDefinition.drawingInfo.renderer).toMatchObject({ type: 'simple', symbol: { type: 'esriSMS' } });
    expect(parks.layerDefinition.drawingInfo.labelingInfo[0].labelExpressionInfo.expression).toBe('$feature["NAME"]');
    expect(map).toMatchObject({ layerType: 'ArcGISMapServiceLayer', visibility: false, visibleLayers: [1], layers: [{ id: 1, layerDefinition: { definitionExpression: 'A = 1' } }] });
    expect(wms).toMatchObject({ layerType: 'WMS', url: 'https://e.com/wms?map=x', visibleLayers: ['roads'] });
    expect(temp.featureCollection.layers.map((l: { layerDefinition: { geometryType: string } }) => l.layerDefinition.geometryType)).toEqual(['esriGeometryPoint', 'esriGeometryPolygon']);
    expect(temp.featureCollection.layers[0].featureSet.features[0]).toEqual({ geometry: { x: 15557000.12, y: 4257000 }, attributes: { __OBJECTID: 1, NAME: '東京' } });
    expect(json.baseMap.baseMapLayers[0]).toMatchObject({ layerType: 'WebTiledLayer', templateUrl: 'https://cyberjapandata.gsi.go.jp/xyz/std/{level}/{col}/{row}.png', copyright: '国土地理院' });
    expect(json.initialState.viewpoint.targetGeometry).toMatchObject({ xmin: 0, ymax: 100, spatialReference: { wkid: 102100 } });
    expect(json.bookmarks[0]).toMatchObject({ name: 'B', extent: { xmin: 40, xmax: 60 } });
  });
  it('reads back what it writes', () => {
    const features = [new Feature({ geometry: new Point([1, 2]), NAME: 'a' })];
    const { json } = buildWebMap({
      title: 't',
      layers: [
        { type: 'ref', title: '公園', visible: false, opacity: 0.5, ref: { kind: 'esri', url: 'https://e.com/FeatureServer/0', layer: '0', settings: { where: 'X = 1' } } },
        { type: 'features', title: '点', visible: true, opacity: 1, features, fields: [{ name: 'NAME', alias: 'NAME', type: 'string', editable: true, nullable: true }] },
      ],
      extent: null,
      basemap: {},
    });
    const plan = planWebMap(JSON.parse(JSON.stringify(json)));
    expect(plan.layers[0]).toMatchObject({ visible: false, opacity: 0.5, ref: { url: 'https://e.com/FeatureServer/0', settings: { where: 'X = 1' } } });
    expect(plan.layers[1].type).toBe('collection');
    if (plan.layers[1].type === 'collection') expect(collectionFeatures(plan.layers[1].parts[0], 'EPSG:3857')[0].get('NAME')).toBe('a');
  });
  it('leaves out feature collections that are too big', () => {
    const features = Array.from({ length: 5001 }, (_, i) => new Feature({ geometry: new Point([i, i]) }));
    const result = buildWebMap({ title: 't', layers: [{ type: 'features', title: '多い', visible: true, opacity: 1, features, fields: [] }], extent: null, basemap: {} });
    expect(result.included).toEqual([]);
    expect(result.skipped[0].title).toBe('多い');
  });
});
