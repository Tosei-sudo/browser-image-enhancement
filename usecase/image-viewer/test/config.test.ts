import { describe, expect, it } from 'vitest';
import { presets } from 'browser-image-enhancement';
import { baseMapType, defaultConfig, imageRuleFor, lookupUrl, parseConfig } from '../src/config.js';
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

describe('imageRules', () => {
  it('reads presets, values by step, saved pipelines and bands', () => {
    const { config, problems } = parseConfig({
      imageRules: [
        { label: 'Landsat', match: '^LC0[89]_.*\\.tif$', preset: 'satellite', enhance: { contrast: 0.2 }, bands: [4, 3, 2] },
        { match: '_pan\\.tif$', caseSensitive: true, enhance: { version: 1, ops: [{ op: 'gamma', gamma: 1.5 }] }, bands: 1 },
        { match: 'nir', bands: ['NIR', 'Red', 'Green'] },
        { match: 'steps', enhance: [{ op: 'brightness', amount: 0.1 }] },
      ],
    });
    expect(problems).toEqual([]);
    const [landsat, pan, nir, steps] = config.imageRules;
    expect(landsat.label).toBe('Landsat');
    expect(landsat.pipeline?.toJSON()).toEqual(presets.satellite.set('contrast', 0.2).toJSON());
    expect(landsat.bands).toEqual([4, 3, 2]);
    expect(pan.label).toBe('_pan\\.tif$');
    expect(pan.pipeline?.toJSON()).toEqual({ version: 1, ops: [{ op: 'gamma', gamma: 1.5 }] });
    expect(pan.bands).toEqual([1]);
    expect(nir.pipeline).toBeNull();
    expect(nir.bands).toEqual(['NIR', 'Red', 'Green']);
    expect(steps.pipeline?.toJSON().ops).toEqual([{ op: 'brightness', amount: 0.1 }]);
  });

  it('takes the first rule that matches, ignoring case unless told', () => {
    const { config } = parseConfig({
      imageRules: [
        { label: 'pan', match: '_pan\\.tif$', caseSensitive: true, bands: 1 },
        { label: 'landsat', match: '^lc08_', preset: 'satellite' },
        { label: 'any tif', match: '\\.tif$', preset: 'auto' },
      ],
    });
    expect(imageRuleFor(config.imageRules, 'LC08_L1TP_107035.TIF')?.label).toBe('landsat');
    expect(imageRuleFor(config.imageRules, 'LC08_x_pan.tif')?.label).toBe('pan');
    expect(imageRuleFor(config.imageRules, 'scene_PAN.tif')?.label).toBe('any tif');
    expect(imageRuleFor(config.imageRules, 'photo.png')).toBeUndefined();
  });

  it('drops broken rules and ignores broken parts, saying why', () => {
    const { config, problems } = parseConfig({
      imageRules: [
        { match: '(', preset: 'auto' },
        { preset: 'auto' },
        { match: 'a', preset: 'nope' },
        { match: 'b', preset: 'vivid', enhance: { contrast: 0.3, sparkle: 1, gamma: 'x' } },
        { match: 'c', bands: [1, 2] },
        { match: 'd', bands: [0, 1, 2], enhance: { version: 2, ops: [] } },
      ],
    });
    expect(config.imageRules.map((r) => r.label)).toEqual(['b']);
    expect(config.imageRules[0].pipeline?.toJSON()).toEqual(presets.vivid.set('contrast', 0.3).toJSON());
    expect(problems).toHaveLength(11);
  });
});

describe('lookupUrl', () => {
  it('fills the authority and the code', () => {
    expect(lookupUrl(defaultConfig.projectionLookup, 'EPSG:6677')).toBe('https://spatialreference.org/ref/epsg/6677/ogcwkt/');
    expect(lookupUrl('https://epsg.io/{code}.proj4', 'EPSG:2451')).toBe('https://epsg.io/2451.proj4');
  });
});
