import { describe, expect, it } from 'vitest';
import { checkWhere, compileWhere, conditionsSql, sqlName } from '../src/sql-where.js';

const fields = [
  { name: 'NAME', type: 'string' },
  { name: 'POP', type: 'integer' },
  { name: 'AREA', type: 'double' },
  { name: 'BUILT', type: 'date' },
  { name: '種別', type: 'string' },
];
const rows: Array<Record<string, unknown>> = [
  { NAME: 'Tokyo', POP: 1400, AREA: 2194.1, BUILT: Date.UTC(2020, 0, 5), 種別: '都' },
  { NAME: 'Osaka', POP: 880, AREA: 1905, BUILT: '2021-06-01', 種別: '府' },
  { NAME: "O'Hare", POP: null, AREA: 30, BUILT: null, 種別: '空港' },
  { NAME: 'Nagoya_1', POP: 230, AREA: 326.5, BUILT: Date.UTC(2019, 11, 31, 23), 種別: '市' },
];
const names = (where: string) => {
  const test = compileWhere(where, fields);
  return rows.filter((r) => test((k) => r[k])).map((r) => r.NAME);
};

describe('compileWhere', () => {
  it('compares numbers, text and joins with AND, OR, NOT and parentheses', () => {
    expect(names('POP > 500')).toEqual(['Tokyo', 'Osaka']);
    expect(names("name = 'Osaka' OR pop < 300")).toEqual(['Osaka', 'Nagoya_1']);
    expect(names('NOT (POP >= 500) AND AREA > 100')).toEqual(['Nagoya_1']);
    expect(names("NAME <> 'Tokyo' AND POP <> 880")).toEqual(['Nagoya_1']);
    expect(names('POP + 20 = 250 OR AREA * 2 = 60')).toEqual(["O'Hare", 'Nagoya_1']);
  });

  it('follows SQL for NULL: unknown is not true, IS NULL finds it', () => {
    expect(names('POP < 10000')).toEqual(['Tokyo', 'Osaka', 'Nagoya_1']);
    expect(names('NOT POP < 10000')).toEqual([]);
    expect(names('POP IS NULL')).toEqual(["O'Hare"]);
    expect(names('POP IS NOT NULL AND POP NOT IN (230, 880)')).toEqual(['Tokyo']);
    expect(names('POP < 10000 OR AREA = 30')).toEqual(['Tokyo', 'Osaka', "O'Hare", 'Nagoya_1']);
  });

  it('matches LIKE with % and _, ESCAPE and NOT LIKE', () => {
    expect(names("NAME LIKE 'O%'")).toEqual(['Osaka', "O'Hare"]);
    expect(names("NAME LIKE '_saka'")).toEqual(['Osaka']);
    expect(names("NAME LIKE '%\\_%' ESCAPE '\\'")).toEqual(['Nagoya_1']);
    expect(names("NAME NOT LIKE '%a%'")).toEqual(['Tokyo']);
    expect(names("NAME = 'O''Hare'")).toEqual(["O'Hare"]);
    expect(names("UPPER(NAME) LIKE '%OSA%'")).toEqual(['Osaka']);
  });

  it('reads IN, BETWEEN, functions and Japanese and quoted field names', () => {
    expect(names("種別 IN ('都', '府')")).toEqual(['Tokyo', 'Osaka']);
    expect(names('AREA BETWEEN 300 AND 2000')).toEqual(['Osaka', 'Nagoya_1']);
    expect(names('AREA NOT BETWEEN 300 AND 2000')).toEqual(['Tokyo', "O'Hare"]);
    expect(names('"POP" = 230 OR [NAME] = \'Tokyo\'')).toEqual(['Tokyo', 'Nagoya_1']);
    expect(names('CHAR_LENGTH(NAME) = 5 AND ROUND(AREA) = 1905')).toEqual(['Osaka']);
    expect(names("SUBSTRING(NAME FROM 1 FOR 2) = 'To'")).toEqual(['Tokyo']);
    expect(names("COALESCE(POP, -1) = -1")).toEqual(["O'Hare"]);
    expect(names('CAST(AREA AS INTEGER) = 326')).toEqual(['Nagoya_1']);
    expect(names("NAME || '!' = 'Tokyo!'")).toEqual(['Tokyo']);
  });

  it('compares date fields (milliseconds or text) with DATE and TIMESTAMP in UTC', () => {
    expect(names("BUILT >= DATE '2020-01-01'")).toEqual(['Tokyo', 'Osaka']);
    expect(names("BUILT < TIMESTAMP '2020-01-01 00:00:00'")).toEqual(['Nagoya_1']);
    expect(names("BUILT > '2021-01-01'")).toEqual(['Osaka']);
    expect(names('EXTRACT(YEAR FROM BUILT) = 2019')).toEqual(['Nagoya_1']);
    expect(names('BUILT < CURRENT_DATE - 365')).toEqual(['Tokyo', 'Osaka', 'Nagoya_1']);
  });

  it('says what is wrong, and where', () => {
    expect(checkWhere('POP >', fields)).toMatch(/文の終わり/);
    expect(checkWhere('WIDTH = 3', fields)).toBe('不明なフィールド: WIDTH');
    expect(checkWhere("NAME = 'x", fields)).toMatch(/閉じ引用符/);
    expect(checkWhere('FOO(NAME) = 1', fields)).toBe('不明な関数: FOO');
    expect(checkWhere("BUILT > DATE '2020/01/01'", fields)).toMatch(/DATE の形式が不正/);
    expect(checkWhere('POP = 1 POP', fields)).toMatch(/AND・OR/);
    expect(checkWhere('', fields)).toBe('条件が空');
    expect(checkWhere('1=1', fields)).toBeNull();
    expect(compileWhere('NAME = 1 AND AREA > 2', fields).fields).toEqual(['NAME', 'AREA']);
  });
});

describe('conditionsSql', () => {
  it('writes the builder conditions as SQL of the field types, which reads back the same', () => {
    const sql = conditionsSql(
      [
        { join: 'AND', field: 'NAME', op: 'contains', value: 'a' },
        { join: 'AND', field: 'POP', op: '>=', value: '500' },
        { join: 'OR', field: '種別', op: 'in', value: '空港、市' },
        { join: 'AND', field: 'BUILT', op: '=', value: '2019-12-31' },
      ],
      fields,
    );
    expect(sql).toBe("NAME LIKE '%a%' AND POP >= 500 OR 種別 IN ('空港', '市') AND (BUILT >= TIMESTAMP '2019-12-31 00:00:00' AND BUILT < TIMESTAMP '2020-01-01 00:00:00')");
    expect(names(sql)).toEqual(['Osaka', 'Nagoya_1']);
    expect(conditionsSql([{ join: 'AND', field: 'NAME', op: 'starts', value: 'Nagoya_' }], fields)).toBe("NAME LIKE 'Nagoya\\_%' ESCAPE '\\'");
    expect(conditionsSql([{ join: 'AND', field: 'POP', op: 'null', value: '' }], fields)).toBe('POP IS NULL');
    expect(sqlName('my field')).toBe('"my field"');
    expect(sqlName('ORDER_NO')).toBe('ORDER_NO');
    expect(sqlName('date')).toBe('"date"');
  });
});
