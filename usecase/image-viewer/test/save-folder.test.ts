import { describe, expect, it } from 'vitest';
import { numberedName, savedMessage } from '../src/save-folder.js';

describe('numberedName', () => {
  it('numbers before the extension, as downloads do', () => {
    expect(numberedName('a_view.tif', 0)).toBe('a_view.tif');
    expect(numberedName('a_view.tif', 2)).toBe('a_view (2).tif');
    expect(numberedName('scene.v2.tif', 1)).toBe('scene.v2 (1).tif');
    expect(numberedName('README', 1)).toBe('README (1)');
    expect(numberedName('.hidden', 1)).toBe('.hidden (1)');
  });
});

describe('savedMessage', () => {
  it('says where the file went', () => {
    expect(savedMessage({ name: 'a.tif', folder: 'out' })).toBe('フォルダ「out」に a.tif を保存');
    expect(savedMessage({ name: 'a.tif', folder: null }, '（2 × 2 px）')).toBe('a.tif を保存（2 × 2 px）');
    expect(savedMessage({ name: 'a.tif', folder: null, problem: '書き込みが拒否' })).toContain('ダウンロード: 書き込みが拒否');
  });
});
