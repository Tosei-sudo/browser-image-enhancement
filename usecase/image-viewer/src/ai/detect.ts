/**
 * Object detection over a large picture with a YOLO model: the picture is cut
 * into tiles of the model's input size (overlapping, so an object cut by one
 * tile is whole in the next), each tile's output is decoded into boxes,
 * and duplicates across tiles and classes are removed with NMS.
 *
 * Everything here is pure (no ONNX Runtime, no DOM), in the picture's pixels.
 */
import type { DetectFormat, DetectorSpec } from './model-config.js';

/** What a tile is padded with outside the picture (Ultralytics' letterbox gray). */
export const PAD = 114;

/** The starts of tiles of `tile` pixels covering `length`, overlapping by about `overlap` (0–0.9) of a tile. */
export function tileStarts(length: number, tile: number, overlap: number): number[] {
  if (length <= tile) return [0];
  const step = Math.max(1, Math.floor(tile * (1 - overlap)));
  const count = Math.ceil((length - tile) / step) + 1;
  // Spread evenly, the last tile ending at the edge.
  return Array.from({ length: count }, (_, i) => Math.round((i * (length - tile)) / (count - 1)));
}

/** The tiles (top left corners) covering a `width` × `height` picture. */
export function tilesOf(width: number, height: number, size: readonly [number, number], overlap: number): Array<[number, number]> {
  const xs = tileStarts(width, size[0], overlap);
  const ys = tileStarts(height, size[1], overlap);
  return ys.flatMap((y) => xs.map((x): [number, number] => [x, y]));
}

/**
 * The model input (NCHW float32, RGB) for the `size` tile at (`x0`, `y0`) of
 * an RGBA picture: (value − mean) / std per channel. Pixels outside the
 * picture, and transparent ones (no data), are the padding gray.
 */
export function tileTensor(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  x0: number,
  y0: number,
  size: readonly [number, number],
  mean: readonly number[],
  std: readonly number[],
): Float32Array {
  const [tw, th] = size;
  const plane = tw * th;
  const out = new Float32Array(3 * plane);
  const pad = [0, 1, 2].map((c) => (PAD - mean[c]) / std[c]);
  for (let y = 0; y < th; y++) {
    const sy = y0 + y;
    for (let x = 0; x < tw; x++) {
      const sx = x0 + x;
      const o = y * tw + x;
      const i = (sy * width + sx) * 4;
      if (sx >= width || sy >= height || sx < 0 || sy < 0 || rgba[i + 3] === 0) {
        out[o] = pad[0];
        out[o + plane] = pad[1];
        out[o + 2 * plane] = pad[2];
      } else {
        out[o] = (rgba[i] - mean[0]) / std[0];
        out[o + plane] = (rgba[i + 1] - mean[1]) / std[1];
        out[o + 2 * plane] = (rgba[i + 2] - mean[2]) / std[2];
      }
    }
  }
  return out;
}

/** A found object, in pixels. */
export interface Detection {
  cls: number;
  score: number;
  /** Centre x, centre y, width, height. */
  box: [number, number, number, number];
  /** Rotation (radians, clockwise on the picture) of an oriented box. */
  angle?: number;
  /** Mask coefficients (instance segmentation). */
  coeffs?: Float32Array;
  /** The outline from the mask (instance segmentation): rings of [x, y]. */
  outline?: Array<Array<[number, number]>>;
}

/** An output tensor as ONNX Runtime gives it. */
export interface Output {
  dims: readonly number[];
  data: ArrayLike<number>;
}

/**
 * How the first output is laid out, from its shape and the spec: the number
 * of values per candidate and whether candidates run along the last axis
 * (YOLOv8: `[1, 4 + classes, N]`) or the middle one (YOLOv5: `[1, N, 5 + classes]`).
 */
export function layoutOf(output: Output, spec: DetectorSpec): { format: Exclude<DetectFormat, 'auto'>; values: number; count: number; transposed: boolean; classes: number } {
  const [, a, b] = output.dims.length === 3 ? output.dims : [1, ...output.dims.slice(-2)];
  const extra = spec.task === 'obb' ? 1 : spec.task === 'segment' ? 32 : 0;
  const known = spec.classes.length;
  /** Values per candidate of a format, with the class names known. */
  const valuesOf = (format: 'yolov8' | 'yolov5') => 4 + extra + known + (format === 'yolov5' ? 1 : 0);
  let format = spec.format;
  if (format === 'auto') {
    // End-to-end exports (NMS inside, YOLOv10, YOLO26): [1, ≤ 1000, 6] (7 with an angle, 38 with mask coefficients).
    const fitsKnown = known > 0 && [a, b].some((n) => n === valuesOf('yolov8') || n === valuesOf('yolov5'));
    if (b === 6 + extra && a <= 1000 && !fitsKnown) format = 'end2end';
    // With the class names known, the number of values tells v8 (no objectness) from v5; without, the
    // axes do: v8 exports put the candidates last, v5 exports in the middle.
    else if (known) format = a === valuesOf('yolov8') || b === valuesOf('yolov8') ? 'yolov8' : 'yolov5';
    else format = a < b ? 'yolov8' : 'yolov5';
  }
  if (format === 'end2end') return { format, values: b, count: a, transposed: false, classes: known };
  // Which axis holds the values: the one of the expected count, else the shorter one.
  const transposed = known && (a === valuesOf(format) || b === valuesOf(format)) ? a === valuesOf(format) : a < b;
  const values = transposed ? a : b;
  const count = transposed ? b : a;
  return { format, values, count, transposed, classes: values - 4 - extra - (format === 'yolov5' ? 1 : 0) };
}

/** The candidates of one tile's first output scoring at least `minScore`, in the tile's pixels. */
export function decodeYolo(output: Output, spec: DetectorSpec, minScore: number): Detection[] {
  const { format, values, count, transposed, classes } = layoutOf(output, spec);
  const data = output.data;
  const at = transposed ? (i: number, v: number) => data[v * count + i] : (i: number, v: number) => data[i * values + v];
  const found: Detection[] = [];
  for (let i = 0; i < count; i++) {
    let cls = 0;
    let score = 0;
    let angle: number | undefined;
    let coeffAt = -1;
    let box: [number, number, number, number];
    if (format === 'end2end') {
      score = at(i, 4);
      if (!(score >= minScore)) continue;
      cls = Math.round(at(i, 5));
      if (spec.task === 'obb') {
        box = [at(i, 0), at(i, 1), at(i, 2), at(i, 3)];
        angle = at(i, 6);
      } else {
        const [x1, y1, x2, y2] = [at(i, 0), at(i, 1), at(i, 2), at(i, 3)];
        box = [(x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1];
        if (spec.task === 'segment') coeffAt = 6;
      }
    } else {
      const first = format === 'yolov5' ? 5 : 4;
      const objectness = format === 'yolov5' ? at(i, 4) : 1;
      if (!(objectness >= minScore)) continue;
      for (let c = 0; c < classes; c++) {
        const s = at(i, first + c);
        if (s > score) {
          score = s;
          cls = c;
        }
      }
      score *= objectness;
      if (!(score >= minScore)) continue;
      box = [at(i, 0), at(i, 1), at(i, 2), at(i, 3)];
      if (spec.task === 'obb') angle = at(i, first + classes);
      if (spec.task === 'segment') coeffAt = first + classes;
    }
    if (!(box[2] > 0 && box[3] > 0)) continue;
    const d: Detection = { cls, score, box };
    if (angle !== undefined && Number.isFinite(angle)) d.angle = angle;
    if (coeffAt >= 0) d.coeffs = Float32Array.from({ length: 32 }, (_, k) => at(i, coeffAt + k));
    found.push(d);
  }
  return found;
}

/** The corners of a detection's box, clockwise on the picture (y down). */
export function boxCorners(d: Pick<Detection, 'box' | 'angle'>): Array<[number, number]> {
  const [cx, cy, w, h] = d.box;
  const a = d.angle ?? 0;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([x, y]): [number, number] => [cx + x * cos - y * sin, cy + x * sin + y * cos]);
}

/** Area of a ring (positive when clockwise on a y-down picture). */
export function ringArea(ring: ReadonlyArray<readonly [number, number]>): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return sum / 2;
}

/** The part of convex polygon `subject` inside convex polygon `clip` (Sutherland–Hodgman); both in the same winding. */
function clipConvex(subject: Array<[number, number]>, clip: Array<[number, number]>): Array<[number, number]> {
  let out = subject;
  const sign = Math.sign(ringArea(clip)) || 1;
  for (let i = 0; i < clip.length && out.length; i++) {
    const [ax, ay] = clip[i];
    const [bx, by] = clip[(i + 1) % clip.length];
    const inside = (p: [number, number]) => sign * ((bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax)) >= 0;
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j];
      const q = input[(j + 1) % input.length];
      const pin = inside(p);
      const qin = inside(q);
      if (pin) out.push(p);
      if (pin !== qin) {
        const [dx, dy] = [q[0] - p[0], q[1] - p[1]];
        const den = (bx - ax) * dy - (by - ay) * dx;
        const t = den === 0 ? 0 : ((p[0] - ax) * dy - (p[1] - ay) * dx) / den;
        out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
      }
    }
  }
  return out;
}

/** The overlap of two boxes (rotated or not): intersection over union, and over the smaller one. */
export function overlap(a: Pick<Detection, 'box' | 'angle'>, b: Pick<Detection, 'box' | 'angle'>): { iou: number; ios: number } {
  const [ra, rb] = [Math.hypot(a.box[2], a.box[3]) / 2, Math.hypot(b.box[2], b.box[3]) / 2];
  if (Math.abs(a.box[0] - b.box[0]) > ra + rb || Math.abs(a.box[1] - b.box[1]) > ra + rb) return { iou: 0, ios: 0 };
  let inter: number;
  if (!a.angle && !b.angle) {
    const w = Math.min(a.box[0] + a.box[2] / 2, b.box[0] + b.box[2] / 2) - Math.max(a.box[0] - a.box[2] / 2, b.box[0] - b.box[2] / 2);
    const h = Math.min(a.box[1] + a.box[3] / 2, b.box[1] + b.box[3] / 2) - Math.max(a.box[1] - a.box[3] / 2, b.box[1] - b.box[3] / 2);
    inter = w > 0 && h > 0 ? w * h : 0;
  } else {
    inter = Math.abs(ringArea(clipConvex(boxCorners(a), boxCorners(b))));
  }
  const areaA = a.box[2] * a.box[3];
  const areaB = b.box[2] * b.box[3];
  return { iou: inter / (areaA + areaB - inter || 1), ios: inter / (Math.min(areaA, areaB) || 1) };
}

/**
 * Non-maximum suppression per class: the best box stays, and any weaker box
 * of its class overlapping it by more than `iou` (intersection over union),
 * or lying mostly inside it (`within` of the smaller box: a piece of an
 * object cut at a tile's edge), goes.
 */
export function nms(detections: Detection[], iou: number, within = 0.85): Detection[] {
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];
  const byClass = new Map<number, Detection[]>();
  for (const d of sorted) {
    const same = byClass.get(d.cls) ?? [];
    if (same.some((k) => {
      const o = overlap(k, d);
      return o.iou > iou || o.ios > within;
    })) continue;
    same.push(d);
    byClass.set(d.cls, same);
    kept.push(d);
  }
  return kept;
}

/** A detection moved from a tile's pixels into the picture's (the tile's corner at `x0`, `y0`). */
export function offset(d: Detection, x0: number, y0: number): Detection {
  const moved: Detection = { ...d, box: [d.box[0] + x0, d.box[1] + y0, d.box[2], d.box[3]] };
  if (d.outline) moved.outline = d.outline.map((ring) => ring.map(([x, y]): [number, number] => [x + x0, y + y0]));
  return moved;
}

/**
 * The mask of an instance-segmentation detection (in its tile's pixels):
 * sigmoid(coefficients · prototypes) inside its box, the prototypes
 * (`[1, 32, mh, mw]`, covering the model input) sampled bilinearly.
 * Returns the mask of the box's pixels and where it is.
 */
export function instanceMask(
  d: Detection,
  protos: Output,
  inputSize: readonly [number, number],
): { mask: Uint8Array; x0: number; y0: number; width: number; height: number } | null {
  if (!d.coeffs) return null;
  const [, k, mh, mw] = protos.dims;
  const [iw, ih] = inputSize;
  const x0 = Math.max(0, Math.floor(d.box[0] - d.box[2] / 2));
  const y0 = Math.max(0, Math.floor(d.box[1] - d.box[3] / 2));
  const x1 = Math.min(iw, Math.ceil(d.box[0] + d.box[2] / 2));
  const y1 = Math.min(ih, Math.ceil(d.box[1] + d.box[3] / 2));
  if (x1 <= x0 || y1 <= y0) return null;
  // The linear mask on the prototypes' grid, over the box (and one cell around it).
  const gx0 = Math.max(0, Math.floor((x0 * mw) / iw) - 1);
  const gy0 = Math.max(0, Math.floor((y0 * mh) / ih) - 1);
  const gx1 = Math.min(mw - 1, Math.ceil((x1 * mw) / iw) + 1);
  const gy1 = Math.min(mh - 1, Math.ceil((y1 * mh) / ih) + 1);
  const gw = gx1 - gx0 + 1;
  const grid = new Float32Array(gw * (gy1 - gy0 + 1));
  const plane = mw * mh;
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      let sum = 0;
      for (let c = 0; c < k; c++) sum += d.coeffs[c] * protos.data[c * plane + gy * mw + gx];
      grid[(gy - gy0) * gw + (gx - gx0)] = sum;
    }
  }
  const width = x1 - x0;
  const height = y1 - y0;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const fy = Math.min(gy1, Math.max(gy0, ((y0 + y + 0.5) * mh) / ih - 0.5)) - gy0;
    const ya = Math.floor(fy);
    const yb = Math.min(ya + 1, gy1 - gy0);
    const ty = fy - ya;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(gx1, Math.max(gx0, ((x0 + x + 0.5) * mw) / iw - 0.5)) - gx0;
      const xa = Math.floor(fx);
      const xb = Math.min(xa + 1, gx1 - gx0);
      const tx = fx - xa;
      const v =
        (grid[ya * gw + xa] * (1 - tx) + grid[ya * gw + xb] * tx) * (1 - ty) + (grid[yb * gw + xa] * (1 - tx) + grid[yb * gw + xb] * tx) * ty;
      // sigmoid(v) > 0.5
      mask[y * width + x] = v > 0 ? 1 : 0;
    }
  }
  return { mask, x0, y0, width, height };
}
