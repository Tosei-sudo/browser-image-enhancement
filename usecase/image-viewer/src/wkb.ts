/**
 * Well-known binary (ISO WKB, as GeoPackage geometry blobs hold it) read
 * and written straight from and to OpenLayers' flat coordinates. OpenLayers'
 * own WKB format works point by point through nested arrays, which made
 * reading and writing GeoPackages of many features slow. Z and M are kept
 * (the layouts XYZ, XYM and XYZM), as OpenLayers keeps them; EWKB's flags
 * and SRID are understood when reading.
 */
import type Geometry from 'ol/geom/Geometry.js';
import { GeometryCollection, LineString, MultiLineString, MultiPoint, MultiPolygon, Point, Polygon } from 'ol/geom.js';
import type SimpleGeometry from 'ol/geom/SimpleGeometry.js';
import type { GeometryLayout } from 'ol/geom/Geometry.js';

const TYPES = { Point: 1, LineString: 2, Polygon: 3, MultiPoint: 4, MultiLineString: 5, MultiPolygon: 6, GeometryCollection: 7 } as const;
const LAYOUTS: GeometryLayout[] = ['XY', 'XYZ', 'XYM', 'XYZM'];

/** Reads a WKB geometry at `offset` of `bytes`. */
export function readWkb(bytes: Uint8Array, offset = 0): Geometry {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = offset;

  /** A geometry's header: its type (1–7) and layout. */
  const header = (): { type: number; layout: GeometryLayout; little: boolean } => {
    const little = view.getUint8(at) === 1;
    let code = view.getUint32(at + 1, little);
    at += 5;
    // EWKB: flags in the high bits, and an SRID after the type.
    let z = (code & 0x80000000) !== 0;
    let m = (code & 0x40000000) !== 0;
    if (code & 0x20000000) at += 4;
    code &= 0x0fffffff;
    const dimension = Math.floor(code / 1000);
    if (dimension === 1 || dimension === 3) z = true;
    if (dimension === 2 || dimension === 3) m = true;
    return { type: code % 1000, layout: LAYOUTS[(z ? 1 : 0) + (m ? 2 : 0)], little };
  };
  const strideOf = (layout: GeometryLayout) => layout.length;
  const points = (out: number[], count: number, stride: number, little: boolean) => {
    for (let i = 0, n = count * stride; i < n; i++, at += 8) out.push(view.getFloat64(at, little));
  };
  const rings = (out: number[], ends: number[], stride: number, little: boolean) => {
    const count = view.getUint32(at, little);
    at += 4;
    for (let r = 0; r < count; r++) {
      const n = view.getUint32(at, little);
      at += 4;
      points(out, n, stride, little);
      ends.push(out.length);
    }
  };

  const geometry = (): Geometry => {
    const { type, layout, little } = header();
    const stride = strideOf(layout);
    const flat: number[] = [];
    switch (type) {
      case 1:
        points(flat, 1, stride, little);
        return new Point(flat, layout);
      case 2: {
        const n = view.getUint32(at, little);
        at += 4;
        points(flat, n, stride, little);
        return new LineString(flat, layout);
      }
      case 3: {
        const ends: number[] = [];
        rings(flat, ends, stride, little);
        return new Polygon(flat, layout, ends);
      }
      case 4:
      case 5:
      case 6: {
        const count = view.getUint32(at, little);
        at += 4;
        const ends: number[] = [];
        const endss: number[][] = [];
        let partLayout = layout;
        for (let p = 0; p < count; p++) {
          // Each part has its own header (same layout as the whole, as written).
          const part = header();
          partLayout = part.layout;
          const s = strideOf(part.layout);
          if (type === 4) points(flat, 1, s, part.little);
          else if (type === 5) {
            const n = view.getUint32(at, part.little);
            at += 4;
            points(flat, n, s, part.little);
            ends.push(flat.length);
          } else {
            const polygon: number[] = [];
            rings(flat, polygon, s, part.little);
            endss.push(polygon);
          }
        }
        const l = count ? partLayout : layout;
        if (type === 4) return new MultiPoint(flat, l);
        if (type === 5) return new MultiLineString(flat, l, ends);
        return new MultiPolygon(flat, l, endss);
      }
      case 7: {
        const count = view.getUint32(at, little);
        at += 4;
        const parts: Geometry[] = [];
        for (let p = 0; p < count; p++) parts.push(geometry());
        return new GeometryCollection(parts);
      }
      default:
        throw new Error(`WKB の図形の種類 ${type} は読み込み不可`);
    }
  };
  return geometry();
}

/** The WKB type code of a geometry type in a layout (ISO: +1000 Z, +2000 M, +3000 ZM). */
function code(type: keyof typeof TYPES, layout: GeometryLayout): number {
  return TYPES[type] + 1000 * LAYOUTS.indexOf(layout);
}

/** The bytes a geometry takes as WKB. */
function sizeOf(g: Geometry): number {
  const type = g.getType();
  if (type === 'GeometryCollection') return 9 + (g as GeometryCollection).getGeometriesArray().reduce((n, p) => n + sizeOf(p), 0);
  const s = g as SimpleGeometry;
  const stride = s.getStride();
  const coords = s.getFlatCoordinates().length * 8;
  switch (type) {
    case 'Point':
      return 5 + Math.max(stride * 8, coords);
    case 'LineString':
      return 9 + coords;
    case 'Polygon':
      return 9 + 4 * (g as Polygon).getEnds().length + coords;
    case 'MultiPoint':
      return 9 + (coords / (8 * stride)) * (5 + stride * 8);
    case 'MultiLineString':
      return 9 + (g as MultiLineString).getEnds().length * 9 + coords;
    case 'MultiPolygon': {
      const endss = (g as MultiPolygon).getEndss();
      return 9 + endss.reduce((n, ends) => n + 9 + 4 * ends.length, 0) + coords;
    }
    default:
      throw new Error(`${type} は WKB への書き込み不可`);
  }
}

/** A geometry as little-endian ISO WKB. */
export function writeWkb(geometry: Geometry): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(sizeOf(geometry));
  const view = new DataView(out.buffer);
  let at = 0;
  const head = (type: keyof typeof TYPES, layout: GeometryLayout) => {
    view.setUint8(at, 1);
    view.setUint32(at + 1, code(type, layout), true);
    at += 5;
  };
  const u32 = (n: number) => {
    view.setUint32(at, n, true);
    at += 4;
  };
  const doubles = (flat: number[], from: number, to: number) => {
    for (let i = from; i < to; i++, at += 8) view.setFloat64(at, flat[i], true);
  };
  const write = (g: Geometry): void => {
    const type = g.getType() as keyof typeof TYPES;
    if (type === 'GeometryCollection') {
      const parts = (g as GeometryCollection).getGeometriesArray();
      head(type, 'XY');
      u32(parts.length);
      for (const p of parts) write(p);
      return;
    }
    const s = g as SimpleGeometry;
    const layout = s.getLayout();
    const stride = s.getStride();
    const flat = s.getFlatCoordinates();
    head(type, layout);
    switch (type) {
      case 'Point':
        // An empty point: NaN coordinates, as the standard has it.
        if (flat.length) doubles(flat, 0, stride);
        else for (let i = 0; i < stride; i++, at += 8) view.setFloat64(at, NaN, true);
        return;
      case 'LineString':
        u32(flat.length / stride);
        return doubles(flat, 0, flat.length);
      case 'Polygon': {
        const ends = (g as Polygon).getEnds();
        u32(ends.length);
        let from = 0;
        for (const end of ends) {
          u32((end - from) / stride);
          doubles(flat, from, end);
          from = end;
        }
        return;
      }
      case 'MultiPoint':
        u32(flat.length / stride);
        for (let i = 0; i < flat.length; i += stride) {
          head('Point', layout);
          doubles(flat, i, i + stride);
        }
        return;
      case 'MultiLineString': {
        const ends = (g as MultiLineString).getEnds();
        u32(ends.length);
        let from = 0;
        for (const end of ends) {
          head('LineString', layout);
          u32((end - from) / stride);
          doubles(flat, from, end);
          from = end;
        }
        return;
      }
      case 'MultiPolygon': {
        const endss = (g as MultiPolygon).getEndss();
        u32(endss.length);
        let from = 0;
        for (const ends of endss) {
          head('Polygon', layout);
          u32(ends.length);
          for (const end of ends) {
            u32((end - from) / stride);
            doubles(flat, from, end);
            from = end;
          }
        }
        return;
      }
    }
  };
  write(geometry);
  return out;
}
