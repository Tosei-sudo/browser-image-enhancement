import { describe, expect, it } from 'vitest';
import { defuse } from '../src/table.js';

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
