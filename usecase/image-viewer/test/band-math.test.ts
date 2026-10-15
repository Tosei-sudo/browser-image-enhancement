import { describe, expect, it } from 'vitest';
import { evaluate, ExpressionError, guessRoles, INDEX_PRESETS, onlyVariables, parseExpression, variablesOf } from '../src/band-math.js';
import { bandExpression } from '../src/band-math-dialog.js';
import { makeCalcBlock } from '../src/raster-calc.js';

const bands = ['B1', 'B2', 'B3', 'B4'];
const run = (text: string, inputs: number[][]) => {
  const expr = parseExpression(text, bands.slice(0, Math.max(1, inputs.length)));
  return Array.from(evaluate(expr, inputs.map((v) => Float32Array.from(v)), inputs[0]?.length ?? 1));
};

describe('expressions', () => {
  it('follows the usual precedence', () => {
    expect(run('1 + 2 * 3', [[0]])).toEqual([7]);
    expect(run('(1 + 2) * 3', [[0]])).toEqual([9]);
    expect(run('-2 ^ 2', [[0]])).toEqual([-4]);
    expect(run('2 ^ 3 ^ 2', [[0]])).toEqual([512]);
    expect(run('2 ** 3', [[0]])).toEqual([8]);
    expect(run('10 - 2 - 3', [[0]])).toEqual([5]);
    expect(run('1.5e1 / 3', [[0]])).toEqual([5]);
  });

  it('computes NDVI band by band, NaN for no data and 0/0', () => {
    const out = run('(b2 - B1) / (B2 + B1)', [
      [10, 0, NaN, 3],
      [30, 0, 5, 1],
    ]);
    expect(out[0]).toBeCloseTo(0.5);
    expect(out[1]).toBeNaN();
    expect(out[2]).toBeNaN();
    expect(out[3]).toBeCloseTo(-0.5);
  });

  it('has comparisons, if and functions', () => {
    expect(run('B1 > 2', [[1, 3]])).toEqual([0, 1]);
    expect(run('if(B1 >= 2, B1 * 10, -1)', [[1, 3]])).toEqual([-1, 30]);
    expect(run('max(B1, 2, 0)', [[1, 3]])).toEqual([2, 3]);
    expect(run('clamp(B1, 0, 2)', [[-1, 3]])).toEqual([0, 2]);
    expect(run('abs(B1) + sqrt(4) + log10(100) + ln(exp(1))', [[-1]])).toEqual([6]);
  });

  it('says what is wrong, and where', () => {
    const fail = (text: string) => {
      try {
        parseExpression(text, bands);
      } catch (error) {
        return error as ExpressionError;
      }
      throw new Error('parsed');
    };
    expect(fail('B5').message).toContain('B5');
    expect(fail('B1 +').message).toContain('途中');
    expect(fail('(B1').message).toContain(')');
    expect(fail('foo(B1)').message).toContain('foo');
    expect(fail('max(B1)').message).toContain('2〜8');
    expect(fail('B1 $ 2').at).toBe(3);
    expect(fail('').message).toContain('入力');
  });

  it('lists and renumbers the variables used', () => {
    const expr = parseExpression('(B4 - B3) / (B4 + B3)', bands);
    expect(variablesOf(expr)).toEqual([2, 3]);
    const only = onlyVariables(expr, [2, 3]);
    expect(Array.from(evaluate(only, [Float32Array.of(1), Float32Array.of(3)], 1))[0]).toBeCloseTo(0.5);
  });
});

describe('indices', () => {
  it('guesses bands from names, else the usual order', () => {
    expect(guessRoles(['NIR', 'Red'], 4)).toEqual([3, 2]);
    expect(guessRoles(['NIR', 'Red'], 3)).toEqual([null, 0]);
    expect(guessRoles(['NIR', 'Red'], 5, ['Coastal', 'Blue', 'Green', 'Red', 'NIR'])).toEqual([4, 3]);
    expect(guessRoles(['SWIR', 'NIR'], 6, ['B', 'G', 'R', 'Red Edge', 'Near Infrared', 'SWIR1'])).toEqual([5, 4]);
    expect(guessRoles(['NIR', 'Red'], 1)).toEqual([null, null]);
  });

  it('writes an index over band names', () => {
    const ndvi = INDEX_PRESETS.find((p) => p.id === 'ndvi')!;
    expect(bandExpression(ndvi, [3, 2])).toBe('(B4 - B3) / (B4 + B3)');
    expect(bandExpression(ndvi, [3, null])).toBeNull();
    for (const p of INDEX_PRESETS) expect(() => parseExpression(p.expression, p.roles.map((r) => r.name))).not.toThrow();
  });
});

describe('a block of a calculation', () => {
  it('evaluates over inputs looked up through their meshes, and cuts tiles', () => {
    // 2 × 2 output pixels, each input read 1:1 (the mesh maps pixel to pixel).
    const mesh = Float64Array.of(0.5, 0.5, 32.5, 0.5, 0.5, 32.5, 32.5, 32.5);
    const read = (data: number[]) => ({ data: Float32Array.from(data), width: 2, height: 2, window: [0, 0, 2, 2] as const, noData: null, mesh, cols: 2, rows: 2 });
    const expr = parseExpression('B1 - B2', ['B1', 'B2']);
    const block = makeCalcBlock({ width: 2, height: 2, inputs: [read([5, 6, 7, NaN]), read([1, 1, 1, 1])], expr, resample: 'nearest', tileSize: 16, tx0: 0, ty0: 0 });
    expect([block.min, block.max, block.covered]).toEqual([4, 6, 3]);
    expect(block.tiles).toHaveLength(1);
    const tile = new Float32Array(block.tiles[0].bytes.buffer);
    expect(Array.from(tile.slice(0, 2))).toEqual([4, 5]);
    expect(tile[16]).toBe(6);
    expect(tile[17]).toBeNaN();
  });
});
