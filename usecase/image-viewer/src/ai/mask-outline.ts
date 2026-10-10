/**
 * The outline of a mask (1 = inside) as polygons: the edges between inside
 * and outside pixels joined into rings, holes included, then simplified
 * (Douglas–Peucker) so a smooth edge is not a staircase of pixel corners.
 */

/** A polygon: its outer ring, then its holes; points are [x, y] in pixels (corners, y down). */
export type PixelPolygon = Array<Array<[number, number]>>;

// Directions on the pixel-corner grid, clockwise on the picture (y down): right, down, left, up.
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/**
 * The polygons of a `width` × `height` mask. Rings smaller than `minArea`
 * pixels are left out; `tolerance` (pixels) is how far the simplified outline
 * may stray from the pixel edges.
 */
export function maskOutline(mask: ArrayLike<number>, width: number, height: number, tolerance = 0.7, minArea = 4): PixelPolygon[] {
  const W = width + 1;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] !== 0;
  // Each boundary edge, oriented with the inside on its right (clockwise round the inside), kept by
  // its start corner; a corner starts two edges at most (where two pixels touch diagonally).
  const first = new Int32Array(W * (height + 1)).fill(-1);
  const second = new Int32Array(W * (height + 1)).fill(-1);
  const dirs: number[] = [];
  const starts: number[] = [];
  const add = (x: number, y: number, dir: number) => {
    const at = y * W + x;
    const edge = dirs.length;
    dirs.push(dir);
    starts.push(at);
    if (first[at] < 0) first[at] = edge;
    else second[at] = edge;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inside(x, y)) continue;
      if (!inside(x, y - 1)) add(x, y, 0);
      if (!inside(x + 1, y)) add(x + 1, y, 1);
      if (!inside(x, y + 1)) add(x + 1, y + 1, 2);
      if (!inside(x - 1, y)) add(x, y + 1, 3);
    }
  }
  const used = new Uint8Array(dirs.length);
  const rings: Array<Array<[number, number]>> = [];
  for (let e = 0; e < dirs.length; e++) {
    if (used[e]) continue;
    const ring: Array<[number, number]> = [];
    let edge = e;
    let at = starts[e];
    while (!used[edge]) {
      used[edge] = 1;
      const dir = dirs[edge];
      const x = at % W;
      const y = (at - x) / W;
      ring.push([x, y]);
      at = (y + DY[dir]) * W + (x + DX[dir]);
      // At a diagonal pinch, turn right (keep to the pixel just walked round), so rings never cross.
      const a = first[at];
      const b = second[at];
      if (b < 0 || used[b]) edge = a >= 0 && !used[a] ? a : b;
      else if (used[a]) edge = b;
      else edge = dirs[a] === (dir + 1) % 4 ? a : dirs[b] === (dir + 1) % 4 ? b : a;
      if (edge < 0) break;
    }
    const simple = simplifyRing(dropStraight(ring), tolerance);
    if (simple.length >= 3) rings.push(simple);
  }

  // Outer rings run clockwise (positive area), holes the other way; a hole goes to the smallest outer ring round it.
  const areas = rings.map(ringArea);
  const outers = rings.map((r, i) => ({ r, area: areas[i] })).filter((o) => o.area >= minArea);
  const polygons: PixelPolygon[] = outers.map((o) => [o.r]);
  rings.forEach((ring, i) => {
    if (areas[i] > -minArea) return;
    let best = -1;
    for (let j = 0; j < outers.length; j++) {
      if (outers[j].area > -areas[i] && contains(outers[j].r, ring[0]) && (best < 0 || outers[j].area < outers[best].area)) best = j;
    }
    if (best >= 0) polygons[best].push(ring);
  });
  return polygons;
}

function ringArea(ring: ReadonlyArray<readonly [number, number]>): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return sum / 2;
}

/** Whether `p` is inside `ring` (even–odd), testing a point nudged off the grid so corners are never on an edge. */
function contains(ring: ReadonlyArray<readonly [number, number]>, p: readonly [number, number]): boolean {
  const x = p[0] + 0.25;
  const y = p[1] + 0.125;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The ring without points in the middle of straight runs. */
function dropStraight(ring: Array<[number, number]>): Array<[number, number]> {
  const n = ring.length;
  if (n < 4) return ring;
  return ring.filter((p, i) => {
    const a = ring[(i + n - 1) % n];
    const b = ring[(i + 1) % n];
    return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0;
  });
}

/** Douglas–Peucker on a closed ring: split at the point farthest from the first, simplify both halves. */
export function simplifyRing(ring: Array<[number, number]>, tolerance: number): Array<[number, number]> {
  if (ring.length <= 4 || tolerance <= 0) return ring;
  let far = 0;
  let best = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2;
    if (d > best) [best, far] = [d, i];
  }
  const a = simplifyLine(ring.slice(0, far + 1), tolerance);
  const b = simplifyLine([...ring.slice(far), ring[0]], tolerance);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function simplifyLine(points: Array<[number, number]>, tolerance: number): Array<[number, number]> {
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  const t2 = tolerance * tolerance;
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const [ax, ay] = points[i];
    const [bx, by] = points[j];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let far = -1;
    let best = t2;
    for (let k = i + 1; k < j; k++) {
      const [px, py] = points[k];
      let d: number;
      if (len2 === 0) d = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const cross = dx * (py - ay) - dy * (px - ax);
        d = (cross * cross) / len2;
      }
      if (d > best) [best, far] = [d, k];
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([i, far], [far, j]);
    }
  }
  return points.filter((_, i) => keep[i]);
}
