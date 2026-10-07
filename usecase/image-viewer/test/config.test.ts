import { describe, expect, it } from 'vitest';
import { baseMapType, defaultConfig, lookupUrl, parseConfig } from '../src/config.js';
import shipped from '../public/config.json' with { type: 'json' };

describe('parseConfig', () => {
  it('reads the shipped config.json as the defaults, with no problems', () => {
    expect(parseConfig(shipped)).toEqual({ config: defaultConfig, problems: [] });
  });

  it('takes the default for what is missing', () => {
    expect(parseConfig({})).toEqual({ config: defaultConfig, problems: [] });
    const { config } = parseConfig({ projectionLookup: '' });
    expect(config.baseMaps).toEqual(defaultConfig.baseMaps);
    expect(config.projectionLookup).toBe('');
  });

  it('replaces the base maps and picks a default one', () => {
    const { config, problems } = parseConfig({
      baseMaps: [{ id: 'mine', label: '自社', url: 'https://tiles.example.com/{z}/{x}/{y}.png', maxZoom: 20 }, { id: 'local', url: './tiles/{z}/{x}/{y}.png' }],
      defaultBaseMap: 'mine',
    });
    expect(problems).toEqual([]);
    expect(config.baseMaps).toEqual([
      { id: 'mine', label: '自社', type: 'xyz', url: 'https://tiles.example.com/{z}/{x}/{y}.png', attributions: '', maxZoom: 20 },
      { id: 'local', label: 'local', type: 'xyz', url: './tiles/{z}/{x}/{y}.png', attributions: '', maxZoom: 18 },
    ]);
    expect(config.defaultBaseMap).toBe('mine');
  });

  it('reads vector tile base maps, telling their kind from the URL', () => {
    const { config, problems } = parseConfig({
      baseMaps: [
        { id: 'appliance', url: 'https://appliance.example.com/arcgis/rest/services/OSM/VectorTileServer', token: 'abc', style: './my-style.json' },
        { id: 'style', url: 'https://maps.example.com/styles/basic/style.json?key=k' },
        { id: 'pbf', url: 'https://maps.example.com/tiles/{z}/{x}/{y}.pbf' },
        { id: 'forced', type: 'style', url: 'https://maps.example.com/styles/basic' },
        { id: 'xyz-token', url: 'https://tiles.example.com/{z}/{x}/{y}.png', token: 'ignored' },
        { id: 'bad', type: 'wms', url: 'https://example.com/wms' },
      ],
    });
    expect(config.baseMaps).toEqual([
      { id: 'appliance', label: 'appliance', type: 'esri', url: 'https://appliance.example.com/arcgis/rest/services/OSM/VectorTileServer', attributions: '', maxZoom: 18, style: './my-style.json', token: 'abc' },
      { id: 'style', label: 'style', type: 'style', url: 'https://maps.example.com/styles/basic/style.json?key=k', attributions: '', maxZoom: 18 },
      { id: 'pbf', label: 'pbf', type: 'mvt', url: 'https://maps.example.com/tiles/{z}/{x}/{y}.pbf', attributions: '', maxZoom: 14 },
      { id: 'forced', label: 'forced', type: 'style', url: 'https://maps.example.com/styles/basic', attributions: '', maxZoom: 18 },
      { id: 'xyz-token', label: 'xyz-token', type: 'xyz', url: 'https://tiles.example.com/{z}/{x}/{y}.png', attributions: '', maxZoom: 18 },
    ]);
    expect(problems).toEqual(['baseMaps[5] の type「wms」は xyz・mvt・style・esri のどれかにしてください']);
  });

  it('tells the kind of a base map URL', () => {
    expect(baseMapType('https://a.example.com/arcgis/rest/services/X/VectorTileServer/')).toBe('esri');
    expect(baseMapType('https://a.example.com/arcgis/rest/services/X/VectorTileServer?token=t')).toBe('esri');
    expect(baseMapType('https://a.example.com/{z}/{x}/{y}.mvt')).toBe('mvt');
    expect(baseMapType('https://a.example.com/{z}/{x}/{y}.png')).toBe('xyz');
    expect(baseMapType('https://a.example.com/{z}/{x}/{y}')).toBe('xyz');
    expect(baseMapType('./style.json')).toBe('style');
  });

  it('drops invalid entries and says why', () => {
    const { config, problems } = parseConfig({
      baseMaps: [{ id: 'a', url: 'javascript:alert(1)' }, { id: 'b', url: '//x/{z}/{x}/{y}.png' }, { id: 'b', url: '//y/{z}/{x}/{y}.png' }, 3],
      defaultBaseMap: 'gsi-std',
      projectionLookup: 'https://example.com/',
      projections: { 'EPSG:6677': '+proj=tmerc +lat_0=36 +lon_0=139.833333333333 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs', bad: 1 },
    });
    expect(config.baseMaps.map((b) => b.id)).toEqual(['b']);
    expect(config.defaultBaseMap).toBe('');
    expect(config.projectionLookup).toBe(defaultConfig.projectionLookup);
    expect(Object.keys(config.projections)).toEqual(['EPSG:6677']);
    expect(problems).toHaveLength(6);
  });

  it('falls back entirely when the file is not an object', () => {
    expect(parseConfig([]).config).toEqual(defaultConfig);
    expect(parseConfig(null).problems).toHaveLength(1);
  });
});

describe('layers', () => {
  it('keeps COGs, files and service layers, and drops what cannot be opened', () => {
    const { config, problems } = parseConfig({
      layers: [
        { type: 'cog', url: 'https://example.com/a.tif' },
        { type: 'file', url: './data/b.geojson' },
        { type: 'wmts', url: 'https://example.com/wmts', layer: 'photo', matrixSet: 'GoogleMapsCompatible', format: '' },
        { type: 'esri', url: 'https://example.com/FeatureServer' },
        { type: 'xyz', url: 'https://example.com/{z}/{x}/{y}.png' },
        { type: 'cog', url: 'file:///c.tif' },
      ],
    });
    expect(config.layers).toEqual([
      { type: 'cog', url: 'https://example.com/a.tif' },
      { type: 'file', url: './data/b.geojson' },
      { type: 'wmts', url: 'https://example.com/wmts', layer: 'photo', matrixSet: 'GoogleMapsCompatible' },
    ]);
    expect(problems).toHaveLength(3);
  });
});

describe('lookupUrl', () => {
  it('fills the authority and the code', () => {
    expect(lookupUrl(defaultConfig.projectionLookup, 'EPSG:6677')).toBe('https://spatialreference.org/ref/epsg/6677/ogcwkt/');
    expect(lookupUrl('https://epsg.io/{code}.proj4', 'EPSG:2451')).toBe('https://epsg.io/2451.proj4');
  });
});
