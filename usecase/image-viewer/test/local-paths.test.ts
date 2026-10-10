import { describe, expect, it } from 'vitest';
import { isSidecar, mappingFor, pathMappingOf, pathParts, urlFor } from '../src/local-paths.js';
import { parseConfig } from '../src/config.js';

describe('pathParts', () => {
  it('reads UNC, drive, POSIX and file:// paths', () => {
    expect(pathParts('\\\\NAS\\img\\a.tif')).toEqual(['//nas', 'img', 'a.tif']);
    expect(pathParts('//nas/img//./a.tif')).toEqual(['//nas', 'img', 'a.tif']);
    expect(pathParts('C:\\Data\\a.tif')).toEqual(['c:', 'Data', 'a.tif']);
    expect(pathParts('/mnt/img/a.tif')).toEqual(['/', 'mnt', 'img', 'a.tif']);
    expect(pathParts('file:///C:/Data/a%20b.tif')).toEqual(['c:', 'Data', 'a b.tif']);
    expect(pathParts('file://nas/img/a.tif')).toEqual(['//nas', 'img', 'a.tif']);
    expect(pathParts('file:///mnt/a.tif')).toEqual(['/', 'mnt', 'a.tif']);
  });
});

describe('mappingFor', () => {
  const mappings = [
    { prefix: '\\\\nas\\img', label: 'NAS' },
    { prefix: '\\\\nas\\img\\cog', label: 'COG', url: 'https://nas-web/cog/' },
    { prefix: 'Z:\\', label: 'Z' },
  ];

  it('takes the longest prefix, ignoring case and slashes', () => {
    expect(mappingFor(mappings, '\\\\NAS\\IMG\\2026\\a.tif')).toEqual({ mapping: mappings[0], rest: ['2026', 'a.tif'] });
    expect(mappingFor(mappings, '//nas/img/cog/a b.tif')).toEqual({ mapping: mappings[1], rest: ['a b.tif'] });
    expect(mappingFor(mappings, 'z:/x/a.tif')).toEqual({ mapping: mappings[2], rest: ['x', 'a.tif'] });
    expect(mappingFor(mappings, '\\\\nas\\imgs\\a.tif')).toBeNull();
    expect(mappingFor(mappings, '\\\\nas\\img')).toBeNull();
  });

  it('builds URLs from the rest of the path', () => {
    expect(urlFor({ prefix: 'x', label: 'x', url: 'https://nas-web/cog/' }, ['2026', 'a b#.tif'])).toBe('https://nas-web/cog/2026/a%20b%23.tif');
  });
});

describe('pathMappingOf', () => {
  it('needs a prefix and an http(s) url when one is given', () => {
    const problems: string[] = [];
    expect(pathMappingOf({ prefix: '\\\\nas\\img' }, problems, 0)).toEqual({ prefix: '\\\\nas\\img', label: '\\\\nas\\img' });
    expect(pathMappingOf({ prefix: '' }, problems, 1)).toBeNull();
    expect(pathMappingOf({ prefix: 'Z:', url: 'ftp://x' }, problems, 2)).toBeNull();
    expect(problems).toHaveLength(2);
    expect(parseConfig({ pathMappings: [{ prefix: 'Z:', label: 'Z', url: './z/' }] }).config.pathMappings).toEqual([{ prefix: 'Z:', label: 'Z', url: './z/' }]);
  });
});

describe('isSidecar', () => {
  it('takes the .ovr, RPC and IMD files of an image', () => {
    for (const name of ['A.tif.ovr', 'a.ovr', 'a.RPB', 'a_rpc.txt', 'A.IMD']) expect(isSidecar(name, 'a.TIF')).toBe(true);
    for (const name of ['a.tif', 'a.jpg', 'ab.ovr', 'b.rpb']) expect(isSidecar(name, 'a.tif')).toBe(false);
  });
});
