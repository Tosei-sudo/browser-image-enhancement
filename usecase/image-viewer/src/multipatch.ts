/**
 * Multipatches: the 3D shapes (buildings, bridges, terrain models) of Esri's
 * MultiPatch Shapefiles (shape type 31). Each shape is a set of patches —
 * triangle strips, triangle fans and planar rings with holes — with heights.
 *
 * On the 2D map a multipatch shows as its footprint (the faces that are not
 * walls, seen from above); the 3D view draws its triangles
 * ({@link multiPatchOf} keeps them on the feature).
 */
import type Feature from 'ol/Feature.js';
import earcut from 'earcut';

/** Esri's patch types. */
export const PATCH = { strip: 0, fan: 1, outer: 2, inner: 3, first: 4, ring: 5 } as const;

/** One patch: its type and its points as x, y, z triples. */
export interface Patch {
  type: number;
  xyz: Float64Array;
}

/** The patches of one shape. */
export interface MultiPatch {
  patches: Patch[];
}

/** The MultiPatch shape type of a Shapefile. */
export const MULTIPATCH_SHAPE_TYPE = 31;

/** The shapes of a MultiPatch .shp, in order (null shapes as null). */
export function readMultiPatches(shp: Uint8Array): Array<MultiPatch | null> {
  const view = new DataView(shp.buffer, shp.byteOffset, shp.byteLength);
  if (view.getInt32(32, true) !== MULTIPATCH_SHAPE_TYPE) throw new Error('マルチパッチの Shapefile ではありません');
  const end = Math.min(shp.byteLength, view.getInt32(24, false) * 2);
  const shapes: Array<MultiPatch | null> = [];
  let at = 100;
  while (at + 8 <= end) {
    const length = view.getInt32(at + 4, false) * 2;
    const start = at + 8;
    at = start + length;
    if (length < 4 || at > end) break;
    const type = view.getInt32(start, true);
    if (type !== MULTIPATCH_SHAPE_TYPE) {
      shapes.push(null);
      continue;
    }
    const parts = view.getInt32(start + 36, true);
    const points = view.getInt32(start + 40, true);
    const partsAt = start + 44;
    const typesAt = partsAt + 4 * parts;
    const xyAt = typesAt + 4 * parts;
    const zAt = xyAt + 16 * points + 16;
    if (parts < 0 || points < 0 || zAt + 8 * points > at) {
      shapes.push(null);
      continue;
    }
    const patches: Patch[] = [];
    for (let p = 0; p < parts; p++) {
      const first = view.getInt32(partsAt + 4 * p, true);
      const last = p + 1 < parts ? view.getInt32(partsAt + 4 * (p + 1), true) : points;
      const xyz = new Float64Array(Math.max(0, last - first) * 3);
      for (let i = first; i < last; i++) {
        const o = (i - first) * 3;
        xyz[o] = view.getFloat64(xyAt + 16 * i, true);
        xyz[o + 1] = view.getFloat64(xyAt + 16 * i + 8, true);
        xyz[o + 2] = view.getFloat64(zAt + 8 * i, true);
      }
      patches.push({ type: view.getInt32(typesAt + 4 * p, true), xyz });
    }
    shapes.push({ patches });
  }
  return shapes;
}

/** A shape with every x, y moved by `transform` (e.g. a .prj's CRS to longitude, latitude); heights stay. */
export function transformMultiPatch(shape: MultiPatch, transform: (xy: [number, number]) => number[]): MultiPatch {
  return {
    patches: shape.patches.map(({ type, xyz }) => {
      const out = new Float64Array(xyz.length);
      for (let i = 0; i < xyz.length; i += 3) {
        const [x, y] = transform([xyz[i], xyz[i + 1]]);
        out[i] = x;
        out[i + 1] = y;
        out[i + 2] = xyz[i + 2];
      }
      return { type, xyz: out };
    }),
  };
}

/** A face: an outer ring and its holes (x, y, z triples, not closed twice). */
type Face = Float64Array[];

/** The rings of a shape grouped into faces (outer / first ring, then its inner rings), and its strips and fans as they are. */
function facesOf(shape: MultiPatch): { faces: Face[]; triangles: number[] } {
  const faces: Face[] = [];
  const triangles: number[] = [];
  for (const { type, xyz } of shape.patches) {
    const n = xyz.length / 3;
    const v = (i: number) => [xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]];
    if (type === PATCH.strip) {
      for (let i = 2; i < n; i++) triangles.push(...(i % 2 ? [...v(i - 1), ...v(i - 2), ...v(i)] : [...v(i - 2), ...v(i - 1), ...v(i)]));
    } else if (type === PATCH.fan) {
      for (let i = 2; i < n; i++) triangles.push(...v(0), ...v(i - 1), ...v(i));
    } else if ((type === PATCH.inner || type === PATCH.ring) && faces.length) {
      faces[faces.length - 1].push(openRing(xyz));
    } else {
      faces.push([openRing(xyz)]);
    }
  }
  return { faces, triangles };
}

/** A ring without its closing point. */
function openRing(xyz: Float64Array): Float64Array {
  const n = xyz.length;
  return n >= 6 && xyz[0] === xyz[n - 3] && xyz[1] === xyz[n - 2] && xyz[2] === xyz[n - 1] ? xyz.subarray(0, n - 3) : xyz;
}

/** The normal of a ring by Newell's method (its length is twice the ring's area). */
function newell(ring: Float64Array): [number, number, number] {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const n = ring.length / 3;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [x0, y0, z0] = [ring[i * 3], ring[i * 3 + 1], ring[i * 3 + 2]];
    const [x1, y1, z1] = [ring[j * 3], ring[j * 3 + 1], ring[j * 3 + 2]];
    nx += (y0 - y1) * (z0 + z1);
    ny += (z0 - z1) * (x0 + x1);
    nz += (x0 - x1) * (y0 + y1);
  }
  return [nx, ny, nz];
}

/** Triangles of a planar face with holes: earcut in the plane it faces most (its normal's largest axis dropped). */
function triangulateFace(face: Face, out: number[]): void {
  const [nx, ny, nz] = newell(face[0]);
  const [ax, ay, az] = [Math.abs(nx), Math.abs(ny), Math.abs(nz)];
  const [u, w] = az >= ax && az >= ay ? [0, 1] : ay >= ax ? [2, 0] : [1, 2];
  const flat: number[] = [];
  const holes: number[] = [];
  const all: number[] = [];
  for (const [k, ring] of face.entries()) {
    if (k) holes.push(flat.length / 2);
    for (let i = 0; i < ring.length; i += 3) {
      flat.push(ring[i + u], ring[i + w]);
      all.push(ring[i], ring[i + 1], ring[i + 2]);
    }
  }
  for (const i of earcut(flat, holes.length ? holes : undefined, 2)) out.push(all[i * 3], all[i * 3 + 1], all[i * 3 + 2]);
}

/** Every triangle of a shape as x, y, z triples (nine numbers a triangle). */
export function trianglesOf(shape: MultiPatch): Float64Array {
  const { faces, triangles } = facesOf(shape);
  for (const face of faces) if (face[0].length >= 9) triangulateFace(face, triangles);
  return Float64Array.from(triangles);
}

/** Lowest and highest height of a shape. */
export function heightRange(shape: MultiPatch): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const { xyz } of shape.patches) {
    for (let i = 2; i < xyz.length; i += 3) {
      if (xyz[i] < min) min = xyz[i];
      if (xyz[i] > max) max = xyz[i];
    }
  }
  return [min, max];
}

/**
 * The footprint of a shape as GeoJSON MultiPolygon coordinates: its faces
 * that are not walls (roofs, floors, terrain triangles), seen from above.
 * Faces with the same outline (a floor under its roof) are drawn once.
 */
export function footprintOf(shape: MultiPatch): number[][][][] {
  const { faces, triangles } = facesOf(shape);
  const polygons: number[][][][] = [];
  const seen = new Set<string>();
  const add = (rings: Float64Array[]) => {
    const [nx, ny, nz] = newell(rings[0]);
    if (Math.abs(nz) < 0.1 * Math.hypot(nx, ny, nz) || nz === 0) return;
    const polygon = rings.map((r) => {
      const ring: number[][] = [];
      for (let i = 0; i < r.length; i += 3) ring.push([r[i], r[i + 1]]);
      ring.push(ring[0]);
      return ring;
    });
    const key = JSON.stringify([...polygon[0]].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
    if (seen.has(key)) return;
    seen.add(key);
    polygons.push(polygon);
  };
  for (const face of faces) if (face[0].length >= 9) add(face);
  for (let i = 0; i + 9 <= triangles.length; i += 9) add([Float64Array.from(triangles.slice(i, i + 9))]);
  return polygons;
}

const shapes = new WeakMap<Feature, MultiPatch>();

/** The multipatch (longitude, latitude, height) a feature was read from, if any. */
export function multiPatchOf(feature: Feature): MultiPatch | undefined {
  return shapes.get(feature);
}

/** Keeps a feature's multipatch (longitude, latitude, height) for the 3D view. */
export function setMultiPatch(feature: Feature, shape: MultiPatch): void {
  shapes.set(feature, shape);
}
