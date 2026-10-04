import { describe, expect, it } from 'vitest';
import { defaultConfig, lookupUrl, parseConfig } from '../src/config.js';
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
      { id: 'mine', label: '自社', url: 'https://tiles.example.com/{z}/{x}/{y}.png', attributions: '', maxZoom: 20 },
      { id: 'local', label: 'local', url: './tiles/{z}/{x}/{y}.png', attributions: '', maxZoom: 18 },
    ]);
    expect(config.defaultBaseMap).toBe('mine');
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
