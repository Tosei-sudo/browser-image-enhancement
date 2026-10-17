import { describe, expect, it } from 'vitest';
import { normalize, rank, score, type Command } from '../src/command-palette.js';

const command = (id: string, label: string, detail?: string): Command => ({ id, label, detail, run: () => {} });

describe('normalize', () => {
  it('folds katakana to hiragana, full width to half width and drops the dialog ellipsis', () => {
    expect(normalize('スクリプト…')).toBe('すくりぷと');
    expect(normalize('ＮＤＶＩ')).toBe('ndvi');
    expect(normalize('ｶﾀｶﾅ')).toBe('かたかな');
  });
});

describe('score', () => {
  it('matches every word, in the label or the detail', () => {
    expect(score(command('a', '距離を測る', '計測'), 'めんせき')).toBe(-1);
    expect(score(command('a', '距離を測る', '計測'), '距離')).toBeGreaterThan(0);
    expect(score(command('a', '距離を測る', '計測'), '計測')).toBeGreaterThan(0);
    expect(score(command('a', '距離を測る', '計測'), '距離 面積')).toBe(-1);
  });

  it('kana still being typed finds a kanji name by its reading', () => {
    expect(score(command('a', '距離を測る', '計測'), 'きょり')).toBeGreaterThan(0);
    expect(score(command('a', '表示範囲を保存'), 'ほぞん')).toBeGreaterThan(0);
  });

  it('typed in hiragana finds a katakana label', () => {
    expect(score(command('a', 'タイムライン'), 'たいむ')).toBeGreaterThan(0);
  });
});

describe('rank', () => {
  const commands = [
    command('area', '面積を測る', '計測'),
    command('band', 'バンド演算・指標（NDVI など）', 'プロセッシング（画像）'),
    command('save', 'GeoJSON 保存', 'ポイント'),
    command('view', '表示範囲を保存', '注記・保存'),
  ];

  it('puts a label match before a detail match, its start first', () => {
    expect(rank(commands, '保存').map((c) => c.id)).toEqual(['view', 'save']);
    expect(rank([command('x', '保存先', 'a'), ...commands], '保存')[0].id).toBe('x');
    expect(rank(commands, 'ndvi').map((c) => c.id)).toEqual(['band']);
    expect(rank(commands, '計測').map((c) => c.id)).toEqual(['area']);
  });

  it('with nothing typed, lists the recent ones first', () => {
    expect(rank(commands, ' ', ['view', 'band']).map((c) => c.id)).toEqual(['view', 'band', 'area', 'save']);
  });
});
