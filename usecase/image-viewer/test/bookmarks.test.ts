import { describe, expect, it } from 'vitest';
import { mergeBookmarks, readBookmarks, readHashView, withHashView, writeHashView } from '../src/bookmarks.js';

describe('the view in the address', () => {
  it('writes and reads lat, lon, zoom and rotation', () => {
    const text = writeHashView({ lat: 35.681236, lon: 139.767125, zoom: 15.234, rotation: -30 });
    expect(text).toBe('view=35.681236,139.767125,15.23,330');
    expect(readHashView(`#${text}`)).toEqual({ lat: 35.681236, lon: 139.767125, zoom: 15.23, rotation: 330 });
  });

  it('leaves out a rotation of nothing', () => {
    expect(writeHashView({ lat: 1, lon: 2, zoom: 3, rotation: 360 })).toBe('view=1,2,3');
    expect(readHashView('#view=1,2,3')).toEqual({ lat: 1, lon: 2, zoom: 3, rotation: 0 });
  });

  it('refuses what is not a view', () => {
    for (const hash of ['', '#', '#view=', '#view=1,2', '#view=a,b,c', '#view=95,0,3', '#view=1,2,3,4,5', '#other=1']) expect(readHashView(hash)).toBeNull();
  });

  it('keeps the other parts of the hash', () => {
    expect(withHashView('#a=1&view=0,0,1', { lat: 1, lon: 2, zoom: 3, rotation: 0 })).toBe('#view=1,2,3&a=1');
    expect(withHashView('#view=0,0,1', null)).toBe('');
    expect(readHashView('#a=1&view=1,2,3')?.zoom).toBe(3);
  });
});

describe('bookmarks', () => {
  const view = { projection: 'EPSG:3857', center: [1, 2], resolution: 3, rotation: 0 };

  it('reads what it can and drops the rest', () => {
    const list = readBookmarks([
      { id: 'a', name: '東京', view, layers: [['x', true], ['y', false], ['bad']] },
      { name: '名前だけ' },
      { id: 'c', name: '解像度なし', view: { ...view, resolution: 0 } },
      { name: 'id なし', view: { projection: 'EPSG:3857', center: [0, 0], resolution: 1 } },
    ]);
    expect(list.map((b) => b.name)).toEqual(['東京', 'id なし']);
    expect(list[0].layers).toEqual([['x', true], ['y', false]]);
    expect(list[1].id).toMatch(/\w/);
    expect(list[1].view.rotation).toBe(0);
    expect(readBookmarks('nope')).toEqual([]);
  });

  it('merges by id, keeping the order', () => {
    const a = { id: 'a', name: 'A', view: { ...view, center: [1, 2] as [number, number] } };
    const b = { id: 'b', name: 'B', view: { ...view, center: [1, 2] as [number, number] } };
    expect(mergeBookmarks([a], [{ ...a, name: 'A2' }, b]).map((x) => x.name)).toEqual(['A', 'B']);
  });
});
