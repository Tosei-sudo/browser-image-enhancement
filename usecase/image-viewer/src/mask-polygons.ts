/**
 * Polygons of the set pixels of a mask (the changed pixels of a change
 * image): the outline of each region of 4-connected pixels, along the pixel
 * edges, with its holes. Coordinates are pixel corners (x right, y down).
 *
 * Every edge between a set pixel and an unset one (or the border) is laid
 * clockwise around its pixel as seen on screen, and the edges are joined
 * into rings, turning right at a corner where two regions meet diagonally,
 * so such regions stay apart. Outlines then run clockwise (positive area by
 * the shoelace formula in y-down coordinates) and holes counter-clockwise.
 */

/** A region: its outline and holes, each a closed ring of `[x, y]` (first point not repeated), and its pixel count. */
export interface MaskPolygon {
  rings: Array<Array<[number, number]>>;
  pixels: number;
}

export interface PolygonizeOptions {
  /** Regions (and holes) of fewer pixels are dropped (holes filled). Default 1. */
  minPixels?: number;
  /** Most regions kept: the largest. Default: all. */
  maxPolygons?: number;
}

const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/** Twice the signed area of a ring (shoelace), positive for clockwise on screen. */
export function ringArea(ring: ReadonlyArray<readonly [number, number]>): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return sum / 2;
}

/** Whether `[x, y]` is inside `ring` (even-odd). */
function inside(ring: ReadonlyArray<readonly [number, number]>, x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** The regions of `mask` (non-zero = set), `width` × `height`, row by row. */
export function polygonize(mask: ArrayLike<number>, width: number, height: number, options: PolygonizeOptions = {}): MaskPolygon[] {
  const W = width + 1;
  const vertices = W * (height + 1);
  // Up to two edges leave a vertex (two at a corner where regions meet diagonally): their directions.
  const outA = new Int8Array(vertices).fill(-1);
  const outB = new Int8Array(vertices).fill(-1);
  const add = (x: number, y: number, dir: number) => {
    const v = y * W + x;
    if (outA[v] < 0) outA[v] = dir;
    else outB[v] = dir;
  };
  const set = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] !== 0;
  let edges = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!set(x, y)) continue;
      if (!set(x, y - 1)) add(x, y, 0);
      if (!set(x + 1, y)) add(x + 1, y, 1);
      if (!set(x, y + 1)) add(x + 1, y + 1, 2);
      if (!set(x - 1, y)) add(x, y + 1, 3);
    }
  }
  for (let v = 0; v < vertices; v++) if (outA[v] >= 0) edges++;
  if (!edges) return [];

  const take = (v: number, incoming: number): number => {
    const a = outA[v];
    const b = outB[v];
    let dir: number;
    if (b < 0) dir = a;
    else if (a < 0) dir = b;
    else {
      // Two ways on: the right turn, else straight on, else the left turn.
      const order = [(incoming + 1) % 4, incoming, (incoming + 3) % 4];
      dir = order.find((d) => d === a || d === b) ?? a;
    }
    if (dir === a) outA[v] = -1;
    else outB[v] = -1;
    return dir;
  };

  const rings: Array<Array<[number, number]>> = [];
  const trace = (start: number) => {
    const ring: Array<[number, number]> = [];
    let v = start;
    let dir = take(v, outA[v] >= 0 ? outA[v] : outB[v]);
    const first = dir;
    let x = start % W;
    let y = Math.floor(start / W);
    ring.push([x, y]);
    for (;;) {
      x += DX[dir];
      y += DY[dir];
      v = y * W + x;
      if (v === start && outA[v] < 0 && outB[v] < 0) break;
      const next = take(v, dir);
      if (next !== dir) ring.push([x, y]);
      dir = next;
      if (v === start && dir === first) break;
    }
    // The start may be mid-way along a side: drop it then.
    if (ring.length > 2) {
      const [ax, ay] = ring[ring.length - 1];
      const [bx, by] = ring[0];
      const [cx, cy] = ring[1];
      if ((ax === bx && bx === cx) || (ay === by && by === cy)) ring.shift();
    }
    rings.push(ring);
  };
  // Rings start where only one edge leaves, so each is followed whole before a corner shared with another.
  for (let v = 0; v < vertices; v++) if (outA[v] >= 0 && outB[v] < 0) trace(v);
  for (let v = 0; v < vertices; v++) while (outA[v] >= 0 || outB[v] >= 0) trace(v);

  const minPixels = Math.max(1, options.minPixels ?? 1);
  const outers: Array<{ ring: Array<[number, number]>; area: number; box: [number, number, number, number]; holes: Array<Array<[number, number]>>; pixels: number }> = [];
  const holes: Array<{ ring: Array<[number, number]>; area: number }> = [];
  for (const ring of rings) {
    const area = ringArea(ring);
    if (area > 0) {
      const xs = ring.map((p) => p[0]);
      const ys = ring.map((p) => p[1]);
      outers.push({ ring, area, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], holes: [], pixels: area });
    } else holes.push({ ring, area: -area });
  }
  // Each hole goes in the smallest outline around it (tested at the middle of its first side, which is on no other ring).
  outers.sort((a, b) => a.area - b.area);
  for (const hole of holes) {
    const [ax, ay] = hole.ring[0];
    const [bx, by] = hole.ring[1];
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const owner = outers.find((o) => mx >= o.box[0] && mx <= o.box[2] && my >= o.box[1] && my <= o.box[3] && inside(o.ring, mx, my));
    if (!owner) continue;
    owner.pixels -= hole.area;
    if (hole.area >= minPixels) owner.holes.push(hole.ring);
  }
  let kept = outers.filter((o) => o.pixels >= minPixels);
  kept.sort((a, b) => b.pixels - a.pixels);
  if (options.maxPolygons !== undefined) kept = kept.slice(0, options.maxPolygons);
  return kept.map((o) => ({ rings: [o.ring, ...o.holes], pixels: o.pixels }));
}
