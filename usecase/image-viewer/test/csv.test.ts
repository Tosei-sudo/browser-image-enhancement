import { describe, expect, it } from 'vitest';
import { decodeCsv, delimiterOf, parseCsv, readCsv } from '../src/csv.js';

const utf8 = (text: string) => new TextEncoder().encode(text);

describe('parseCsv', () => {
  it('reads quoted values with delimiters, doubled quotes and line breaks', () => {
    expect(parseCsv('a,b\n"x,1","say ""hi""\nthere"\r\n3,\n\n')).toEqual([
      ['a', 'b'],
      ['x,1', 'say "hi"\nthere'],
      ['3', ''],
    ]);
  });

  it('skips a BOM and finds tab and semicolon delimiters', () => {
    expect(parseCsv('﻿a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(delimiterOf('a;b;c\n1;2;3')).toBe(';');
    expect(delimiterOf('"a,b";c;d')).toBe(';');
    expect(delimiterOf('single')).toBe(',');
  });
});

describe('decodeCsv', () => {
  it('reads UTF-8, and Shift_JIS when the bytes are not UTF-8', () => {
    expect(decodeCsv(utf8('名前')).encoding).toBe('utf-8');
    // 「東京」 in Shift_JIS.
    const sjis = new Uint8Array([0x93, 0x8c, 0x8b, 0x9e]);
    expect(decodeCsv(sjis)).toEqual({ text: '東京', encoding: 'shift_jis' });
  });
});

describe('readCsv', () => {
  it('types columns by their values and makes one feature per row without geometry', () => {
    const csv = readCsv(utf8('id,name,lat,lon,geometry\n1,東京,35.681236,139.767125,a\n2,,34.70,135.50,b\n'), 'stations');
    expect(csv.fields.map((f) => [f.name, f.type])).toEqual([
      ['id', 'integer'],
      ['name', 'string'],
      ['lat', 'double'],
      ['lon', 'double'],
      ['geometry_', 'string'],
    ]);
    expect(csv.features).toHaveLength(2);
    expect(csv.features[0].getGeometry()).toBeUndefined();
    expect(csv.features[0].get('lat')).toBe(35.681236);
    expect(csv.features[1].get('name')).toBeNull();
    expect(csv.features[1].getId()).toBe(2);
  });

  it('names empty and repeated headers, and reads short rows', () => {
    const csv = readCsv(utf8('a,,a\n1,2\n'), 't');
    expect(csv.fields.map((f) => f.name)).toEqual(['a', 'field_2', 'a_2']);
    expect(csv.features[0].get('a_2')).toBeNull();
  });
});
