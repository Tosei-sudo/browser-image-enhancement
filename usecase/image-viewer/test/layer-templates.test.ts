import { beforeEach, describe, expect, it } from 'vitest';
import { builtinTemplates, removeTemplate, saveTemplate, savedTemplates, templateOf } from '../src/layer-templates.js';
import { guessTargetFields } from '../src/moving-target.js';
import { designFields } from '../src/temp-layers.js';

describe('new layer templates', () => {
  it('has built-in templates that all make valid layers', () => {
    for (const t of builtinTemplates) {
      const result = designFields(t);
      expect('errors' in result ? result.errors : [], t.name).toEqual([]);
    }
    expect(builtinTemplates[0].name).toBe('空のレイヤー');
  });

  it('makes the track template one the moving target plan reads without mapping', () => {
    const track = builtinTemplates.find((t) => t.name.startsWith('航跡'))!;
    expect(track.geometryType).toBe('Point');
    expect(guessTargetFields(track.fields.map((f) => f.name))).toEqual({ id: 'track_id', time: 'time', course: 'course', speed: 'speed', name: 'name' });
  });

  it('reads templates from JSON and says what is wrong', () => {
    const problems: string[] = [];
    expect(
      templateOf({ name: ' 巡回 ', geometryType: 'LineString', fields: [{ name: 'kind', codes: ['A', 'B'] }, { name: 'n', type: 'integer', min: 0, defaultValue: 1 }] }, problems, 'layerTemplates[0]'),
    ).toEqual({
      name: '巡回',
      title: '巡回',
      geometryType: 'LineString',
      fields: [
        { name: 'kind', type: 'string', alias: '', required: false, length: null, min: null, max: null, codes: 'A, B', defaultValue: '' },
        { name: 'n', type: 'integer', alias: '', required: false, length: null, min: 0, max: null, codes: '', defaultValue: '1' },
      ],
    });
    expect(problems).toEqual([]);
    expect(templateOf({ name: 'x', geometryType: 'Circle', fields: [] }, problems, 'a')).toBeNull();
    expect(templateOf({ fields: [] }, problems, 'b')).toBeNull();
    expect(templateOf({ name: 'y', fields: [{ name: 'z', type: 'bool' }] }, problems, 'c')?.fields).toEqual([]);
    expect(problems).toEqual([
      'a の geometryType は Point・LineString・Polygon・MultiPoint・MultiLineString・MultiPolygon・null のいずれかで指定',
      'b の name は文字列で指定',
      'c.fields[0] は name と type（string・integer・double・date）で指定',
    ]);
  });

  describe('saved in the browser', () => {
    beforeEach(() => {
      const data = new Map<string, string>();
      globalThis.localStorage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) } as Storage;
    });

    it('keeps, replaces by name and removes designs', () => {
      expect(savedTemplates()).toEqual([]);
      saveTemplate({ name: 'A', title: 'A', geometryType: 'Point', fields: [{ name: 'a', type: 'string' }] });
      saveTemplate({ name: 'B', title: 'B', geometryType: null, fields: [] });
      saveTemplate({ name: 'A', title: 'A', geometryType: 'Polygon', fields: [] });
      expect(savedTemplates().map((t) => [t.name, t.geometryType])).toEqual([
        ['B', null],
        ['A', 'Polygon'],
      ]);
      removeTemplate('B');
      expect(savedTemplates().map((t) => t.name)).toEqual(['A']);
    });
  });
});
