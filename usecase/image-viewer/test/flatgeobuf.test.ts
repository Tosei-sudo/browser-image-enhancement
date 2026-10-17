import { describe, expect, it } from 'vitest';
import { ColumnType, isFlatGeobuf, readFlatGeobuf, treeSize, writeFlatGeobuf } from '../src/flatgeobuf.js';

/** Two polygons (one with a hole) written by the flatgeobuf library 4.6.0, with its spatial index. */
const REFERENCE = 'ZmdiA2ZnYgCcAAAAHAAAABgAHAAEAAAADwAAAAAAAAAAAAgAEAAMABgAAAAYAAAAHAAAAAAAAAMCAAAAAAAAAAAAAAACAAAATDEAAAMAAABAAAAAIAAAAAQAAADU////AAAACgQAAAAEAAAAY29kZQAAAADs////AAAACgQAAAADAAAAcG9wAAgADAAIAAcACAAAAAAAAAsEAAAABAAAAG5hbWUAAAAABAEAAAwAAAAIAA4ACAAEAAgAAADQAAAAGAAAAAAAEgAQAAwACAAAAAAAAAAAAAcAEgAAAAAAAAMUAAAABAAAAAIAAAAFAAAACQAAABIAAAAAAAAAAGBhQAAAAAAAgEFAAAAAAACAYUAAAAAAAIBBQAAAAAAAgGFAAAAAAAAAQkAAAAAAAGBhQAAAAAAAAEJAAAAAAABgYUAAAAAAAIBBQGZmZmZmZmFAmpmZmZmZQUDNzMzMzGxhQJqZmZmZmUFAzczMzMxsYUAzMzMzM7NBQGZmZmZmZmFAmpmZmZmZQUAAAAAAIAAAAAAABgAAAOadseS6rAEAAAAAAAAA+D8CAAAAAAAAACpAnAAAAAwAAAAIAA4ACAAEAAgAAABsAAAAGAAAAAAAEgAMAAAACAAAAAAAAAAAAAcAEgAAAAAAAAMEAAAACAAAAAAAAAAAoGFAAAAAAACAQkAAAAAAAMBhQAAAAAAAgEJAAAAAAADAYUAAAAAAAABDQAAAAAAAoGFAAAAAAACAQkAbAAAAAAABAAAAYgEAAAAAAAAAAkACAAAAAAAAABxAAA==';

describe('readFlatGeobuf', () => {
  it('reads a file another writer made, index and all', () => {
    const bytes = Uint8Array.from(atob(REFERENCE), (c) => c.charCodeAt(0));
    expect(isFlatGeobuf(bytes)).toBe(true);
    const file = readFlatGeobuf(bytes);
    expect(file.columns.map((c) => c.name)).toEqual(['name', 'pop', 'code']);
    expect(file.features).toHaveLength(2);
    expect(file.features[0].properties).toEqual({ name: '東京', pop: 1.5, code: 13 });
    expect(file.features[0].geometry).toEqual({
      type: 'Polygon',
      coordinates: [
        [[139, 35], [140, 35], [140, 36], [139, 36], [139, 35]],
        [[139.2, 35.2], [139.4, 35.2], [139.4, 35.4], [139.2, 35.2]],
      ],
    });
    expect(file.features[1].properties.pop).toBe(2.25);
  });
});

describe('writeFlatGeobuf', () => {
  it('reads back what it wrote: every geometry type, attributes of every kind, the CRS', () => {
    const bytes = writeFlatGeobuf({
      name: 'mixed',
      columns: [
        { name: 'name', type: ColumnType.String },
        { name: 'n', type: ColumnType.Double },
        { name: 'k', type: ColumnType.Long },
        { name: 'when', type: ColumnType.DateTime },
      ],
      crs: { org: 'EPSG', code: 6677 },
      features: [
        { geometry: { type: 'Point', coordinates: [1, 2] }, properties: { name: 'あ', n: 0.5, k: -3, when: Date.UTC(2026, 9, 17) } },
        { geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3], [4, 4]]] }, properties: { name: null, n: 2 } },
        { geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[5, 5], [6, 5], [6, 6], [5, 5]]]] }, properties: {} },
        { geometry: null, properties: { k: 9 } },
      ],
    });
    const file = readFlatGeobuf(bytes);
    expect(file.name).toBe('mixed');
    expect(file.crs).toMatchObject({ org: 'EPSG', code: 6677 });
    expect(file.features.map((f) => f.geometry?.type ?? null)).toEqual(['Point', 'MultiLineString', 'MultiPolygon', null]);
    expect(file.features[0].properties).toEqual({ name: 'あ', n: 0.5, k: -3, when: Date.UTC(2026, 9, 17) });
    expect(file.features[1].properties).toEqual({ n: 2 });
    expect(file.features[1].geometry).toEqual({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3], [4, 4]]] });
    expect(file.features[2].geometry).toEqual({ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[5, 5], [6, 5], [6, 6], [5, 5]]]] });
    expect(file.features[3].properties).toEqual({ k: 9 });
  });
});

it('sizes the spatial index as the format does', () => {
  expect(treeSize(2, 16)).toBe(3 * 40);
  expect(treeSize(100, 16)).toBe((100 + 7 + 1) * 40);
  expect(treeSize(5, 0)).toBe(0);
});
