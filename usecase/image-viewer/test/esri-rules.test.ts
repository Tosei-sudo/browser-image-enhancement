import { describe, expect, it } from 'vitest';
import {
  andWhere,
  describeSettings,
  isDefault,
  mapLayerParams,
  mosaicMethodOf,
  mosaicRuleOf,
  renderingRuleOf,
  rulesFor,
  serviceRulesOf,
  settingsOf,
  sqlValue,
} from '../src/services/esri-rules.js';
import { parseConfig } from '../src/config.js';

describe('mosaicRuleOf', () => {
  it('leaves the service mosaicking alone without settings', () => {
    expect(mosaicRuleOf({})).toBeUndefined();
    expect(mosaicRuleOf({ rasterFunction: 'NDVI' })).toBeUndefined();
  });

  it('keeps the service method for a condition alone', () => {
    expect(mosaicRuleOf({ where: 'CloudCover <= 0.2' }, { method: 'Center', operation: 'First' })).toEqual({
      mosaicMethod: 'esriMosaicCenter',
      where: 'CloudCover <= 0.2',
      mosaicOperation: 'MT_FIRST',
    });
  });

  it('stacks by an attribute, largest on top unless asked otherwise', () => {
    expect(mosaicRuleOf({ sortField: 'AcquisitionDate' })).toEqual({ mosaicMethod: 'esriMosaicAttribute', sortField: 'AcquisitionDate', ascending: false });
    expect(mosaicRuleOf({ sortField: 'CloudCover', ascending: true, where: "Sensor = 'WV3'" })).toEqual({
      mosaicMethod: 'esriMosaicAttribute',
      where: "Sensor = 'WV3'",
      sortField: 'CloudCover',
      ascending: true,
    });
    // The service's own attribute method and sort field fill in.
    expect(mosaicRuleOf({ method: 'esriMosaicAttribute' }, { method: 'ByAttribute', sortField: 'Best', sortValue: 0, ascending: true })).toEqual({
      mosaicMethod: 'esriMosaicAttribute',
      sortField: 'Best',
      sortValue: 0,
      ascending: true,
    });
  });

  it('locks rasters by id', () => {
    expect(mosaicRuleOf({ method: 'esriMosaicLockRaster', lockRasterIds: [3, 1], operation: 'MT_MEAN' })).toEqual({
      mosaicMethod: 'esriMosaicLockRaster',
      lockRasterIds: [3, 1],
      mosaicOperation: 'MT_MEAN',
    });
  });
});

describe('renderingRuleOf', () => {
  it('names a raster function, or takes a rule written out', () => {
    expect(renderingRuleOf({})).toBeUndefined();
    expect(renderingRuleOf({ rasterFunction: 'None' })).toEqual({ rasterFunction: 'None' });
    expect(renderingRuleOf({ rasterFunction: 'NDVI', renderingRule: '{"rasterFunction":"Stretch"}' })).toEqual({ rasterFunction: 'Stretch' });
    expect(() => renderingRuleOf({ renderingRule: '[1]' })).toThrow();
  });
});

describe('map services', () => {
  it('writes the layers shown and their conditions', () => {
    expect(mapLayerParams({})).toEqual({});
    expect(mapLayerParams({ layers: [1, 2], layerDefs: { '1': " TYPE = 'A' ", '2': '' } })).toEqual({ layers: 'show:1,2', layerDefs: '{"1":"TYPE = \'A\'"}' });
    expect(mapLayerParams({ layers: [] })).toEqual({ layers: 'show:-1' });
  });
});

describe('settingsOf', () => {
  it('keeps what is of the right type and says what was dropped', () => {
    const problems: string[] = [];
    expect(
      settingsOf(
        { where: 'A = 1', method: 'ByAttribute', operation: 'Mean', sortField: 'D', ascending: 'no', bandIds: [3, 2, 1], layers: [0, -1], renderingRule: { rasterFunction: 'NDVI' }, rule: 'r' },
        problems,
      ),
    ).toEqual({ where: 'A = 1', method: 'esriMosaicAttribute', operation: 'MT_MEAN', sortField: 'D', bandIds: [3, 2, 1], renderingRule: '{"rasterFunction":"NDVI"}', rule: 'r' });
    expect(problems).toHaveLength(2);
    expect(settingsOf(undefined)).toBeUndefined();
    expect(settingsOf({ renderingRule: 'not json' })).toEqual({});
  });

  it('tells default settings', () => {
    expect(isDefault({})).toBe(true);
    expect(isDefault({ rule: 'x' })).toBe(true);
    expect(isDefault({ where: 'A = 1' })).toBe(false);
  });

  it('describes them for the information panel', () => {
    expect(describeSettings({ rule: '雲なし', where: 'CloudCover < 0.1', sortField: 'D', ascending: false, bandIds: [3, 2, 1] })).toEqual([
      ['表示ルール', '雲なし'],
      ['条件', 'CloudCover < 0.1'],
      ['並び順', 'D（大きい順を上に）'],
      ['バンド', '4, 3, 2'],
    ]);
  });
});

describe('serviceRules', () => {
  it('reads named rules and picks those of a service', () => {
    const problems: string[] = [];
    const rules = serviceRulesOf(
      [
        { label: '最新・雲量 20% 以下', match: 'Scenes/ImageServer', default: true, where: 'CloudCover <= 0.2', sortField: 'AcquisitionDate' },
        { label: '道路だけ', match: 'Base/MapServer', layers: [0] },
        { label: 'どれでも', rasterFunction: 'None' },
        { match: 'x' },
        { label: 'bad', match: '(' },
      ],
      problems,
    );
    expect(rules.map((r) => r.label)).toEqual(['最新・雲量 20% 以下', '道路だけ', 'どれでも']);
    expect(rules[0]).toMatchObject({ default: true, settings: { where: 'CloudCover <= 0.2', sortField: 'AcquisitionDate' } });
    expect(problems).toHaveLength(2);
    expect(rulesFor(rules, 'https://example.com/arcgis/rest/services/Scenes/ImageServer').map((r) => r.label)).toEqual(['最新・雲量 20% 以下', 'どれでも']);
  });

  it('come from config.json, with settings on esri layers', () => {
    const { config, problems } = parseConfig({
      serviceRules: [{ label: 'NDVI', match: 'ImageServer', rasterFunction: 'NDVI' }],
      layers: [{ type: 'esri', url: 'https://example.com/arcgis/rest/services/Scenes/ImageServer', layer: 'image', settings: { where: 'A = 1' } }],
    });
    expect(problems).toEqual([]);
    expect(config.serviceRules[0].settings).toEqual({ rasterFunction: 'NDVI' });
    expect(config.layers[0]).toEqual({ type: 'esri', url: 'https://example.com/arcgis/rest/services/Scenes/ImageServer', layer: 'image', settings: { where: 'A = 1' } });
  });
});

describe('conditions', () => {
  it('writes values in SQL by type', () => {
    expect(sqlValue('0.2', 'double')).toBe('0.2');
    expect(sqlValue("O'Hare", 'string')).toBe("'O''Hare'");
    expect(sqlValue('2024/1/5', 'date')).toBe("DATE '2024-01-05'");
    expect(sqlValue('2024-01-05 9:30', 'date')).toBe("TIMESTAMP '2024-01-05 09:30:00'");
    expect(sqlValue('abc', 'integer')).toBe("'abc'");
  });

  it('joins conditions with AND', () => {
    expect(andWhere('', 'A = 1')).toBe('A = 1');
    expect(andWhere('A = 1', 'B = 2')).toBe('A = 1 AND B = 2');
    expect(andWhere('A = 1 OR A = 2', 'B = 2')).toBe('(A = 1 OR A = 2) AND B = 2');
  });

  it('reads the service method names', () => {
    expect(mosaicMethodOf('NorthWest')).toBe('esriMosaicNorthwest');
    expect(mosaicMethodOf('esriMosaicCenter')).toBe('esriMosaicCenter');
    expect(mosaicMethodOf('Nope')).toBeUndefined();
  });
});
