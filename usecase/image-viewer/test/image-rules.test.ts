import { describe, expect, it } from 'vitest';
import { fileNameOf } from '../src/image-rules.js';

describe('fileNameOf', () => {
  it('takes the last part of a URL path, without the query', () => {
    expect(fileNameOf('https://example.com/scenes/LC08_B4.TIF?sig=1#x')).toBe('LC08_B4.TIF');
    expect(fileNameOf('/fixture16.tif')).toBe('fixture16.tif');
    expect(fileNameOf('./data/%E7%94%BB%E5%83%8F.tif')).toBe('画像.tif');
  });

  it('keeps a file name as it is', () => {
    expect(fileNameOf('scene #2.tif')).toBe('scene #2.tif');
    expect(fileNameOf('C:\\images\\a.tif')).toBe('a.tif');
  });
});
