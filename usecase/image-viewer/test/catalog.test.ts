import { describe, expect, it } from 'vitest';
import Feature from 'ol/Feature.js';
import { catalogOf, dayRange, emptySearch, recordOf, sortRecords, sourceOf, timeOf, whereOf, type CatalogConfig } from '../src/catalog.js';
import { parseConfig } from '../src/config.js';

const entry = {
  label: '衛星画像',
  url: 'https://gis.example.com/arcgis/rest/services/Catalog/FeatureServer/0',
  fields: { id: 'IMG_ID', acquired: 'ACQ_TIME', registered: 'REG_TIME', sensor: 'SENSOR', angle: 'OFF_NADIR', source: ['COG_URL', 'FILE_PATH'] },
  labels: { angle: 'オフナディア角' },
  columns: [{ field: 'CLOUD', label: '雲量' }, 'ORBIT'],
  where: "STATUS = 'OK'",
};

describe('catalogOf', () => {
  it('reads the attribute names by role', () => {
    const problems: string[] = [];
    expect(catalogOf(entry, problems, 0)).toEqual({
      label: '衛星画像',
      url: entry.url,
      fields: entry.fields,
      labels: { angle: 'オフナディア角' },
      columns: [
        { field: 'CLOUD', label: '雲量' },
        { field: 'ORBIT', label: 'ORBIT' },
      ],
      where: "STATUS = 'OK'",
      maxResults: 500,
    });
    expect(problems).toEqual([]);
  });

  it('needs a layer URL and a source field; other roles are optional', () => {
    const problems: string[] = [];
    expect(catalogOf({ ...entry, url: 'https://gis.example.com/arcgis/rest/services/Catalog/FeatureServer' }, problems, 0)).toBeNull();
    expect(catalogOf({ url: entry.url, fields: { id: 'ID' } }, problems, 1)).toBeNull();
    expect(catalogOf({ url: entry.url, fields: { source: 'PATH', sensor: 'bad name;' } }, problems, 2)).toMatchObject({ label: 'カタログ 3', fields: { source: ['PATH'] } });
    expect(problems).toHaveLength(3);
  });

  it('is read from config.json', () => {
    const { config, problems } = parseConfig({ imageCatalogs: [entry, { url: 'x' }] });
    expect(config.imageCatalogs.map((c) => c.label)).toEqual(['衛星画像']);
    expect(problems).toHaveLength(1);
  });
});

describe('sourceOf', () => {
  it('tells COG URLs from local paths', () => {
    expect(sourceOf('https://bucket.example.com/a.tif')).toEqual({ kind: 'url', url: 'https://bucket.example.com/a.tif' });
    expect(sourceOf('\\\\nas\\img\\a.tif')).toEqual({ kind: 'path', path: '\\\\nas\\img\\a.tif' });
    expect(sourceOf('C:\\data\\a.tif')).toEqual({ kind: 'path', path: 'C:\\data\\a.tif' });
    expect(sourceOf('file:///mnt/img/a.tif')).toEqual({ kind: 'path', path: 'file:///mnt/img/a.tif' });
    expect(sourceOf('')).toBeNull();
    expect(sourceOf(null)).toBeNull();
  });
});

describe('records', () => {
  const catalog = catalogOf(entry, [], 0) as CatalogConfig;
  const feature = (attrs: Record<string, unknown>) => new Feature(attrs);

  it('takes the first source field with a value', () => {
    const r = recordOf(feature({ IMG_ID: 'A1', ACQ_TIME: 1700000000000, SENSOR: 'S1', OFF_NADIR: '12.5', COG_URL: null, FILE_PATH: '\\\\nas\\a.tif' }), catalog.fields);
    expect(r).toMatchObject({ id: 'A1', sensor: 'S1', angle: 12.5, source: { kind: 'path', path: '\\\\nas\\a.tif' } });
  });

  it('sorts newest first with empty values last', () => {
    const records = [
      recordOf(feature({ IMG_ID: 'old', ACQ_TIME: '2026-01-01T00:00:00Z' }), catalog.fields),
      recordOf(feature({ IMG_ID: 'none' }), catalog.fields),
      recordOf(feature({ IMG_ID: 'new', ACQ_TIME: Date.UTC(2026, 5, 1) }), catalog.fields),
    ];
    expect(sortRecords(records, 'acquired', true).map((r) => r.id)).toEqual(['new', 'old', 'none']);
    expect(sortRecords(records, 'acquired', false).map((r) => r.id)).toEqual(['old', 'new', 'none']);
  });

  it('reads text times without a zone as UTC', () => {
    expect(timeOf('2026-10-01 01:02:03')).toBe(Date.UTC(2026, 9, 1, 1, 2, 3));
    expect(Number.isNaN(timeOf('unknown'))).toBe(true);
  });
});

describe('where', () => {
  const catalog = catalogOf(entry, [], 0) as CatalogConfig;

  it('writes days for the field type', () => {
    const start = new Date(2026, 9, 1).getTime();
    const [from, to] = dayRange('T', 'esriFieldTypeDate', '2026-10-01', '2026-10-31');
    expect(from).toBe(`T >= TIMESTAMP '${new Date(start).toISOString().slice(0, 19).replace('T', ' ')}'`);
    expect(to).toMatch(/^T < TIMESTAMP '2026-1[01]-\d\d \d\d:\d\d:\d\d'$/);
    expect(dayRange('T', 'esriFieldTypeString', '2026-10-01', '2026-10-31')).toEqual(["T >= '2026-10-01'", "T < '2026-11-01'"]);
    expect(dayRange('T', 'esriFieldTypeDateOnly', '', '2026-12-31')).toEqual(["T < DATE '2027-01-01'"]);
    expect(dayRange('T', 'esriFieldTypeDouble', '2026-10-01', '')).toEqual([`T >= ${start}`]);
  });

  it('joins the conditions', () => {
    expect(whereOf(catalog, { ACQ_TIME: 'esriFieldTypeString' }, { ...emptySearch, acquiredFrom: '2026-10-01', sensor: "O'Neil", maxAngle: 20, where: 'CLOUD < 10' })).toBe(
      "(STATUS = 'OK') AND ACQ_TIME >= '2026-10-01' AND SENSOR = 'O''Neil' AND OFF_NADIR <= 20 AND (CLOUD < 10)",
    );
    expect(whereOf({ ...catalog, where: undefined }, {}, emptySearch)).toBe('1=1');
  });
});
