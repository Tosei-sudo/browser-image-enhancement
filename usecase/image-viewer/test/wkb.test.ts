import { describe, expect, it } from 'vitest';
import WKB from 'ol/format/WKB.js';
import type Geometry from 'ol/geom/Geometry.js';
import { GeometryCollection, LineString, MultiLineString, MultiPoint, MultiPolygon, Point, Polygon } from 'ol/geom.js';
import { readWkb, writeWkb } from '../src/wkb.js';

const ring = (x: number, z = false, m = false) => [[x, 0], [x + 1, 0], [x + 1, 1], [x, 0]].map((p, i) => [...p, ...(z ? [10 + i] : []), ...(m ? [100 + i] : [])]);
function samples(layout: 'XY' | 'XYZ' | 'XYM' | 'XYZM'): Geometry[] {
  const z = layout.includes('Z');
  const m = layout.endsWith('M');
  const pt = (x: number, y: number) => [x, y, ...(z ? [5] : []), ...(m ? [7] : [])];
  return [
    new Point(pt(1, 2), layout),
    new LineString([pt(0, 0), pt(1, 1), pt(2, 0)], layout),
    new Polygon([ring(0, z, m), ring(0.2, z, m)], layout),
    new MultiPoint([pt(0, 0), pt(3, 4)], layout),
    new MultiLineString([[pt(0, 0), pt(1, 1)], [pt(2, 2), pt(3, 3), pt(4, 4)]], layout),
    new MultiPolygon([[ring(0, z, m), ring(0.2, z, m)], [ring(5, z, m)]], layout),
  ];
}

describe('wkb', () => {
  const ol = new WKB({ hex: false, ewkb: false });
  for (const layout of ['XY', 'XYZ', 'XYM', 'XYZM'] as const) {
    it(`writes the bytes OpenLayers writes and reads them back (${layout})`, () => {
      for (const g of samples(layout)) {
        const mine = writeWkb(g);
        expect([...mine]).toEqual([...new Uint8Array(ol.writeGeometry(g) as ArrayBuffer)]);
        const back = readWkb(mine);
        const theirs = ol.readGeometry(mine) as Geometry;
        expect(back.getType()).toBe(theirs.getType());
        const flat = (x: Geometry) => (x as unknown as { getFlatCoordinates(): number[]; getLayout(): string; getEnds?(): number[]; getEndss?(): number[][] });
        expect(flat(back).getLayout()).toBe(flat(theirs).getLayout());
        expect(flat(back).getFlatCoordinates()).toEqual(flat(theirs).getFlatCoordinates());
        expect(flat(back).getEnds?.()).toEqual(flat(theirs).getEnds?.());
        expect(flat(back).getEndss?.()).toEqual(flat(theirs).getEndss?.());
      }
    });
  }

  it('reads collections and big-endian EWKB', () => {
    const collection = new GeometryCollection([new Point([1, 2]), new LineString([[0, 0], [1, 1]])]);
    const back = readWkb(writeWkb(collection)) as GeometryCollection;
    expect(back.getGeometries().map((g) => g.getType())).toEqual(['Point', 'LineString']);
    const ewkb = new WKB({ hex: false, ewkb: true, littleEndian: false }).writeGeometry(new Polygon([ring(0, true)], 'XYZ'), { dataProjection: 'EPSG:4326' } as never) as ArrayBuffer;
    const read = readWkb(new Uint8Array(ewkb)) as Polygon;
    expect(read.getLayout()).toBe('XYZ');
    expect(read.getCoordinates()).toEqual([ring(0, true)]);
  });
});
