/**
 * Geometry helpers for vector layers too large for memory (see
 * streamed-shapefile.ts): a packed R-tree over boxes, the Hilbert order that
 * keeps neighbors together, line and polygon simplification, clipping to a
 * box, and a set of grid cells for thinning out shapes smaller than a pixel.
 * Shapes are flat coordinates (x, y…) with part ends, as OpenLayers keeps them.
 */

/** Flat coordinates with the ends of their parts (rings) and, for polygons, the number of rings of each polygon. */
export interface FlatShape {
  coords: Float64Array;
  ends: number[];
  polygons?: number[];
}

/**
 * A static R-tree over boxes given in the order to keep (a Hilbert order
 * makes good nodes), packed in typed arrays like Flatbush: a few bytes a box.
 */
export class PackedRTree {
  private readonly boxes_: Float32Array;
  private readonly ids_: Uint32Array;
  /** Where each level of nodes ends, leaves first. */
  private readonly bounds_: number[];

  /**
   * @param boxes `[minX, minY, maxX, maxY]` of each item, one after another.
   * @param ids The item each box belongs to.
   */
  constructor(
    boxes: Float32Array,
    ids: Uint32Array,
    private readonly nodeSize = 16,
  ) {
    const n = ids.length;
    let total = n;
    let count = n;
    this.bounds_ = [n];
    while (count > 1) {
      count = Math.ceil(count / nodeSize);
      total += count;
      this.bounds_.push(total);
    }
    this.boxes_ = new Float32Array(total * 4);
    this.ids_ = new Uint32Array(total);
    this.boxes_.set(boxes.subarray(0, n * 4));
    this.ids_.set(ids.subarray(0, n));
    let start = 0;
    for (let level = 0; level < this.bounds_.length - 1; level++) {
      const end = this.bounds_[level];
      let parent = end;
      for (let i = start; i < end; i += nodeSize, parent++) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (let c = i; c < Math.min(i + nodeSize, end); c++) {
          minX = Math.min(minX, this.boxes_[c * 4]);
          minY = Math.min(minY, this.boxes_[c * 4 + 1]);
          maxX = Math.max(maxX, this.boxes_[c * 4 + 2]);
          maxY = Math.max(maxY, this.boxes_[c * 4 + 3]);
        }
        this.boxes_.set([minX, minY, maxX, maxY], parent * 4);
        this.ids_[parent] = i;
      }
      start = end;
    }
  }

  get size(): number {
    return this.bounds_[0];
  }

  /** The items whose boxes meet the box, in no particular order. */
  search(minX: number, minY: number, maxX: number, maxY: number, out: number[] = []): number[] {
    const b = this.boxes_;
    const meets = (node: number) => !(b[node * 4] > maxX || b[node * 4 + 1] > maxY || b[node * 4 + 2] < minX || b[node * 4 + 3] < minY);
    const levels = this.bounds_.length;
    if (this.size === 0) return out;
    const root = this.bounds_[levels - 1] - 1;
    if (!meets(root)) return out;
    if (levels === 1) {
      out.push(this.ids_[root]);
      return out;
    }
    const stack = [root, levels - 1];
    while (stack.length) {
      const level = stack.pop()!;
      const node = stack.pop()!;
      const first = this.ids_[node];
      const last = Math.min(first + this.nodeSize, this.bounds_[level - 1]);
      for (let c = first; c < last; c++) {
        if (!meets(c)) continue;
        if (level === 1) out.push(this.ids_[c]);
        else stack.push(c, level - 1);
      }
    }
    return out;
  }
}

/** Position along a Hilbert curve of a point on a 2^order × 2^order grid. */
export function hilbert(x: number, y: number, order = 13): number {
  let d = 0;
  for (let s = 1 << (order - 1); s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const t = x;
      x = y;
      y = t;
    }
  }
  return d;
}

/** Douglas–Peucker over coords[start..end) (flat), marking the points kept in `keep` (by point index). */
function douglasPeucker(coords: ArrayLike<number>, start: number, end: number, tolerance2: number, keep: Uint8Array): void {
  const first = start / 2;
  const last = end / 2 - 1;
  keep[first] = 1;
  keep[last] = 1;
  const stack = [first, last];
  while (stack.length) {
    const b = stack.pop()!;
    const a = stack.pop()!;
    const ax = coords[a * 2];
    const ay = coords[a * 2 + 1];
    const dx = coords[b * 2] - ax;
    const dy = coords[b * 2 + 1] - ay;
    const length2 = dx * dx + dy * dy;
    let worst = 0;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = coords[i * 2] - ax;
      const py = coords[i * 2 + 1] - ay;
      let d2: number;
      if (length2 === 0) d2 = px * px + py * py;
      else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / length2));
        const qx = px - t * dx;
        const qy = py - t * dy;
        d2 = qx * qx + qy * qy;
      }
      if (d2 > worst) {
        worst = d2;
        at = i;
      }
    }
    if (at >= 0 && worst > tolerance2) {
      keep[at] = 1;
      stack.push(a, at, at, b);
    }
  }
}

function partBox(coords: ArrayLike<number>, start: number, end: number): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = start; i < end; i += 2) {
    const x = coords[i];
    const y = coords[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Math.max(maxX - minX, maxY - minY);
}

/**
 * Lines and polygons simplified to `tolerance`: parts smaller than it are
 * left out (polygons with their holes), but never every polygon or line.
 * Points are returned as they are.
 */
export function simplify(kind: number, shape: FlatShape, tolerance: number): FlatShape {
  if (kind === 1 || tolerance <= 0) return shape;
  const { coords, ends } = shape;
  const keep = new Uint8Array(coords.length / 2);
  const tolerance2 = tolerance * tolerance;
  const out: number[] = [];
  const outEnds: number[] = [];
  const polygons: number[] = [];
  const copyKept = (start: number, end: number, ring: boolean): boolean => {
    const before = out.length;
    if (end - start <= 4) {
      for (let i = start; i < end; i++) out.push(coords[i]);
    } else if (ring) {
      // A ring is split in two at its farthest point from the start, so both halves have ends to keep.
      const x0 = coords[start];
      const y0 = coords[start + 1];
      let far = start;
      let worst = -1;
      for (let i = start; i < end; i += 2) {
        const d = (coords[i] - x0) ** 2 + (coords[i + 1] - y0) ** 2;
        if (d > worst) {
          worst = d;
          far = i;
        }
      }
      douglasPeucker(coords, start, far + 2, tolerance2, keep);
      douglasPeucker(coords, far, end, tolerance2, keep);
      for (let i = start; i < end; i += 2) if (keep[i / 2]) out.push(coords[i], coords[i + 1]);
      if (out.length - before < 8) {
        // Too few points to stay a ring: a few points spread round it.
        out.length = before;
        const n = (end - start) / 2;
        for (let k = 0; k < 4; k++) {
          const i = start + Math.floor((k * (n - 1)) / 3) * 2;
          out.push(coords[i], coords[i + 1]);
        }
      }
    } else {
      douglasPeucker(coords, start, end, tolerance2, keep);
      for (let i = start; i < end; i += 2) if (keep[i / 2]) out.push(coords[i], coords[i + 1]);
    }
    if (out.length === before) return false;
    outEnds.push(out.length);
    return true;
  };
  if (kind === 2) {
    let largest = -1;
    let largestSize = -1;
    ends.forEach((end, p) => {
      const start = p ? ends[p - 1] : 0;
      const size = partBox(coords, start, end);
      if (size > largestSize) {
        largestSize = size;
        largest = p;
      }
      if (size >= tolerance) copyKept(start, end, false);
    });
    if (!outEnds.length && largest >= 0) copyKept(largest ? ends[largest - 1] : 0, ends[largest], false);
    return { coords: Float64Array.from(out), ends: outEnds };
  }
  const rings = shape.polygons ?? [ends.length];
  let ring = 0;
  let largest = -1;
  let largestSize = -1;
  rings.forEach((count, p) => {
    const outerStart = ring ? ends[ring - 1] : 0;
    const size = partBox(coords, outerStart, ends[ring]);
    if (size > largestSize) {
      largestSize = size;
      largest = p;
    }
    if (size >= tolerance) {
      let kept = 0;
      for (let r = ring; r < ring + count; r++) {
        const start = r ? ends[r - 1] : 0;
        if (r > ring && partBox(coords, start, ends[r]) < tolerance) continue;
        if (copyKept(start, ends[r], true)) kept++;
      }
      polygons.push(kept);
    }
    ring += count;
  });
  if (!polygons.length && largest >= 0) {
    let r = 0;
    for (let p = 0; p < largest; p++) r += rings[p];
    copyKept(r ? ends[r - 1] : 0, ends[r], true);
    polygons.push(1);
  }
  return { coords: Float64Array.from(out), ends: outEnds, polygons };
}

/** How many points a shape has. */
export const pointCount = (shape: FlatShape) => shape.coords.length / 2;

/**
 * A line or polygon cut to a box (lines may break into more parts, rings are
 * clipped Sutherland–Hodgman style); null when nothing is left.
 */
export function clipToBox(kind: number, shape: FlatShape, box: readonly number[]): FlatShape | null {
  const [minX, minY, maxX, maxY] = box;
  const { coords, ends } = shape;
  if (kind === 1) {
    const out: number[] = [];
    for (let i = 0; i < coords.length; i += 2) {
      if (coords[i] >= minX && coords[i] <= maxX && coords[i + 1] >= minY && coords[i + 1] <= maxY) out.push(coords[i], coords[i + 1]);
    }
    return out.length ? { coords: Float64Array.from(out), ends: [] } : null;
  }
  const out: number[] = [];
  const outEnds: number[] = [];
  if (kind === 2) {
    ends.forEach((end, p) => {
      const start = p ? ends[p - 1] : 0;
      let open = false;
      for (let i = start; i + 2 < end; i += 2) {
        const piece = clipSegment(coords[i], coords[i + 1], coords[i + 2], coords[i + 3], minX, minY, maxX, maxY);
        if (!piece) {
          if (open) {
            outEnds.push(out.length);
            open = false;
          }
          continue;
        }
        if (!open) {
          out.push(piece[0], piece[1]);
          open = true;
        }
        out.push(piece[2], piece[3]);
        // Leaving the box: the part ends here.
        if (piece[2] !== coords[i + 2] || piece[3] !== coords[i + 3]) {
          outEnds.push(out.length);
          open = false;
        }
      }
      if (open) outEnds.push(out.length);
    });
    return outEnds.length ? { coords: Float64Array.from(out), ends: outEnds } : null;
  }
  const polygons: number[] = [];
  const rings = shape.polygons ?? [ends.length];
  let ring = 0;
  for (const count of rings) {
    let kept = 0;
    for (let r = ring; r < ring + count; r++) {
      const clipped = clipRing(coords, r ? ends[r - 1] : 0, ends[r], minX, minY, maxX, maxY);
      if (clipped.length < 8) {
        if (r === ring) break; // the outer ring is gone, and its holes with it
        continue;
      }
      for (const v of clipped) out.push(v);
      outEnds.push(out.length);
      kept++;
    }
    if (kept) polygons.push(kept);
    ring += count;
  }
  return polygons.length ? { coords: Float64Array.from(out), ends: outEnds, polygons } : null;
}

function clipSegment(x0: number, y0: number, x1: number, y1: number, minX: number, minY: number, maxX: number, maxY: number): number[] | null {
  // Liang–Barsky.
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [
    [-dx, x0 - minX],
    [dx, maxX - x0],
    [-dy, y0 - minY],
    [dy, maxY - y0],
  ]) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return [t0 === 0 ? x0 : x0 + t0 * dx, t0 === 0 ? y0 : y0 + t0 * dy, t1 === 1 ? x1 : x0 + t1 * dx, t1 === 1 ? y1 : y0 + t1 * dy];
}

function clipRing(coords: ArrayLike<number>, start: number, end: number, minX: number, minY: number, maxX: number, maxY: number): number[] {
  let points: number[] = [];
  // The ring without its closing point.
  const last = coords[end - 2] === coords[start] && coords[end - 1] === coords[start + 1] ? end - 2 : end;
  for (let i = start; i < last; i++) points.push(coords[i]);
  const edges: Array<[(x: number, y: number) => boolean, (ax: number, ay: number, bx: number, by: number) => [number, number]]> = [
    [(x) => x >= minX, (ax, ay, bx, by) => [minX, ay + ((by - ay) * (minX - ax)) / (bx - ax)]],
    [(x) => x <= maxX, (ax, ay, bx, by) => [maxX, ay + ((by - ay) * (maxX - ax)) / (bx - ax)]],
    [(_, y) => y >= minY, (ax, ay, bx, by) => [ax + ((bx - ax) * (minY - ay)) / (by - ay), minY]],
    [(_, y) => y <= maxY, (ax, ay, bx, by) => [ax + ((bx - ax) * (maxY - ay)) / (by - ay), maxY]],
  ];
  for (const [inside, cross] of edges) {
    if (points.length < 6) return [];
    const next: number[] = [];
    for (let i = 0; i < points.length; i += 2) {
      const j = i ? i - 2 : points.length - 2;
      const ax = points[j];
      const ay = points[j + 1];
      const bx = points[i];
      const by = points[i + 1];
      const aIn = inside(ax, ay);
      const bIn = inside(bx, by);
      if (bIn) {
        if (!aIn) next.push(...cross(ax, ay, bx, by));
        next.push(bx, by);
      } else if (aIn) next.push(...cross(ax, ay, bx, by));
    }
    points = next;
  }
  if (points.length < 6) return [];
  points.push(points[0], points[1]);
  return points;
}

/** Grid cells taken, for keeping one small shape a cell: exact on small grids, hashed (rarely wrong) on large ones. */
export class CellSet {
  private readonly bits_: Uint32Array;
  private readonly exact_: boolean;
  private readonly mask_: number;

  /** @param width Cells across (and down). */
  constructor(private readonly width: number, maxBits = 1 << 26) {
    this.exact_ = width * width <= maxBits;
    const bits = this.exact_ ? width * width : maxBits;
    this.bits_ = new Uint32Array(Math.ceil(bits / 32));
    this.mask_ = maxBits - 1;
  }

  /** Takes the cell; false when it was taken already. */
  take(cx: number, cy: number): boolean {
    const w = this.width;
    const x = Math.min(w - 1, Math.max(0, cx));
    const y = Math.min(w - 1, Math.max(0, cy));
    let i: number;
    if (this.exact_) i = y * w + x;
    else {
      let h = Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77);
      h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
      i = (h ^ (h >>> 13)) & this.mask_;
    }
    const word = i >>> 5;
    const bit = 1 << (i & 31);
    if (this.bits_[word] & bit) return false;
    this.bits_[word] |= bit;
    return true;
  }
}
