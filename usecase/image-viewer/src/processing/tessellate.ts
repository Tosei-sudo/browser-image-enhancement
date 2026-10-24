/**
 * 格子の敷き詰め (QGIS "Create grid"): squares, hexagons or triangles of a
 * chosen size laid over an area, as a polygon layer.
 *
 * The cells are laid out on a plane, either
 * - geodesic: the azimuthal equidistant projection on the WGS 84 ellipsoid
 *   centred on the area (or on a chosen point), sizes in metres on the
 *   ground — exact at the centre, stretching slowly away from it (no plane
 *   tiles an ellipsoid exactly; the stretch is reported when it matters), or
 * - a CRS: the plane of any projection (plane rectangular zones, UTM…),
 *   sizes in its units (degrees for longitude / latitude), so the cells line
 *   up with that CRS's own grid and are written in it.
 *
 * Cells can be turned, started from the area's corner or centre, the CRS's
 * origin or a given point, and kept whole, cut to the area, or chosen by
 * whether they touch it, lie inside it or have their centre in it.
 */
import Feature from 'ol/Feature.js';
import type Geometry from 'ol/geom/Geometry.js';
import Polygon from 'ol/geom/Polygon.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import GeometryCollection from 'ol/geom/GeometryCollection.js';
import { getTransform, get as getProjection, toLonLat } from 'ol/proj.js';
import type { LonLat } from '../coordinates.js';
import { geodesicArea } from '../geodesic.js';
import type { TargetCrs } from '../vector-write.js';
import { aeqd, field, type ProcessingResult } from './common.js';
import { fromJsts, intersection, toJsts, union, type JstsGeometry } from './jsts.js';

export type CellShape = 'square' | 'hexagon' | 'triangle';

/** Which cells are kept, and how. */
export type ClipMode =
  /** Every cell touching the area, whole. */
  | 'intersects'
  /** Cells touching the area, cut to its shape. */
  | 'clip'
  /** Only cells wholly inside the area. */
  | 'within'
  /** Cells whose centre is inside the area, whole. */
  | 'center';

/** Where the lattice starts. */
export type GridOrigin =
  /** The area's lower left corner (in the grid's direction). */
  | 'corner'
  /** A cell centred on the area's centre. */
  | 'center'
  /** The CRS's own origin (0, 0), so grids of the same size line up between runs. */
  | 'crs'
  /** A given longitude / latitude (geodesic grids are also centred there). */
  | 'point';

export interface TessellateOptions {
  shape: CellShape;
  /** Side length of a cell, in metres (geodesic) or the CRS's units. */
  size: number;
  /** The plane the cells are laid on: geodesic (null) or a CRS. */
  crs?: TargetCrs | null;
  /** Turn of the grid, degrees clockwise. */
  rotation?: number;
  /** Hexagons with a flat side up (`flat`) or a corner up (`pointy`). */
  orientation?: 'flat' | 'pointy';
  origin?: GridOrigin;
  /** With origin `point`. */
  point?: LonLat;
  clip?: ClipMode;
  /** Refuses more cells than this (the page would grind). */
  maxCells?: number;
  title?: string;
}

const SQRT3 = Math.sqrt(3);

/** Cell area for a side `a`. */
export function cellArea(shape: CellShape, a: number): number {
  return shape === 'square' ? a * a : shape === 'hexagon' ? ((3 * SQRT3) / 2) * a * a : (SQRT3 / 4) * a * a;
}

/** Distance across a cell (between opposite sides; a triangle's height) for a side `a`. */
export function cellWidth(shape: CellShape, a: number): number {
  return shape === 'square' ? a : shape === 'hexagon' ? SQRT3 * a : (SQRT3 / 2) * a;
}

/** The side length that gives a cell of area `area`. */
export function sideForArea(shape: CellShape, area: number): number {
  return Math.sqrt(area / cellArea(shape, 1));
}

/** The side length that gives a cell `width` across. */
export function sideForWidth(shape: CellShape, width: number): number {
  return width / cellWidth(shape, 1);
}

/** Spreadsheet-like column letters: 0 → A, 25 → Z, 26 → AA. */
export function columnLetters(index: number): string {
  let out = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
}

type XY = [number, number];
type Ring = XY[];

/** A cell laid out on the grid's own axes: its outline, centre and lattice position. */
interface Cell {
  ring: Ring;
  center: XY;
  row: number;
  col: number;
}

/**
 * The cells of `shape` (side `a`) covering the box [x0, y0, x1, y1] of the
 * grid's own frame, whose lattice has a cell corner (squares, triangles) or
 * a cell centre (hexagons) at the frame's origin.
 */
function* cellsOver(shape: CellShape, a: number, box: number[], orientation: 'flat' | 'pointy'): Generator<Cell> {
  const [x0, y0, x1, y1] = box;
  if (shape === 'square') {
    for (let r = Math.floor(y0 / a); r * a < y1; r++) {
      for (let c = Math.floor(x0 / a); c * a < x1; c++) {
        const x = c * a;
        const y = r * a;
        yield { ring: [[x, y], [x + a, y], [x + a, y + a], [x, y + a], [x, y]], center: [x + a / 2, y + a / 2], row: r, col: c };
      }
    }
  } else if (shape === 'triangle') {
    // Rows of height h, triangles pointing up and down in turn along each.
    const h = (SQRT3 / 2) * a;
    const half = a / 2;
    for (let r = Math.floor(y0 / h); r * h < y1; r++) {
      const y = r * h;
      for (let k = Math.floor(x0 / half) - 1; k * half < x1; k++) {
        const x = k * half;
        const up = (((k + r) % 2) + 2) % 2 === 0;
        const ring: Ring = up
          ? [[x, y], [x + a, y], [x + half, y + h], [x, y]]
          : [[x, y + h], [x + half, y], [x + a, y + h], [x, y + h]];
        yield { ring, center: [x + half, up ? y + h / 3 : y + (2 * h) / 3], row: r, col: k };
      }
    }
  } else {
    // Flat-topped columns 1.5a apart, every other one half a cell up; a corner-up grid is the same with x and y swapped.
    const pointy = orientation === 'pointy';
    const [u0, v0, u1, v1] = pointy ? [y0, x0, y1, x1] : [x0, y0, x1, y1];
    const step = 1.5 * a;
    const tall = SQRT3 * a;
    for (let c = Math.floor((u0 - a) / step); c * step - a < u1; c++) {
      const shift = ((c % 2) + 2) % 2 === 1 ? tall / 2 : 0;
      for (let r = Math.floor((v0 - shift - tall / 2) / tall); r * tall + shift - tall / 2 < v1; r++) {
        const cu = c * step;
        const cv = r * tall + shift;
        const ring: Ring = [];
        for (let i = 0; i <= 6; i++) {
          const angle = ((i % 6) * Math.PI) / 3;
          ring.push([cu + a * Math.cos(angle), cv + a * Math.sin(angle)]);
        }
        if (pointy) {
          // Swapped back (and reversed, to keep the ring counter-clockwise): rows run along x.
          yield { ring: ring.map(([u, v]): XY => [v, u]).reverse(), center: [cv, cu], row: c, col: r };
        } else yield { ring, center: [cu, cv], row: r, col: c };
      }
    }
  }
}

/** Which side of the area a cell is on. */
type Relation = 'outside' | 'inside' | 'crossing';

/**
 * The area's rings on the plane, with their edges sorted into horizontal
 * bands, for quick point-in-area and edge-crossing tests of many cells.
 */
class RangeIndex {
  private readonly edges: Float64Array;
  private readonly bands: number[][];
  private readonly y0: number;
  private readonly bandHeight: number;
  private readonly rings: Array<{ ring: Ring; box: number[] }>;
  readonly box: number[];

  constructor(rings: Ring[]) {
    const edges: number[] = [];
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    this.rings = rings.map((ring) => {
      const b = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < ring.length; i++) {
        const [x, y] = ring[i];
        b[0] = Math.min(b[0], x);
        b[1] = Math.min(b[1], y);
        b[2] = Math.max(b[2], x);
        b[3] = Math.max(b[3], y);
        if (i) edges.push(ring[i - 1][0], ring[i - 1][1], x, y);
      }
      box[0] = Math.min(box[0], b[0]);
      box[1] = Math.min(box[1], b[1]);
      box[2] = Math.max(box[2], b[2]);
      box[3] = Math.max(box[3], b[3]);
      return { ring, box: b };
    });
    this.box = box;
    this.edges = Float64Array.from(edges);
    const count = Math.max(1, Math.min(4096, Math.ceil(edges.length / 4 / 4)));
    this.y0 = box[1];
    this.bandHeight = (box[3] - box[1]) / count || 1;
    this.bands = Array.from({ length: count }, () => []);
    for (let e = 0; e < this.edges.length; e += 4) {
      const [a, b] = this.bandsOf(Math.min(this.edges[e + 1], this.edges[e + 3]), Math.max(this.edges[e + 1], this.edges[e + 3]));
      for (let k = a; k <= b; k++) this.bands[k].push(e);
    }
  }

  private bandsOf(minY: number, maxY: number): [number, number] {
    const last = this.bands.length - 1;
    const clamp = (k: number) => Math.max(0, Math.min(last, k));
    return [clamp(Math.floor((minY - this.y0) / this.bandHeight)), clamp(Math.floor((maxY - this.y0) / this.bandHeight))];
  }

  /** Whether `p` is inside the area (even-odd, so holes are out). */
  inside([px, py]: XY): boolean {
    if (px < this.box[0] || px > this.box[2] || py < this.box[1] || py > this.box[3]) return false;
    const [k] = this.bandsOf(py, py);
    const e = this.edges;
    let inside = false;
    for (const i of this.bands[k]) {
      const ay = e[i + 1];
      const by = e[i + 3];
      if (ay > py !== by > py && px < e[i] + ((py - ay) * (e[i + 2] - e[i])) / (by - ay)) inside = !inside;
    }
    return inside;
  }

  /** How the closed `ring` (a convex cell) lies against the area. */
  relate(ring: Ring): Relation {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (maxX <= this.box[0] || minX >= this.box[2] || maxY <= this.box[1] || minY >= this.box[3]) return 'outside';
    // An edge of the area crossing the cell's edges.
    const e = this.edges;
    const [a, b] = this.bandsOf(minY, maxY);
    const seen = new Set<number>();
    for (let k = a; k <= b; k++) {
      for (const i of this.bands[k]) {
        if (seen.has(i)) continue;
        seen.add(i);
        const x1 = e[i], y1 = e[i + 1], x2 = e[i + 2], y2 = e[i + 3];
        if (Math.max(x1, x2) <= minX || Math.min(x1, x2) >= maxX || Math.max(y1, y2) <= minY || Math.min(y1, y2) >= maxY) continue;
        for (let j = 1; j < ring.length; j++) if (crosses(ring[j - 1], ring[j], x1, y1, x2, y2)) return 'crossing';
      }
    }
    // No crossing: the cell is wholly in or out (judged by its middle), unless a ring of the area (an island, a hole) lies inside it.
    let cx = 0, cy = 0;
    for (let j = 1; j < ring.length; j++) {
      cx += ring[j][0];
      cy += ring[j][1];
    }
    const middle: XY = [cx / (ring.length - 1), cy / (ring.length - 1)];
    const within = this.inside(middle);
    for (const r of this.rings) {
      if (r.box[0] >= minX && r.box[2] <= maxX && r.box[1] >= minY && r.box[3] <= maxY && r.ring.some((v) => insideConvex(v, ring))) return 'crossing';
    }
    return within ? 'inside' : 'outside';
  }
}

/** Whether segment p–q and segment (x1, y1)–(x2, y2) cross (touching ends and lying along each other do not count). */
function crosses(p: XY, q: XY, x1: number, y1: number, x2: number, y2: number): boolean {
  const d1 = (q[0] - p[0]) * (y1 - p[1]) - (q[1] - p[1]) * (x1 - p[0]);
  const d2 = (q[0] - p[0]) * (y2 - p[1]) - (q[1] - p[1]) * (x2 - p[0]);
  const d3 = (x2 - x1) * (p[1] - y1) - (y2 - y1) * (p[0] - x1);
  const d4 = (x2 - x1) * (q[1] - y1) - (y2 - y1) * (q[0] - x1);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Whether `p` is strictly inside the convex closed `ring` (either way round). */
function insideConvex([px, py]: XY, ring: Ring): boolean {
  let sign = 0;
  for (let j = 1; j < ring.length; j++) {
    const [ax, ay] = ring[j - 1];
    const [bx, by] = ring[j];
    const s = Math.sign((bx - ax) * (py - ay) - (by - ay) * (px - ax));
    if (s === 0) return false;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Map (`EPSG:3857`) ↔ the plane the cells are laid on. */
interface Plane {
  toPlane(xy: XY): XY;
  toMap(xy: XY): XY;
  /** Metres on the ground per plane unit, roughly (for splitting long edges). */
  metres: number;
}

function geodesicPlane(center: LonLat): Plane {
  const projection = aeqd(center);
  const forward = getTransform('EPSG:4326', 'EPSG:3857');
  return {
    toPlane: (xy) => projection.forward(toLonLat(xy) as LonLat),
    toMap: (xy) => forward(projection.inverse(xy)) as XY,
    metres: 1,
  };
}

function crsPlane(crs: TargetCrs): Plane {
  const to = getTransform('EPSG:3857', crs.projection);
  const from = getTransform(crs.projection, 'EPSG:3857');
  const degrees = getProjection(crs.projection)?.getUnits() === 'degrees';
  return { toPlane: (xy) => to(xy) as XY, toMap: (xy) => from(xy) as XY, metres: degrees ? 111_320 : 1 };
}

/** Whether a CRS (by OpenLayers code) is in degrees, so cell sizes are too. */
export function isDegrees(projection: string): boolean {
  return getProjection(projection)?.getUnits() === 'degrees';
}

/** `ring` with each edge cut into pieces no longer than `step` (so it bends as it should once moved to another plane). */
function densify(ring: Ring, step: number): Ring {
  if (!(step > 0) || !Number.isFinite(step)) return ring;
  const out: Ring = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const [ax, ay] = ring[i - 1];
    const [bx, by] = ring[i];
    const pieces = Math.min(64, Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step)));
    for (let k = 1; k < pieces; k++) out.push([ax + ((bx - ax) * k) / pieces, ay + ((by - ay) * k) / pieces]);
    out.push(ring[i]);
  }
  return out;
}

/** The polygons of a geometry (polygons and multipolygons, inside collections too). */
function polygonsOf(geometry: Geometry): Polygon[] {
  if (geometry instanceof Polygon) return [geometry];
  if (geometry instanceof MultiPolygon) return geometry.getPolygons();
  if (geometry instanceof GeometryCollection) return geometry.getGeometries().flatMap(polygonsOf);
  return [];
}

/** The rings of a geometry in the map's projection, for geodesic areas. */
function lonLatRings(geometry: Geometry): LonLat[][][] {
  return polygonsOf(geometry).map((p) => p.getCoordinates().map((ring) => ring.map((xy) => toLonLat(xy) as LonLat)));
}

/** Mean radius of the WGS 84 ellipsoid (m). */
const EARTH_RADIUS = 6_371_008.8;

/** Area of polygons on the plane (holes taken away). */
function planarArea(geometry: Geometry): number {
  let total = 0;
  for (const polygon of polygonsOf(geometry)) {
    polygon.getCoordinates().forEach((ring, i) => {
      let twice = 0;
      for (let j = 1; j < ring.length; j++) twice += ring[j - 1][0] * ring[j][1] - ring[j][0] * ring[j - 1][1];
      total += (i === 0 ? 1 : -1) * Math.abs(twice / 2);
    });
  }
  return total;
}

/** Geodesic area (m²) of polygons given as longitude / latitude rings (holes taken away). */
function areaOf(polygons: LonLat[][][]): number {
  let total = 0;
  for (const [outer, ...holes] of polygons) {
    total += geodesicArea(outer.slice(0, -1)).area;
    for (const hole of holes) total -= geodesicArea(hole.slice(0, -1)).area;
  }
  return total;
}

/**
 * Lays cells over `area` (polygons in `EPSG:3857`; anything else counts by
 * its extent) and returns them as a temporary layer: `id`, `row` and `col`
 * (counted from the top left, from 1), `label` (`A1`, column letters and row
 * number) and `area_m2` (on the ellipsoid, of the cell as kept).
 */
export function tessellate(area: Geometry[], options: TessellateOptions): ProcessingResult {
  const { shape, size, crs = null, rotation = 0, orientation = 'flat', origin = 'corner', clip = 'intersects', maxCells = 200_000 } = options;
  if (!(size > 0) || !Number.isFinite(size)) throw new Error('セルの大きさを正の数で入力');
  const polygons = area.flatMap((g) => {
    const own = polygonsOf(g);
    if (own.length) return own;
    const e = g.getExtent();
    return Number.isFinite(e[0]) && e[2] > e[0] && e[3] > e[1] ? [new Polygon([[[e[0], e[1]], [e[2], e[1]], [e[2], e[3]], [e[0], e[3]], [e[0], e[1]]]])] : [];
  });
  if (!polygons.length) throw new Error('範囲なし（広がりのある範囲を選択）');
  if (origin === 'point' && !options.point) throw new Error('基準点（経度,緯度）を入力');
  if (origin === 'crs' && !crs) throw new Error('「座標系の原点」は投影法での敷き詰め時のみ使用可能');

  // The plane: geodesic grids are centred on the area (or the given point).
  const extent = polygons.reduce((e, p) => {
    const [a, b, c, d] = p.getExtent();
    return [Math.min(e[0], a), Math.min(e[1], b), Math.max(e[2], c), Math.max(e[3], d)];
  }, [Infinity, Infinity, -Infinity, -Infinity]);
  const mapCenter = toLonLat([(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2]) as LonLat;
  const plane = crs ? crsPlane(crs) : geodesicPlane(origin === 'point' ? options.point! : mapCenter);

  // The area on the plane, its edges cut short enough to bend with the projection.
  const mapStep = Math.max(extent[2] - extent[0], extent[3] - extent[1]) / 256;
  const toPlaneRing = (ring: number[][]) => densify(ring as Ring, mapStep).map((xy) => plane.toPlane(xy));
  const planePolygons = polygons.map((p) => new Polygon(p.getCoordinates().map(toPlaneRing)));
  if (planePolygons.some((p) => !p.getFlatCoordinates().every(Number.isFinite))) throw new Error('範囲をこの座標系で表現不可（座標系の範囲外）');
  const rangeGeometry: JstsGeometry = union(planePolygons.map(toJsts));
  if (rangeGeometry.isEmpty() || !(rangeGeometry.getArea() > 0)) throw new Error('範囲に面積なし');
  const range = new RangeIndex(polygonsOf(fromJsts(rangeGeometry)!).flatMap((p) => p.getCoordinates() as Ring[]));

  // The grid's own frame: turned by `rotation` (clockwise) about the lattice origin.
  const theta = (rotation * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const turn = ([x, y]: XY): XY => [x * cos - y * sin, x * sin + y * cos]; // plane → frame
  const unturn = ([x, y]: XY): XY => [x * cos + y * sin, -x * sin + y * cos]; // frame → plane
  const coords: XY[] = (rangeGeometry.getCoordinates() as Array<{ x: number; y: number }>).map((c) => [c.x, c.y]);
  const frameBox = (o: XY) =>
    coords.reduce(
      (b, p) => {
        const [x, y] = turn([p[0] - o[0], p[1] - o[1]]);
        return [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
      },
      [Infinity, Infinity, -Infinity, -Infinity],
    );

  let o: XY;
  if (origin === 'crs') o = [0, 0];
  else if (origin === 'point') o = crs ? plane.toPlane(getTransform('EPSG:4326', 'EPSG:3857')(options.point!) as XY) : [0, 0];
  else {
    const box = frameBox([0, 0]);
    const corner = unturn([box[0], box[1]]);
    const middle = unturn([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]);
    if (origin === 'corner') o = corner;
    else {
      // A cell centred there: shift the lattice from its corner (or a hexagon's centre) by the cell's own centre.
      const offset: XY = shape === 'square' ? [size / 2, size / 2] : shape === 'triangle' ? [size / 2, (SQRT3 / 6) * size] : [0, 0];
      const [dx, dy] = unturn(offset);
      o = [middle[0] - dx, middle[1] - dy];
    }
  }
  if (!o.every(Number.isFinite)) throw new Error('基準点をこの座標系で表現不可');
  const box = frameBox(o);

  // Refuse grids the page cannot hold, before making any cell.
  const one = cellArea(shape, size);
  const expected = rangeGeometry.getArea() / one;
  const spanned = ((box[2] - box[0] + 2 * size) * (box[3] - box[1] + 2 * size)) / one;
  if (expected > maxCells || spanned > maxCells * 50) {
    throw new Error(`セルが多すぎ（約 ${Math.round(Math.max(expected, 1)).toLocaleString()} 個、上限 ${maxCells.toLocaleString()} 個）。大きさを大きくするか範囲の縮小が必要`);
  }

  // Edges long on the ground are split so they curve as they should on the map.
  const edgeStep = 10_000 / plane.metres;
  const kept: Array<{ cell: Cell; geometry: Geometry; area: number }> = [];
  for (const cell of cellsOver(shape, size, box, orientation)) {
    const ring = cell.ring.map((p) => {
      const [x, y] = unturn(p);
      return [x + o[0], y + o[1]] as XY;
    });
    let shapeOnPlane: Geometry | null = null;
    if (clip === 'center') {
      const [cx, cy] = unturn(cell.center);
      if (!range.inside([cx + o[0], cy + o[1]])) continue;
    } else {
      const relation = range.relate(ring);
      if (relation === 'outside' || (clip === 'within' && relation !== 'inside')) continue;
      if (clip === 'clip' && relation === 'crossing') {
        const cut = intersection(rangeGeometry, toJsts(new Polygon([ring])));
        // Touching the edge only (a line or a point, or a sliver): nothing of the cell is in the area.
        shapeOnPlane = cut.getDimension() === 2 && cut.getArea() > one * 1e-9 ? fromJsts(cut) : null;
        if (!shapeOnPlane || !polygonsOf(shapeOnPlane).length) continue;
      }
    }
    shapeOnPlane ??= new Polygon([ring]);
    // Back to the map, long edges split first.
    const side = size * plane.metres;
    const step = side > 10_000 ? edgeStep : Infinity;
    const onMap = polygonsOf(shapeOnPlane).map((p) => p.getCoordinates().map((r) => densify(r as Ring, step).map((xy) => plane.toMap(xy))));
    const geometry = onMap.length === 1 ? new Polygon(onMap[0]) : new MultiPolygon(onMap);
    if (!geometry.getFlatCoordinates().every(Number.isFinite)) continue;
    // On the equidistant plane, area is true up to the stretch across lines from the centre, (s/R)/sin(s/R) (as exact as the ellipsoid's own, for the cell sizes here).
    let area: number;
    if (crs) area = areaOf(lonLatRings(geometry));
    else {
      const [cx, cy] = unturn(cell.center);
      const angle = Math.hypot(cx + o[0], cy + o[1]) / EARTH_RADIUS;
      area = planarArea(shapeOnPlane) * (angle > 1e-9 ? angle / Math.sin(angle) : 1);
    }
    kept.push({ cell, geometry, area });
  }
  if (kept.length > maxCells) throw new Error(`セルが多すぎ（${kept.length.toLocaleString()} 個、上限 ${maxCells.toLocaleString()} 個）`);

  // Numbered from the top left, row by row.
  const topRow = Math.max(...kept.map((k) => k.cell.row));
  const leftCol = Math.min(...kept.map((k) => k.cell.col));
  kept.sort((a, b) => b.cell.row - a.cell.row || a.cell.col - b.cell.col);
  const features = kept.map(({ cell, geometry, area }, i) => {
    const row = topRow - cell.row + 1;
    const col = cell.col - leftCol + 1;
    const feature = new Feature({ id: i + 1, row, col, label: `${columnLetters(col - 1)}${row}`, area_m2: Math.round(area * 100) / 100 });
    feature.setGeometry(geometry);
    return feature;
  });

  const names: Record<CellShape, string> = { square: '正方形', hexagon: '六角形', triangle: '三角形' };
  const notes = [`${names[shape]}のセル ${features.length.toLocaleString()} 個を作成`];
  if (!crs && features.length) {
    // The equidistant plane is true along lines from its centre; across them it stretches by (s/R)/sin(s/R).
    const reach = Math.max(...coords.map(([x, y]) => Math.hypot(x, y)));
    const angle = reach / EARTH_RADIUS;
    const stretch = angle > 1e-9 ? angle / Math.sin(angle) - 1 : 0;
    if (stretch > 0.001) notes.push(`範囲の端ではセルが中心より約 ${(stretch * 100).toFixed(stretch < 0.01 ? 2 : 1)}% 拡大（中心からの距離が正しい正距方位図法で敷き詰め）`);
  }
  return {
    title: options.title || `格子_${names[shape]}`,
    features,
    fields: [field('id', 'integer'), field('row', 'integer', '行'), field('col', 'integer', '列'), field('label', 'string', 'ラベル'), field('area_m2', 'double', '面積（m²）')],
    crs: crs ?? undefined,
    notes,
    geometryType: features.some((f) => f.getGeometry() instanceof MultiPolygon) ? 'MultiPolygon' : 'Polygon',
  };
}
