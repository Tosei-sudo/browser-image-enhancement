import { describe, expect, it } from 'vitest';
import { isProjectName, matchFile, matchLayers, projectName, PROJECT_FORMAT, readProject, writeProject, type Project } from '../src/project-file.js';

const project: Project = {
  format: PROJECT_FORMAT,
  version: 1,
  id: 'p1',
  saved: '2026-10-07T00:00:00.000Z',
  baseMap: 'gsi-std',
  view: { projection: 'EPSG:3857', center: [15550000, 4250000], resolution: 2.5, rotation: 0.1 },
  fileSets: [{ files: [{ name: 'roads.shp', size: 100, lastModified: 1 }, { name: 'roads.dbf', size: 50, lastModified: 1 }] }],
  layers: [
    { type: 'service', name: 'roads', source: { kind: 'files', set: 0 }, visible: true, opacity: 0.5, style: { mode: 'single' } as never },
    { type: 'service', name: '標準地図', source: { kind: 'service', ref: { kind: 'wmts', url: 'https://example.com/wmts', layer: 'std', matrixSet: 'g' } }, visible: false, opacity: 1 },
    { type: 'image', name: 'https://example.com/a.tif', source: { kind: 'url', url: 'https://example.com/a.tif' }, visible: true, opacity: 1, pipeline: { version: 1, ops: [{ op: 'brightness', amount: 0.2 }] as never }, bands: [3, 2, 1], draLocked: true },
  ],
  selected: 2,
};

describe('project files', () => {
  it('read back as written', () => {
    const { project: read, skipped } = readProject(writeProject(project));
    expect(skipped).toBe(0);
    expect(read).toEqual(project);
  });

  it('are told apart from other files', () => {
    expect(() => readProject('not json')).toThrow('JSON');
    expect(() => readProject('{"type":"FeatureCollection"}')).toThrow('プロジェクトファイルではありません');
    expect(() => readProject(JSON.stringify({ ...project, version: 2 }))).toThrow('バージョン');
  });

  it('leave out layers they cannot read, and the selection with them', () => {
    const broken = { ...project, layers: [...project.layers, { type: 'image', name: 'x', source: { kind: 'files', set: 5 } }, { type: 'what' }] };
    const { project: read, skipped } = readProject(JSON.stringify(broken));
    expect(skipped).toBe(2);
    expect(read.layers).toHaveLength(3);
    expect(read.selected).toBeNull();
  });

  it('keep opacity in range and default visibility to shown', () => {
    const { project: read } = readProject(JSON.stringify({ ...project, layers: [{ type: 'image', name: 'a', source: { kind: 'url', url: 'u' }, opacity: 4 }] }));
    expect(read.layers[0]).toMatchObject({ visible: true, opacity: 1 });
  });

  it('keep the 3D view and GeoTIFF DEMs', () => {
    const with3d: Project = {
      ...project,
      layers: [...project.layers, { type: 'image', name: 'dem.tif', source: { kind: 'url', url: 'https://example.com/dem.tif' }, visible: true, opacity: 1, dem: true }],
      globe: {
        open: true,
        camera: { lon: 139.7, lat: 35.6, height: 1500, heading: 10, pitch: -35 },
        terrain: true,
        exaggeration: 2,
        heightMode: 'ground',
        natural: false,
        tilesets: [{ url: 'https://example.com/tiles/tileset.json', show: false }],
      },
    };
    expect(readProject(writeProject(with3d)).project).toEqual(with3d);
    // Odd values are tamed; local addresses and broken cameras are left out.
    const odd = JSON.parse(writeProject(with3d)) as Record<string, Record<string, unknown>>;
    odd.globe.exaggeration = 50;
    odd.globe.heightMode = 'up';
    odd.globe.tilesets = [{ url: 'javascript:alert(1)' }, { url: 'https://a.example/t.json' }];
    const read = readProject(JSON.stringify(odd)).project.globe!;
    expect(read).toMatchObject({ exaggeration: 10, heightMode: 'auto', tilesets: [{ url: 'https://a.example/t.json', show: true }] });
    odd.globe.camera = { lon: 'x' };
    expect(readProject(JSON.stringify(odd)).project.globe).toBeUndefined();
  });

  it('are named by their extension', () => {
    expect(isProjectName('調査.IVPROJ')).toBe(true);
    expect(isProjectName('a.json')).toBe(false);
    expect(projectName('調査.ivproj')).toBe('調査');
  });
});

describe('finding a project file again', () => {
  it('prefers the file of the same name and size', () => {
    const files = [
      { name: 'a.tif', size: 1 },
      { name: 'A.tif', size: 2 },
    ];
    expect(matchFile({ name: 'a.tif', size: 2, lastModified: 0 }, files)).toBe(files[1]);
    expect(matchFile({ name: 'a.tif', size: 3, lastModified: 0 }, files)).toBe(files[0]);
    expect(matchFile({ name: 'b.tif', size: 1, lastModified: 0 }, files)).toBeUndefined();
  });

  it('matches the layers a set opens to the saved ones, by type and name', () => {
    const opened = [
      { type: 'service', name: 'roads' },
      { type: 'service', name: 'rivers' },
      { type: 'image', name: 'roads' },
    ];
    expect(matchLayers([{ type: 'image', name: 'roads' }, { type: 'service', name: 'roads' }, { type: 'service', name: 'lakes' }], opened)).toEqual([opened[2], opened[0], null]);
  });
});
