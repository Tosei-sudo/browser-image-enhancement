import { describe, expect, it } from 'vitest';
import { flows, nextName, observationsCsv, observationStoreOf, vocabularyOf, type Observation } from '../src/observations.js';
import {
  childrenOf,
  classByName,
  find,
  photosAt,
  placeTaxon,
  specFieldsOf,
  specsAt,
  specText,
  EsriTaxonomyStore,
  flatten,
  kindOf,
  levelName,
  memberIndex,
  moveTaxon,
  nameLabelOf,
  nest,
  pathOf,
  removeTaxon,
  rewrite,
  taxonomyOf,
  updateTaxon,
  withKinds,
  within,
  type TaxonTree,
} from '../src/taxonomy.js';

// Ships four deep (the individual below), aircraft three: each branch names its own levels.
const tree: TaxonTree[] = [
  {
    name: '船舶',
    levels: ['大分類', '艦種', '級'],
    nameLabel: '艦名',
    children: [{ name: '支援船', children: [{ name: '〇〇級', members: ['△△', '□□'] }] }, { name: '護衛艦' }],
  },
  {
    name: '航空機',
    levels: ['大分類', '型式'],
    nameLabel: '機番',
    children: [
      {
        name: 'F-15',
        children: [{ name: 'F-15J', levels: ['大分類', '型式', '派生型'] }],
      },
    ],
  },
];

describe('taxonomy', () => {
  it('reads and writes kinds as paths', () => {
    expect(pathOf('船舶 > 支援船 >〇〇級')).toEqual(['船舶', '支援船', '〇〇級']);
    expect(pathOf('船舶 › 支援船')).toEqual(['船舶', '支援船']);
    expect(kindOf(['船舶', '支援船'])).toBe('船舶 > 支援船');
    expect(within('船舶 > 支援船 > 〇〇級', ['船舶', '支援船'])).toBe(true);
    expect(within('船舶 > 支援船x', ['船舶', '支援船'])).toBe(false);
    expect(within('船舶', ['船舶', '支援船'])).toBe(false);
  });

  it('flattens a nested tree, parents first, and nests it back', () => {
    const list = flatten(tree);
    expect(list.map((t) => kindOf(t.path))).toEqual(['船舶', '船舶 > 支援船', '船舶 > 支援船 > 〇〇級', '船舶 > 護衛艦', '航空機', '航空機 > F-15', '航空機 > F-15 > F-15J']);
    expect(nest(list)).toEqual(tree);
    expect(childrenOf(list, ['船舶']).map((t) => t.path[1])).toEqual(['支援船', '護衛艦']);
    expect(childrenOf(list, []).map((t) => t.path[0])).toEqual(['船舶', '航空機']);
  });

  it('names levels per branch, the nearest class that says winning', () => {
    const list = flatten(tree);
    expect(levelName(list, ['船舶', '支援船', '〇〇級'], 2)).toBe('級');
    expect(levelName(list, ['船舶', '支援船'], 1)).toBe('艦種');
    expect(levelName(list, ['航空機', 'F-15'], 1)).toBe('型式');
    expect(levelName(list, ['航空機', 'F-15', 'F-15J'], 2)).toBe('派生型');
    expect(levelName(list, ['航空機', 'F-15'], 2)).toBe('');
    expect(nameLabelOf(list, ['船舶', '支援船', '〇〇級'])).toBe('艦名');
    expect(nameLabelOf(list, ['航空機', 'F-15'])).toBe('機番');
    expect(memberIndex(list).get('△△')).toEqual(['船舶', '支援船', '〇〇級']);
  });

  it('moves, renames, changes and removes a class with its branch', () => {
    const list = flatten(tree);
    const moved = moveTaxon(list, ['船舶', '支援船'], ['船舶', '補助艦']);
    expect(moved.map((t) => kindOf(t.path))).toContain('船舶 > 補助艦 > 〇〇級');
    expect(moved.map((t) => kindOf(t.path))).not.toContain('船舶 > 支援船');
    expect(() => moveTaxon(list, ['船舶'], ['船舶', '支援船', '船舶'])).toThrow();
    expect(rewrite('船舶 > 支援船 > 〇〇級', ['船舶', '支援船'], ['船舶', '補助艦'])).toBe('船舶 > 補助艦 > 〇〇級');
    expect(rewrite('航空機', ['船舶'], ['x'])).toBe('航空機');
    const changed = updateTaxon(list, ['船舶', '護衛艦'], {
      members: ['あ', 'あ', 'い'],
      nameLabel: '艦名',
    });
    expect(changed.find((t) => t.path[1] === '護衛艦')).toEqual({
      path: ['船舶', '護衛艦'],
      members: ['あ', 'い'],
      nameLabel: '艦名',
    });
    expect(removeTaxon(list, ['船舶', '支援船']).map((t) => kindOf(t.path))).toEqual(['船舶', '船舶 > 護衛艦', '航空機', '航空機 > F-15', '航空機 > F-15 > F-15J']);
  });

  it('adds the kinds records use, under their classes', () => {
    const list = withKinds(flatten(tree), ['船舶 > 支援船 > ××級', '車両 > 戦車', '']);
    expect(list.map((t) => kindOf(t.path))).toEqual([
      '船舶',
      '船舶 > 支援船',
      '船舶 > 支援船 > 〇〇級',
      '船舶 > 支援船 > ××級',
      '船舶 > 護衛艦',
      '航空機',
      '航空機 > F-15',
      '航空機 > F-15 > F-15J',
      '車両',
      '車両 > 戦車',
    ]);
  });

  it('reads config.json, plain names too, and says what is wrong', () => {
    const problems: string[] = [];
    const list = taxonomyOf(['車両', { name: '船舶', children: ['漁船', { bogus: 1 }] }], problems)!;
    expect(list.map((t) => kindOf(t.path))).toEqual(['車両', '船舶', '船舶 > 漁船']);
    expect(problems).toEqual(['observationTaxonomy[1].children[1] は name のある分類（または名前の文字列）で指定']);
    expect(taxonomyOf({}, problems)).toBeNull();
    const v = vocabularyOf({ taxonomy: tree, activities: ['入港'] }, []);
    expect(v.kinds).toEqual(['船舶', '航空機']);
    expect(v.taxonomy.length).toBe(7);
    // Plain kinds of before stay roots.
    expect(vocabularyOf({ kinds: ['艦艇'] }, []).taxonomy).toEqual([{ path: ['艦艇'] }]);
    const store = observationStoreOf(
      {
        url: 'https://x/FeatureServer/0',
        taxonomy: tree,
        taxonomyTable: 'https://x/FeatureServer/3',
      },
      problems,
      0,
    )!;
    expect(store.taxonomy?.length).toBe(7);
    expect(store.taxonomyTable).toEqual({
      url: 'https://x/FeatureServer/3',
      fields: {
        path: 'PATH',
        levels: 'LEVELS',
        nameLabel: 'NAME_LABEL',
        members: 'MEMBERS',
        specs: 'SPECS',
        photos: 'PHOTOS',
        order: 'SORT_ORDER',
      },
    });
  });
});

const obs = (o: Partial<Observation>): Observation => ({
  id: Math.random().toString(36),
  imageId: 'img',
  imageName: 'img.tif',
  imageTime: 1,
  objectId: 'A',
  objectName: '△△',
  kind: '船舶',
  activity: '停泊',
  present: true,
  note: '',
  lon: 139.7,
  lat: 35.6,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  ...o,
});

describe('kinds in observations', () => {
  it('keeps a thing as deep as any record knows it', () => {
    const [flow] = flows([obs({ imageTime: 1, kind: '船舶 > 支援船 > 〇〇級' }), obs({ imageTime: 2, kind: '船舶' })]);
    expect(flow.kind).toBe('船舶 > 支援船 > 〇〇級');
    // A later record that says another class wins.
    const [moved] = flows([obs({ imageTime: 1, kind: '船舶 > 支援船 > 〇〇級' }), obs({ imageTime: 2, kind: '船舶 > 護衛艦' })]);
    expect(moved.kind).toBe('船舶 > 護衛艦');
  });

  it('numbers new things by their deepest class, and writes a CSV column per level', () => {
    expect(nextName('船舶 > 支援船 > 〇〇級', ['〇〇級-1'])).toBe('〇〇級-2');
    const csv = observationsCsv([obs({ kind: '船舶 > 支援船 > 〇〇級' }), obs({ kind: '航空機' })]);
    expect(csv.split('\r\n')[0]).toContain('種別,分類1,分類2,分類3,活動');
    expect(csv).toContain('船舶 > 支援船 > 〇〇級,船舶,支援船,〇〇級,停泊');
    expect(csv).toContain('航空機,航空機,,,停泊');
  });
});

describe('EsriTaxonomyStore', () => {
  it('writes a row per class and deletes the rows of classes gone', async () => {
    const calls: Array<{ url: string; params: Record<string, string> }> = [];
    let next = 10;
    const ask = async (url: string, params: Record<string, string>) => {
      calls.push({ url, params });
      if (url.endsWith('/3'))
        return {
          objectIdField: 'OBJECTID',
          fields: ['OBJECTID', 'PATH', 'LEVELS', 'MEMBERS', 'SORT_ORDER'].map((name) => ({
            name,
            type: name === 'OBJECTID' ? 'esriFieldTypeOID' : 'esriFieldTypeString',
          })),
        };
      if (url.endsWith('/query'))
        return {
          features: [
            {
              attributes: {
                OBJECTID: 1,
                PATH: '船舶 > 支援船',
                LEVELS: '大分類,艦種',
                MEMBERS: '',
                SORT_ORDER: 1,
              },
            },
            {
              attributes: {
                OBJECTID: 2,
                PATH: '船舶',
                LEVELS: '大分類,艦種',
                SORT_ORDER: 0,
              },
            },
          ],
        };
      const adds = JSON.parse(params.adds) as unknown[];
      return {
        addResults: adds.map(() => ({ success: true, objectId: next++ })),
        updateResults: (JSON.parse(params.updates) as unknown[]).map(() => ({
          success: true,
        })),
      };
    };
    const store = new EsriTaxonomyStore(
      {
        url: 'https://x/FeatureServer/3',
        fields: {
          path: 'PATH',
          levels: 'LEVELS',
          nameLabel: 'NAME_LABEL',
          members: 'MEMBERS',
          specs: 'SPECS',
          photos: 'PHOTOS',
          order: 'SORT_ORDER',
        },
      },
      ask,
      '分類',
    );
    const list = (await store.load())!;
    expect(list.map((t) => kindOf(t.path))).toEqual(['船舶', '船舶 > 支援船']);
    expect(list[0].levels).toEqual(['大分類', '艦種']);
    await store.save([{ path: ['船舶'] }, { path: ['航空機'], members: ['A', 'B'] }]);
    const edit = calls[calls.length - 1].params;
    expect(edit.deletes).toBe('1');
    expect(JSON.parse(edit.updates)).toEqual([
      {
        attributes: {
          PATH: '船舶',
          LEVELS: '',
          MEMBERS: '',
          SORT_ORDER: 0,
          OBJECTID: 2,
        },
      },
    ]);
    // NAME_LABEL is not in the table: left out.
    expect(JSON.parse(edit.adds)).toEqual([
      {
        attributes: {
          PATH: '航空機',
          LEVELS: '',
          MEMBERS: 'A,B',
          SORT_ORDER: 1,
        },
      },
    ]);
  });
});

describe('specifications and order', () => {
  const list = flatten([
    {
      name: '船舶',
      specs: { 開発国: '日本' },
      photos: ['https://x/ship.jpg'],
      children: [{ name: '支援船', specs: { 別名: 'AOE、補給艦', 全長: '221' }, children: [{ name: '〇〇級', specs: { 全長: '167', 英名: 'Oo class' } }] }],
    },
    { name: '航空機' },
  ]);

  it('reads a class’s specifications with those of the classes above, the nearest winning', () => {
    const specs = specsAt(list, ['船舶', '支援船', '〇〇級']);
    expect(specs.get('全長')).toEqual({ value: '167', from: ['船舶', '支援船', '〇〇級'] });
    expect(specs.get('開発国')).toEqual({ value: '日本', from: ['船舶'] });
    expect(photosAt(list, ['船舶', '支援船'])).toEqual({ photos: ['https://x/ship.jpg'], from: ['船舶'] });
    expect(photosAt(list, ['航空機']).photos).toEqual([]);
    expect(specText({ name: '全長', type: 'number', unit: 'm' }, '167')).toBe('167 m');
  });

  it('finds a class by its name, another name or its English name', () => {
    expect(classByName(list, '〇〇級')).toEqual(['船舶', '支援船', '〇〇級']);
    expect(classByName(list, '補給艦')).toEqual(['船舶', '支援船']);
    expect(classByName(list, 'oo CLASS')).toEqual(['船舶', '支援船', '〇〇級']);
    expect(classByName(list, '戦車')).toBeNull();
  });

  it('changes and clears specifications and photos, keeping the rest', () => {
    const changed = updateTaxon(list, ['船舶', '支援船'], { specs: { 全長: '220', 空: '' } });
    expect(find(changed, ['船舶', '支援船'])).toEqual({ path: ['船舶', '支援船'], specs: { 全長: '220' } });
    expect(find(updateTaxon(list, ['船舶'], { photos: [] }), ['船舶'])).toEqual({ path: ['船舶'], specs: { 開発国: '日本' } });
    // Kept through nesting for config.json.
    expect(flatten(nest(list))).toEqual(list);
  });

  it('reads the specification fields of config.json', () => {
    const problems: string[] = [];
    expect(specFieldsOf(['英名', { name: '全長', type: 'number', unit: 'm' }, { name: 'x', type: 'date' }, '英名'], problems)).toEqual([
      { name: '英名', type: 'text' },
      { name: '全長', type: 'number', unit: 'm' },
    ]);
    expect(problems).toEqual(['specFields[2].type は text・number・list・url のいずれかで指定']);
    expect(vocabularyOf({ specFields: ['艦番号'] }, []).specFields).toEqual([{ name: '艦番号', type: 'text' }]);
  });

  it('places a branch before a sibling or last among its siblings', () => {
    const tree = flatten([{ name: 'A', children: [{ name: 'a1' }, { name: 'a2' }, { name: 'a3', children: [{ name: 'x' }] }] }, { name: 'B' }]);
    const names = (l: ReturnType<typeof flatten>) => l.map((t) => kindOf(t.path));
    expect(names(placeTaxon(tree, ['A', 'a3'], ['A', 'a1']))).toEqual(['A', 'A > a3', 'A > a3 > x', 'A > a1', 'A > a2', 'B']);
    expect(names(placeTaxon(tree, ['A', 'a1'], null))).toEqual(['A', 'A > a2', 'A > a3', 'A > a3 > x', 'A > a1', 'B']);
    expect(names(placeTaxon(tree, ['B'], ['A']))).toEqual(['B', 'A', 'A > a1', 'A > a2', 'A > a3', 'A > a3 > x']);
  });
});

describe('EsriTaxonomyStore specifications', () => {
  it('writes specifications as JSON and photos one per line, and keeps the fields in a row of their own', async () => {
    const calls: Array<{ url: string; params: Record<string, string> }> = [];
    const ask = async (url: string, params: Record<string, string>) => {
      calls.push({ url, params });
      if (url.endsWith('/3'))
        return { objectIdField: 'OBJECTID', fields: ['OBJECTID', 'PATH', 'SPECS', 'PHOTOS'].map((name) => ({ name, type: name === 'OBJECTID' ? 'esriFieldTypeOID' : 'esriFieldTypeString' })) };
      if (url.endsWith('/query'))
        return {
          features: [
            { attributes: { OBJECTID: 1, PATH: '船舶', SPECS: '{"全長":"100"}', PHOTOS: 'https://x/a.jpg\nhttps://x/b.jpg' } },
            { attributes: { OBJECTID: 2, PATH: '#諸元項目', SPECS: '[{"name":"全長","type":"number","unit":"m"}]' } },
          ],
        };
      return { addResults: [], updateResults: [{ success: true }] };
    };
    const store = new EsriTaxonomyStore(
      { url: 'https://x/FeatureServer/3', fields: { path: 'PATH', levels: 'LEVELS', nameLabel: 'NAME_LABEL', members: 'MEMBERS', specs: 'SPECS', photos: 'PHOTOS', order: 'SORT_ORDER' } },
      ask,
      '分類',
    );
    expect(await store.load()).toEqual([{ path: ['船舶'], specs: { 全長: '100' }, photos: ['https://x/a.jpg', 'https://x/b.jpg'] }]);
    expect(await store.loadFields()).toEqual([{ name: '全長', type: 'number', unit: 'm' }]);
    // The fields' row is not a class: saving the classes leaves it.
    await store.save([{ path: ['船舶'], specs: { 全長: '120' } }]);
    const edit = calls[calls.length - 1].params;
    expect(edit.deletes).toBe('');
    expect(JSON.parse(edit.updates)).toEqual([{ attributes: { PATH: '船舶', SPECS: '{"全長":"120"}', PHOTOS: '', OBJECTID: 1 } }]);
    await store.saveFields([{ name: '英名', type: 'text' }]);
    expect(JSON.parse(calls[calls.length - 1].params.updates)).toEqual([{ attributes: { PATH: '#諸元項目', SPECS: '[{"name":"英名","type":"text"}]', OBJECTID: 2 } }]);
  });
});
