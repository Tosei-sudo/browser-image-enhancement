import { describe, expect, it } from 'vitest';
import Feature from 'ol/Feature.js';
import type { Field } from '../src/services/index.js';
import { compareValues, defuse, display, localInput, toCsv, toTsv } from '../src/table-text.js';

describe('defuse', () => {
  it('keeps spreadsheet formulas in attribute values from running', () => {
    expect(defuse('=HYPERLINK("http://x","y")')).toBe(`'=HYPERLINK("http://x","y")`);
    expect(defuse('+cmd')).toBe("'+cmd");
    expect(defuse('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(defuse('-1+2')).toBe("'-1+2");
  });

  it('leaves ordinary text and numbers as they are', () => {
    expect(defuse('東京')).toBe('東京');
    expect(defuse('-12.5')).toBe('-12.5');
    expect(defuse('+3')).toBe('+3');
    expect(defuse('1e-3')).toBe('1e-3');
    expect(defuse('')).toBe('');
  });
});

describe('table text', () => {
  const fields = [
    { name: 'name', alias: '名称', type: 'string' },
    { name: 'kind', alias: '種別', type: 'integer', codes: [{ code: 1, name: '道路' }] },
  ] as Field[];
  const rows = [new Feature({ name: 'a,"b"', kind: 1 }), new Feature({ name: '=cmd\tx', kind: null })];

  it('shows domain names, and nothing for null', () => {
    expect(display(fields[1], 1)).toBe('道路');
    expect(display(fields[1], 2)).toBe('2');
    expect(display(fields[0], null)).toBe('');
    expect(display(fields[0], { a: 1 })).toBe('{"a":1}');
  });

  it('writes CSV quoted where needed and TSV on one line per row, formulas defused', () => {
    expect(toCsv(fields, rows)).toBe(['名称,種別', '"a,""b""",道路', "'=cmd\tx,"].join('\r\n'));
    expect(toTsv(fields, rows)).toBe(['名称\t種別', 'a,"b"\t道路', "'=cmd x\t"].join('\n'));
  });

  it('sorts numbers by value, text with numbers in it, and empty last', () => {
    expect([10, null, 9, ''].sort((a, b) => compareValues(a, b))).toEqual([9, 10, null, '']);
    expect(['a10', 'a9'].sort((a, b) => compareValues(a, b))).toEqual(['a9', 'a10']);
  });

  it('formats a time for a datetime-local input in local time', () => {
    expect(localInput(new Date(2026, 0, 2, 3, 4).getTime())).toBe('2026-01-02T03:04');
  });
});
