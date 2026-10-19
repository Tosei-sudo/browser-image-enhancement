import { describe, expect, it } from 'vitest';
import { mergeScripts, readScripts } from '../src/script/saved.js';

describe('saved scripts', () => {
  it('read only named scripts with code', () => {
    expect(readScripts([{ name: 'a', code: '1', extra: true }, { name: '', code: '2' }, { name: 'b' }, 'c', null])).toEqual([{ name: 'a', code: '1' }]);
    expect(readScripts({ name: 'a', code: '1' })).toEqual([]);
  });

  it('merge without replacing what is saved', () => {
    const saved = [{ name: 'a', code: '1' }];
    expect(mergeScripts(saved, [{ name: 'a', code: '1' }])).toEqual(saved);
    const merged = mergeScripts(saved, [{ name: 'a', code: '2' }, { name: 'b', code: '3' }]);
    expect(merged).toEqual([{ name: 'a', code: '1' }, { name: 'a (2)', code: '2' }, { name: 'b', code: '3' }]);
    // The same project opened again adds nothing.
    expect(mergeScripts(merged, [{ name: 'a', code: '2' }, { name: 'b', code: '3' }])).toEqual(merged);
    expect(mergeScripts(merged, [{ name: 'a', code: '4' }]).at(-1)).toEqual({ name: 'a (3)', code: '4' });
  });
});
