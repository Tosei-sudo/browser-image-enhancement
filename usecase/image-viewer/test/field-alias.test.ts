import { describe, expect, it } from 'vitest';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import { fromLonLat } from 'ol/proj.js';
import { adoptAliases, aliasOverrides, applyAliases, fieldLabel, nameLabel, originalAlias, qmlAliasesXml, qmlTextAliases, setFieldAlias, withAliases } from '../src/field-alias.js';
import { readFlatGeobuf } from '../src/flatgeobuf.js';
import { readQgs, writeQgs } from '../src/qgis-project.js';
import type { Field } from '../src/services/index.js';
import { styleQml } from '../src/style-file.js';
import { readVectorFiles } from '../src/vector-files.js';
import { writeFgb } from '../src/vector-formats.js';
import { singleSpec } from '../src/vector-style.js';
import { writeGeoPackage } from '../src/vector-write.js';
import { PROJECT_FORMAT, readProject } from '../src/project-file.js';
import { planWebMap, popupAliases } from '../src/webmap.js';

const field = (name: string, alias = name, type: Field['type'] = 'string'): Field => ({ name, alias, type, editable: true, nullable: true });

describe('field labels', () => {
  it('show the alias with the name, or the name alone', () => {
    expect(fieldLabel(field('KIND', '種別'))).toBe('種別（KIND）');
    expect(fieldLabel(field('KIND'))).toBe('KIND');
    expect(fieldLabel(field('KIND', ' '))).toBe('KIND');
    expect(nameLabel([field('KIND', '種別')], 'KIND')).toBe('種別（KIND）');
    expect(nameLabel([field('KIND', '種別')], 'other')).toBe('other');
  });
});

describe('changing aliases', () => {
  it('keeps the alias a field came with, saves only the changed ones and goes back on blank', () => {
    const fields = [field('KIND', '種別'), field('H', '高さ', 'double')];
    expect(aliasOverrides(fields)).toBeNull();
    expect(setFieldAlias(fields[0], '用途')).toBe(true);
    expect(fields[0].alias).toBe('用途');
    expect(originalAlias(fields[0])).toBe('種別');
    expect(aliasOverrides(fields)).toEqual({ KIND: '用途' });
    expect(setFieldAlias(fields[0], '用途')).toBe(false);
    setFieldAlias(fields[0], '  ');
    expect(fields[0].alias).toBe('種別');
    expect(aliasOverrides(fields)).toBeNull();
    applyAliases(fields, { H: '建物高', missing: 'x' });
    expect(fields[1].alias).toBe('建物高');
    expect(aliasOverrides(fields)).toEqual({ H: '建物高' });
  });

  it("gives a file's own aliases without making them the person's", () => {
    const fields = [field('a'), field('b')];
    adoptAliases(fields, new Map([['a', 'エー']]));
    expect(fields[0].alias).toBe('エー');
    expect(aliasOverrides(fields)).toBeNull();
    const copied = withAliases(fields, new Map([['b', 'ビー']]));
    expect(copied.map((f) => f.alias)).toEqual(['エー', 'ビー']);
    expect(fields[1].alias).toBe('b');
  });
});

describe('QGIS aliases', () => {
  it('are written with a style (under the written column names) and read back', () => {
    const fields = [field('building_kind', '建物種別'), field('h')];
    const qml = styleQml(singleSpec('#4363d8'), 'point', new Map([['building_kind', 'building_k']]), fields);
    expect(qml).toContain('<alias field="building_k" index="0" name="建物種別"/>');
    expect(qml).not.toContain('field="h"');
    expect(qmlTextAliases(qml)).toEqual(new Map([['building_k', '建物種別']]));
    expect(qmlAliasesXml([field('a')])).toBe('');
    expect(qmlTextAliases('<not xml')).toEqual(new Map());
  });

  it('go with a QGIS project both ways', () => {
    const { project } = readProject(
      JSON.stringify({
        format: PROJECT_FORMAT,
        version: 1,
        fileSets: [{ files: [{ name: 'a.gpkg', size: 1, lastModified: 0 }] }],
        layers: [{ type: 'service', name: 'a', source: { kind: 'files', set: 0 }, visible: true, opacity: 1, aliases: { kind: '種別', bad: 3 } }],
      }),
    );
    expect(project.layers[0].aliases).toEqual({ kind: '種別' });
    const text = writeQgs(project, { kinds: ['point'], extent: null, title: 't', fields: [[field('kind', '種別')]] }, []);
    expect(text).toContain('<alias field="kind" index="0" name="種別"/>');
    expect(readQgs(text).project.layers[0].aliases).toEqual({ kind: '種別' });
  });
});

describe('file aliases', () => {
  const features = () => {
    const f = new Feature({ geometry: new Point(fromLonLat([139.7, 35.7])), kind: '住宅', h: 12 });
    return [f];
  };

  it('FlatGeobuf column titles', async () => {
    const bytes = writeFgb('sites', features(), [field('kind', '種別'), field('h', 'h', 'double')]);
    expect(readFlatGeobuf(bytes).columns.map((c) => c.title ?? null)).toEqual(['種別', null]);
    const [file] = await readVectorFiles([{ name: 'sites.fgb', bytes }]);
    expect(file.fields.map((f) => f.alias)).toEqual(['種別', 'h']);
  });

  it('GeoPackage data columns and style', async () => {
    const bytes = await writeGeoPackage('sites', features(), [field('kind', '種別'), field('h', 'h', 'double')], undefined, singleSpec('#4363d8'));
    const [file] = await readVectorFiles([{ name: 'sites.gpkg', bytes }]);
    expect(file.fields.filter((f) => f.type !== 'oid').map((f) => [f.name, f.alias])).toEqual([
      ['kind', '種別'],
      ['h', 'h'],
    ]);
    expect(qmlTextAliases(file.styleQml)).toEqual(new Map([['kind', '種別']]));
  });
});

describe('web map popup labels', () => {
  it('become the aliases of feature layers and collections', () => {
    expect(popupAliases({ fieldInfos: [{ fieldName: 'KIND', label: '種別' }, { fieldName: 'H', label: 'H' }, { fieldName: 'expression/x', label: '式' }, 'junk'] })).toEqual({ KIND: '種別' });
    const read = planWebMap({
      operationalLayers: [
        {
          id: 'a',
          title: '建物',
          layerType: 'ArcGISFeatureLayer',
          url: 'https://example.com/arcgis/rest/services/B/FeatureServer/0',
          popupInfo: { fieldInfos: [{ fieldName: 'KIND', label: '種別' }] },
        },
      ],
    });
    const layer = read.layers[0];
    expect(layer.type === 'service' && layer.aliases).toEqual({ KIND: '種別' });
  });
});
