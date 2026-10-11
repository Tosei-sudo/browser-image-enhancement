import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import Point from 'ol/geom/Point.js';
import { ascii, dbf, tokyoSjis } from './fixtures.js';
import {
  blobChunks,
  ByteReader,
  dbfTextEncoding,
  forEachShpRecord,
  groupRings,
  listZip,
  parseShape,
  readDbfHeader,
  readDbfRecord,
  recordBox,
  ringArea,
  zipEntryBytes,
  zipEntryChunks,
} from '../src/shp-stream.js';
import { writeShapefile } from '../src/vector-write.js';
import type { Field } from '../src/services/index.js';

const fields: Field[] = [{ name: 'name', alias: 'name', type: 'string', editable: true, nullable: true }];

function feature(geometry: Point | LineString | MultiPolygon, name: string): Feature {
  const f = new Feature(geometry.transform('EPSG:4326', 'EPSG:3857'));
  f.set('name', name);
  return f;
}

/** Chunks of `bytes`, `size` at a time, to cut records anywhere. */
async function* pieces(bytes: Uint8Array, size: number) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

/** A .zip of `files`, deflated. */
function deflatedZip(files: Array<{ name: string; bytes: Uint8Array }>): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = new TextEncoder().encode(f.name);
    const data = deflateRawSync(f.bytes);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, f.bytes.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const c = new Uint8Array(46 + name.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, f.bytes.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    c.set(name, 46);
    parts.push(local, data);
    central.push(c);
    offset += local.length + data.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe('ByteReader', () => {
  it('reads across chunks and says when the file ends', async () => {
    const bytes = Uint8Array.from({ length: 50 }, (_, i) => i);
    const reader = new ByteReader(pieces(bytes, 7));
    expect(Array.from((await reader.read(10))!)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await reader.skip(15);
    expect(Array.from((await reader.read(3))!)).toEqual([25, 26, 27]);
    expect(reader.position).toBe(28);
    await expect(reader.read(30)).rejects.toThrow(/途中/);
    expect(await new ByteReader(pieces(bytes, 7)).skip(50).then(() => 'ok')).toBe('ok');
  });
});

describe('streamed .shp records', () => {
  const [shpFile] = writeShapefile(
    'lines',
    [feature(new LineString([[139.7, 35.6], [139.8, 35.7], [139.9, 35.65]]), 'a'), feature(new LineString([[135.5, 34.6], [135.6, 34.7]]), 'b')],
    fields,
  ).filter((f) => f.name.endsWith('.shp'));

  it('reads every record in order, whatever the chunk size, boxes alone too', async () => {
    for (const size of [5, 64, 1 << 20]) {
      const shapes: number[][] = [];
      await forEachShpRecord(new ByteReader(pieces(shpFile.bytes, size)), (_, content) => void shapes.push(Array.from(parseShape(content).coords)));
      expect(shapes.map((s) => s.length)).toEqual([6, 4]);
      expect(shapes[0][0]).toBeCloseTo(139.7, 9);
      const boxes: number[][] = [];
      await forEachShpRecord(new ByteReader(pieces(shpFile.bytes, size)), (_, content) => void boxes.push(recordBox(content)!), true);
      expect(boxes[1][0]).toBeCloseTo(135.5, 9);
      expect(boxes[1][3]).toBeCloseTo(34.7, 9);
    }
  });

  it('reads points and a multipolygon with a hole, holes grouped with their outer ring', async () => {
    const outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const hole = [[2, 2], [2, 4], [4, 4], [4, 2], [2, 2]];
    const island = [[20, 20], [21, 20], [21, 21], [20, 20]];
    const [polygons] = writeShapefile('p', [feature(new MultiPolygon([[outer, hole], [island]]), 'x')], fields).filter((f) => f.name.endsWith('.shp'));
    const shapes: ReturnType<typeof parseShape>[] = [];
    await forEachShpRecord(new ByteReader(pieces(polygons.bytes, 1000)), (_, c) => void shapes.push(parseShape(c)));
    const grouped = groupRings(shapes[0].coords, shapes[0].ends);
    expect(grouped.polygons).toEqual([2, 1]);
    // Outer rings clockwise (negative area, y up), holes counter-clockwise, like the file.
    expect(ringArea(grouped.coords, 0, grouped.ends[0])).toBeLessThan(0);
    expect(ringArea(grouped.coords, grouped.ends[0], grouped.ends[1])).toBeGreaterThan(0);
    const [points] = writeShapefile('pt', [feature(new Point([139.7, 35.7]), 'p')], fields).filter((f) => f.name.endsWith('.shp'));
    const pts: number[][] = [];
    await forEachShpRecord(new ByteReader(pieces(points.bytes, 1000)), (_, c) => void pts.push(Array.from(parseShape(c).coords)));
    expect(pts[0][0]).toBeCloseTo(139.7, 9);
  });
});

describe('streamed .dbf', () => {
  it('reads the header and records, numbers and dates, in the encoding found', () => {
    const file = dbf(
      [
        { name: 'NAME', length: 10 },
        { name: 'POP', type: 'N', length: 8 },
        { name: 'DAY', type: 'D', length: 8 },
      ],
      [
        [tokyoSjis, ascii('100'), ascii('20240131')],
        [ascii('Osaka'), ascii(''), ascii('')],
      ],
    );
    const header = readDbfHeader(file);
    expect(header.fields.map((f) => f.name)).toEqual(['NAME', 'POP', 'DAY']);
    const records = file.subarray(header.headerLength);
    const encoding = dbfTextEncoding(header.language, records);
    expect(encoding).toBe('shift_jis');
    const decoder = new TextDecoder(encoding);
    const row = (i: number) => readDbfRecord(records.subarray(i * header.recordLength, (i + 1) * header.recordLength), header.fields, decoder);
    expect(row(0)).toEqual(['東京', 100, Date.UTC(2024, 0, 31)]);
    expect(row(1)).toEqual(['Osaka', null, null]);
    expect(dbfTextEncoding(0, records, 'UTF-8')).toBe('utf-8');
  });
});

describe('.zip read in place', () => {
  it('lists entries and reads them stored or deflated, a piece at a time', async () => {
    const big = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7) & 0xff);
    const zip = new Blob([deflatedZip([{ name: '道路/roads.shp', bytes: big }, { name: 'roads.prj', bytes: new TextEncoder().encode('GEOGCS["x"]') }]) as BlobPart]);
    const entries = await listZip(zip);
    expect(entries.map((e) => [e.name, e.size])).toEqual([
      ['道路/roads.shp', 300_000],
      ['roads.prj', 11],
    ]);
    const reader = new ByteReader(await zipEntryChunks(zip, entries[0]));
    await reader.skip(123_456);
    expect((await reader.read(1))![0]).toBe((123_456 * 7) & 0xff);
    expect(new TextDecoder().decode(await zipEntryBytes(zip, entries[1]))).toBe('GEOGCS["x"]');
  });

  it('reads a Blob in slices', async () => {
    const blob = new Blob([new Uint8Array(20).fill(3)]);
    const sizes: number[] = [];
    for await (const chunk of blobChunks(blob, 8)) sizes.push(chunk.length);
    expect(sizes).toEqual([8, 8, 4]);
  });
});
