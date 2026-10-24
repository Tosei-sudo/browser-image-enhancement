import { describe, expect, it } from 'vitest';
import { designFields, designRecord, featuresOf, memoryStore, parseCodes, tempLayer } from '../src/temp-layers.js';
import { fieldDesignOf } from '../src/new-layer-dialog.js';

describe('designed temporary layers', () => {
  it('turns typed attributes into fields with defaults, limits and allowed values', () => {
    const result = designFields({
      title: '調査地点',
      geometryType: 'Point',
      fields: [
        { name: ' name ', type: 'string', alias: '名称', required: true, length: 20 },
        { name: 'kind', type: 'integer', codes: '1=住宅, 2=店舗\n3', defaultValue: '2' },
        { name: 'height', type: 'double', min: 0, max: null },
        { name: 'seen', type: 'date', defaultValue: '2026-10-17T00:00:00Z', codes: 'ignored' },
      ],
    });
    if ('errors' in result) throw new Error(result.errors.join());
    expect(result.fields).toEqual([
      { name: 'name', alias: '名称', type: 'string', editable: true, nullable: false, length: 20 },
      { name: 'kind', alias: 'kind', type: 'integer', editable: true, nullable: true, codes: [{ code: 1, name: '住宅' }, { code: 2, name: '店舗' }, { code: 3, name: '3' }] },
      { name: 'height', alias: 'height', type: 'double', editable: true, nullable: true, range: [0, Infinity] },
      { name: 'seen', alias: 'seen', type: 'date', editable: true, nullable: true },
    ]);
    expect(result.defaults).toEqual({ kind: 2, seen: Date.UTC(2026, 9, 17) });
  });

  it('says what is wrong: no name, duplicates (ignoring case), reserved names, bad defaults and codes', () => {
    const result = designFields({
      title: ' ',
      geometryType: null,
      fields: [
        { name: 'A', type: 'string' },
        { name: 'a', type: 'string' },
        { name: '', type: 'string' },
        { name: 'fid', type: 'integer' },
        { name: 'n', type: 'integer', defaultValue: '1.5' },
        { name: 'c', type: 'integer', codes: 'x=1' },
        { name: 'r', type: 'double', min: 5, max: 1 },
        { name: 'k', type: 'string', codes: '赤, 青', defaultValue: '緑' },
      ],
    });
    expect('errors' in result && result.errors).toEqual([
      'レイヤーの名前を入力',
      '属性「a」が重複（大文字・小文字の区別なし）',
      '3 番目の属性の名前を入力',
      '属性「fid」は書き出しで使う名前なので、別の名前で指定',
      '既定値: n は整数で入力',
      '属性「c」: 候補値「x」は整数で指定',
      '属性「r」の範囲は 最小 ≦ 最大 で指定',
      '属性「k」の既定値は候補値から選択',
    ]);
  });

  it('reads allowed values with or without names, and refuses duplicates', () => {
    expect(parseCodes('赤、青=ブルー', 'string')).toEqual([{ code: '赤', name: '赤' }, { code: '青', name: 'ブルー' }]);
    expect(parseCodes('1, 1', 'integer')).toEqual({ error: '候補値「1」が重複' });
  });

  it('opens empty, draws the chosen geometry type and starts new features with the defaults', () => {
    const record = designRecord({ title: '道路', geometryType: 'LineString', fields: [{ name: 'width', type: 'double', defaultValue: '4' }] });
    expect(featuresOf(record)).toEqual([]);
    const layer = tempLayer(record, memoryStore());
    expect(layer.editTarget).toMatchObject({ geometryType: 'LineString', template: { width: 4 }, canCreate: true });
    expect(layer.extent).toBeNull();
    expect(layer.info).toContainEqual(['ジオメトリ', 'ライン']);
    // "Any": the toolbar asks for each new feature.
    expect(tempLayer(designRecord({ title: 'x', geometryType: null, fields: [] }), memoryStore()).editTarget!.geometryType).toBeNull();
    expect(() => designRecord({ title: '', geometryType: 'Point', fields: [] })).toThrow('レイヤーの名前を入力');
  });

  it('copies the design of another layer\'s fields', () => {
    expect(fieldDesignOf({ name: 'TYPE', alias: '種別', type: 'integer', editable: true, nullable: false, range: [0, 9], codes: [{ code: 1, name: '住宅' }] })).toEqual({
      name: 'TYPE',
      type: 'integer',
      alias: '種別',
      required: true,
      length: null,
      min: 0,
      max: 9,
      codes: '1=住宅',
    });
  });
});
