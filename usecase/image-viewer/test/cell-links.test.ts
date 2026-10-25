import { describe, expect, it } from 'vitest';
import { linkOf, tabTypeOf } from '../src/cell-links.js';

describe('linkOf', () => {
  it('takes http(s) URLs, opened on the map when the viewer shows them', () => {
    expect(linkOf('https://example.com/report.pdf')).toEqual({ kind: 'url', url: 'https://example.com/report.pdf', viewer: false });
    expect(linkOf(' http://nas-web/img/a.TIF ')).toEqual({ kind: 'url', url: 'http://nas-web/img/a.TIF', viewer: true });
    expect(linkOf('https://host/arcgis/rest/services/x/ImageServer')?.viewer).toBe(true);
    expect(linkOf('https://host/data/roads.geojson?x=1')?.viewer).toBe(true);
    expect(linkOf('https://example.com/')?.viewer).toBe(false);
  });

  it('takes UNC, drive and file:// paths, and POSIX paths under a mapping', () => {
    expect(linkOf('\\\\nas\\img\\a.tif')).toEqual({ kind: 'path', path: '\\\\nas\\img\\a.tif', viewer: true });
    expect(linkOf('Z:\\docs\\写真 1.JPG')).toEqual({ kind: 'path', path: 'Z:\\docs\\写真 1.JPG', viewer: false });
    expect(linkOf('C:/data/roads.shp')?.viewer).toBe(true);
    expect(linkOf('file:///C:/a.pdf')).toEqual({ kind: 'path', path: 'file:///C:/a.pdf', viewer: false });
    expect(linkOf('/mnt/img/a.tif')).toBeNull();
    expect(linkOf('/mnt/img/a.tif', [{ prefix: '/mnt/img', label: 'img' }])?.kind).toBe('path');
  });

  it('leaves other values as text', () => {
    for (const value of ['abc', 'javascript:alert(1)', 'ftp://x/y', 'http://', 'https:// x', 'a\nhttps://x', 'C:', '1/2', '\\\\nas', null, 3, undefined]) {
      expect(linkOf(value)).toBeNull();
    }
  });
});

describe('tabTypeOf', () => {
  it('opens pictures, PDFs and text in a tab, and saves what could run as a page', () => {
    expect(tabTypeOf({ name: 'a.pdf', type: '' })).toBe('application/pdf');
    expect(tabTypeOf({ name: 'a.JPG', type: 'image/jpeg' })).toBe('image/jpeg');
    expect(tabTypeOf({ name: 'a.txt', type: '' })).toBe('text/plain');
    for (const file of [{ name: 'a.html', type: 'text/html' }, { name: 'a.svg', type: 'image/svg+xml' }, { name: 'a.docx', type: '' }]) expect(tabTypeOf(file)).toBeNull();
  });
});
