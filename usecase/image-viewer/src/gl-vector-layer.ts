/**
 * A map layer that draws many features with WebGL, made for layers of tens
 * or hundreds of thousands of features.
 *
 * Each feature's geometry is cut into triangles (areas), segments (lines and
 * the outlines of areas) and points once, when it is given, and kept on the
 * GPU in map coordinates; moving the map only changes the transform the
 * shaders apply. (OpenLayers' WebGL vector layer builds every feature's
 * buffers again each time the view stops.) What a feature is drawn in (its
 * colors, line width, whether it shows, its time span) is one row of a data
 * texture the shaders read by the feature's number, so restyling, hiding
 * categories and moving the timeline window rewrite only that texture.
 *
 * Coordinates are split into a 32-bit float and the rest (high and low
 * parts), subtracted from the view's center in the same way on the GPU, so
 * features stay in place to the centimeter when zoomed in on Web Mercator
 * coordinates of millions of meters.
 *
 * Lines are drawn as capsules (round caps and joins, as OpenLayers draws
 * them by default), with an optional dash pattern in pixels. Point symbols
 * are drawn from a distance field of their shape (circle, regular polygon or
 * star, cross).
 */
import earcut from 'earcut';
import type Feature from 'ol/Feature.js';
import Layer from 'ol/layer/Layer.js';
import type { FrameState } from 'ol/Map.js';
import type Geometry from 'ol/geom/Geometry.js';
import type SimpleGeometry from 'ol/geom/SimpleGeometry.js';
import type GeometryCollection from 'ol/geom/GeometryCollection.js';
import type Circle from 'ol/geom/Circle.js';
import { fromCircle } from 'ol/geom/Polygon.js';
import { apply as applyTransform } from 'ol/transform.js';

/** Colors (`[r, g, b, a]`, 0-255 and alpha 0-1) and the line width (pixels) a feature is drawn in. */
export interface GlPaint {
  fill: number[];
  stroke: number[];
  width: number;
}

/** The symbol points are drawn as. */
export type GlSymbol =
  | { kind: 'circle'; radius: number }
  /** A regular polygon (`radius2` absent) or star of `points` points, turned by `angle` (radians) from a point straight up. */
  | { kind: 'polygon'; points: number; radius: number; radius2?: number; angle: number }
  /** Two bars `arm` long either side of the center, `line` thick, in the stroke color (turned by `angle`). */
  | { kind: 'cross'; arm: number; line: number; angle: number };

/** Texels of the data texture per feature: fill, stroke, (width, t0, t1, shown), unused. */
const TEXELS = 4;
/** Width of the data texture. */
const DATA_WIDTH = 1024;

const POS = 4; // xHi, yHi, xLo, yLo
const FILL_STRIDE = POS + 1; // + slot
/**
 * Segments and points are read by the shaders from float textures this wide,
 * by the number of the vertex drawn (four a segment or point, through one
 * shared index buffer): no per-vertex copies, and no instancing (which some
 * drivers, SwiftShader among them, run one instance at a time).
 */
const GEOM_WIDTH = 4096;
const SEGMENT_FLOATS = 12; // three texels: one end, the other end, (slot, distance along the line where it starts)
const POINT_FLOATS = 8; // two texels: the position, (slot)

/** A growing array of floats or indices. */
class Grow<T extends Float32Array | Uint32Array> {
  length = 0;
  constructor(
    public data: T,
    private readonly make: (n: number) => T,
  ) {}
  reserve(extra: number): void {
    const need = this.length + extra;
    if (need <= this.data.length) return;
    const next = this.make(Math.max(need, this.data.length * 2, 1024));
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
  clear(): void {
    this.length = 0;
  }
}

const floats = (n: number) => new Float32Array(n);
/** Whole rows of a geometry texture. */
const texels = (n: number) => new Float32Array(Math.ceil(n / (GEOM_WIDTH * 4)) * GEOM_WIDTH * 4);
const uints = (n: number) => new Uint32Array(n);

interface Entry {
  slot: number;
  geometry: Geometry | undefined;
  revision: number;
  /** How many floats of each kind of buffer its geometry takes (left behind when it changes or goes). */
  size: number;
}

/** Writes `x, y` split into high and low parts at `i`. */
function putPosition(out: Float32Array, i: number, x: number, y: number): void {
  const hx = Math.fround(x);
  const hy = Math.fround(y);
  out[i] = hx;
  out[i + 1] = hy;
  out[i + 2] = x - hx;
  out[i + 3] = y - hy;
}

/** The geometry drawn: everything a vector layer can hold, as simple geometries. */
function simpleParts(geometry: Geometry, out: SimpleGeometry[]): SimpleGeometry[] {
  const type = geometry.getType();
  if (type === 'GeometryCollection') for (const g of (geometry as GeometryCollection).getGeometriesArray()) simpleParts(g, out);
  else if (type === 'Circle') out.push(fromCircle(geometry as Circle, 64));
  else out.push(geometry as SimpleGeometry);
  return out;
}

const VERTEX_COMMON = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_data;
uniform highp sampler2D u_geometry;
uniform vec4 u_center;   // the view's center, high and low parts
uniform mat2 u_matrix;   // map units to CSS pixels
uniform vec2 u_centerPx; // the view's center in CSS pixels
uniform vec2 u_size;     // the canvas in CSS pixels
uniform bool u_timed;
uniform vec2 u_time;     // the timeline's window
vec4 fetch(float slot, int k) {
  int i = int(slot + 0.5) * ${TEXELS} + k;
  return texelFetch(u_data, ivec2(i % ${DATA_WIDTH}, i / ${DATA_WIDTH}), 0);
}
vec4 geometry(int i) {
  return texelFetch(u_geometry, ivec2(i % ${GEOM_WIDTH}, i / ${GEOM_WIDTH}), 0);
}
/** The corner of its quad (0 or 1 each way) the vertex is. */
vec2 corner() {
  int c = gl_VertexID % 4;
  return vec2(c == 1 || c == 2 ? 1.0 : 0.0, c >= 2 ? 1.0 : 0.0);
}
/** CSS pixels of a position given as high and low parts. */
vec2 toPixel(vec4 p) {
  vec2 rel = (p.xy - u_center.xy) + (p.zw - u_center.zw);
  return u_matrix * rel + u_centerPx;
}
vec4 toClip(vec2 px) {
  vec2 c = px / u_size * 2.0 - 1.0;
  return vec4(c.x, -c.y, 0.0, 1.0);
}
/** Whether the feature shows (not hidden, inside the time window). */
bool shown(vec4 v) {
  if (v.w < 0.5) return false;
  if (u_timed && (v.y > u_time.y || v.z < u_time.x)) return false;
  return true;
}
const vec4 OUTSIDE = vec4(2.0, 2.0, 2.0, 1.0);
`;

const FILL_VERTEX = `${VERTEX_COMMON}
in vec4 a_pos;
in float a_slot;
out vec4 v_color;
void main() {
  vec4 color = fetch(a_slot, 0);
  if (!shown(fetch(a_slot, 2)) || color.a == 0.0) { gl_Position = OUTSIDE; return; }
  v_color = vec4(color.rgb * color.a, color.a);
  gl_Position = toClip(toPixel(a_pos));
}`;

const FILL_FRAGMENT = `#version 300 es
precision highp float;
in vec4 v_color;
uniform float u_opacity;
out vec4 color;
void main() { color = v_color * u_opacity; }`;

const LINE_VERTEX = `${VERTEX_COMMON}
uniform float u_ratio;      // device pixels per CSS pixel
uniform float u_pxPerUnit;  // CSS pixels per map unit
out vec4 v_color;
out vec2 v_local;  // along and across the segment, CSS pixels
out float v_length;
out float v_half;
out float v_dist;  // CSS pixels along the line where the segment starts
void main() {
  int segment = gl_VertexID / 4;
  vec4 extra = geometry(segment * 3 + 2);
  vec4 color = fetch(extra.x, 1);
  vec4 v = fetch(extra.x, 2);
  if (v.x <= 0.0 || color.a == 0.0 || !shown(v)) { gl_Position = OUTSIDE; return; }
  vec2 p0 = toPixel(geometry(segment * 3));
  vec2 p1 = toPixel(geometry(segment * 3 + 1));
  vec2 d = p1 - p0;
  float len = length(d);
  vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  float half_ = v.x / 2.0;
  float pad = half_ + 1.0 / u_ratio;
  vec2 k = corner();
  float along = mix(-pad, len + pad, k.x);
  float across = mix(-pad, pad, k.y);
  v_local = vec2(along, across);
  v_length = len;
  v_half = half_;
  v_dist = extra.y * u_pxPerUnit;
  v_color = vec4(color.rgb * color.a, color.a);
  gl_Position = toClip(p0 + dir * along + normal * across);
}`;

const LINE_FRAGMENT = `#version 300 es
precision highp float;
in vec4 v_color;
in vec2 v_local;
in float v_length;
in float v_half;
in float v_dist;
uniform float u_ratio;
uniform float u_opacity;
uniform vec4 u_dash;     // on, off, on, off in CSS pixels; all 0: solid
uniform float u_dashLength;
out vec4 color;
void main() {
  float t = clamp(v_local.x, 0.0, v_length);
  float d = length(vec2(v_local.x - t, v_local.y));
  if (u_dashLength > 0.0) {
    // Distance along the line to the nearest dash (round ends, as OpenLayers' round caps).
    float m = mod(v_dist + t, u_dashLength);
    float a0 = 0.0, a1 = u_dash.x, b0 = u_dash.x + u_dash.y, b1 = b0 + u_dash.z;
    float da = m < a0 ? a0 - m : (m > a1 ? m - a1 : 0.0);
    float db = m < b0 ? b0 - m : (m > b1 ? m - b1 : 0.0);
    if (u_dash.z <= 0.0) db = 1e9;
    // The next period's first dash.
    float dn = u_dashLength - m;
    float along = min(min(da, db), dn);
    d = max(d, length(vec2(along, v_local.y)));
  }
  float alpha = clamp((v_half - d) * u_ratio + 0.5, 0.0, 1.0);
  if (alpha <= 0.0) discard;
  color = v_color * alpha * u_opacity;
}`;

const POINT_VERTEX = `${VERTEX_COMMON}
uniform float u_extent; // half the symbol's box, CSS pixels
out vec2 v_local;
out vec4 v_fill;
out vec4 v_stroke;
out float v_width;
void main() {
  int point = gl_VertexID / 4;
  float slot = geometry(point * 2 + 1).x;
  vec4 v = fetch(slot, 2);
  if (!shown(v)) { gl_Position = OUTSIDE; return; }
  vec4 fill = fetch(slot, 0);
  vec4 stroke = fetch(slot, 1);
  float extent = u_extent + v.x / 2.0 + 1.0;
  v_local = (corner() * 2.0 - 1.0) * extent;
  v_fill = vec4(fill.rgb * fill.a, fill.a);
  v_stroke = vec4(stroke.rgb * stroke.a, stroke.a);
  v_width = v.x;
  gl_Position = toClip(toPixel(geometry(point * 2)) + v_local);
}`;

const POINT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_local;
in vec4 v_fill;
in vec4 v_stroke;
in float v_width;
uniform int u_shape;      // 0 circle, 1 polygon, 2 cross
uniform float u_radius;
uniform vec2 u_vertices[10];
uniform int u_count;
uniform vec3 u_cross;     // arm, half the line, angle
uniform float u_ratio;
uniform float u_opacity;
out vec4 color;
float polygon(vec2 p) {
  float d = dot(p - u_vertices[0], p - u_vertices[0]);
  float s = 1.0;
  for (int i = 0; i < 10; i++) {
    if (i >= u_count) break;
    int j = i == 0 ? u_count - 1 : i - 1;
    vec2 e = u_vertices[j] - u_vertices[i];
    vec2 w = p - u_vertices[i];
    vec2 b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    d = min(d, dot(b, b));
    bvec3 c = bvec3(p.y >= u_vertices[i].y, p.y < u_vertices[j].y, e.x * w.y > e.y * w.x);
    if (all(c) || all(not(c))) s = -s;
  }
  return s * sqrt(d);
}
float box(vec2 p, vec2 half_) {
  vec2 q = abs(p) - half_;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}
void main() {
  float aa = 0.5 / u_ratio;
  if (u_shape == 2) {
    float c = cos(u_cross.z), s = sin(u_cross.z);
    vec2 p = vec2(c * v_local.x + s * v_local.y, -s * v_local.x + c * v_local.y);
    float d = min(box(p, vec2(u_cross.x, u_cross.y)), box(p, vec2(u_cross.y, u_cross.x)));
    float a = clamp(0.5 - d * u_ratio, 0.0, 1.0);
    if (a <= 0.0) discard;
    color = v_stroke * a * u_opacity;
    return;
  }
  float d = u_shape == 0 ? length(v_local) - u_radius : polygon(v_local);
  float fillA = clamp(0.5 - d * u_ratio, 0.0, 1.0);
  float strokeA = v_width > 0.0 ? clamp((v_width / 2.0 - abs(d)) * u_ratio + 0.5, 0.0, 1.0) : 0.0;
  vec4 s = v_stroke * strokeA;
  vec4 f = v_fill * fillA;
  vec4 c = s + f * (1.0 - s.a);
  if (c.a <= 0.0) discard;
  color = c * u_opacity;
}`;

interface Program {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

interface Gpu {
  gl: WebGL2RenderingContext;
  fill: Program;
  line: Program;
  point: Program;
  fillBuffer: WebGLBuffer;
  fillIndex: WebGLBuffer;
  /** Indices of quads (two triangles of four vertices each), for segments and points. */
  quads: WebGLBuffer;
  quadCount: number;
  lineTexture: WebGLTexture;
  pointTexture: WebGLTexture;
  data: WebGLTexture;
  maxRows: number;
  /** Segments and points the textures hold. */
  segments: number;
  points: number;
  dataRows: number;
}

function compile(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram()!;
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(`GlVectorLayer shader: ${gl.getShaderInfoLog(shader)}`);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`GlVectorLayer program: ${gl.getProgramInfoLog(program)}`);
  return program;
}

const UNIFORMS = ['u_data', 'u_geometry', 'u_center', 'u_matrix', 'u_centerPx', 'u_size', 'u_timed', 'u_time', 'u_opacity', 'u_ratio', 'u_pxPerUnit', 'u_dash', 'u_dashLength', 'u_extent', 'u_shape', 'u_radius', 'u_vertices', 'u_count', 'u_cross'];

function program(gl: WebGL2RenderingContext, vertex: string, fragment: string): Program {
  const p = compile(gl, vertex, fragment);
  const uniforms = new Map(UNIFORMS.map((name) => [name, gl.getUniformLocation(p, name)]));
  return { program: p, vao: gl.createVertexArray()!, uniforms };
}

/** Points `attribute` at `components` floats of `buffer` from `offset` floats into each `stride`-float record. */
function attribute(gl: WebGL2RenderingContext, p: WebGLProgram, name: string, components: number, stride: number, offset: number, divisor: number): void {
  const location = gl.getAttribLocation(p, name);
  if (location < 0) return;
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, components, gl.FLOAT, false, stride * 4, offset * 4);
  gl.vertexAttribDivisor(location, divisor);
}

/** A vector layer drawn with WebGL from the features given to it ({@link GlVectorLayer.draw}). */
export class GlVectorLayer extends Layer {
  private readonly entries_ = new Map<Feature, Entry>();
  /** Feature numbers handed out; a number is not used again until the buffers are cleared out (its old geometry is still in them). */
  private slots_ = 0;
  private data_ = new Float32Array(DATA_WIDTH * 4 * 4);
  private dataDirty_ = true;
  private readonly fills_ = new Grow(floats(0), floats);
  private readonly indices_ = new Grow(uints(0), uints);
  private readonly lines_ = new Grow(floats(0), texels);
  private readonly points_ = new Grow(floats(0), texels);
  /** Floats of the buffers left by geometries that changed or went (cleared out when there are many). */
  private garbage_ = 0;
  private geometryDirty_ = true;
  private symbol_: GlSymbol = { kind: 'circle', radius: 4 };
  private dash_: number[] = [];
  private time_: [number, number] | null = null;
  private maxWidth_ = 0;
  private canvas_: HTMLCanvasElement | null = null;
  private gpu_: Gpu | null = null;

  constructor(options: { className?: string } = {}) {
    super({ className: options.className });
  }

  /** How many features are drawn (or kept hidden). */
  get count(): number {
    return this.entries_.size;
  }

  /**
   * Draws `feature` with `paint` (null: kept, not drawn) and the time span
   * `time` (minutes; see {@link GlVectorLayer.setTimeWindow}). Its geometry
   * is cut up again only when it is another geometry or has changed since.
   */
  draw(feature: Feature, paint: GlPaint | null, time: { t0: number; t1: number } | null = null): void {
    const geometry = feature.getGeometry();
    let entry = this.entries_.get(feature);
    if (!entry) {
      entry = { slot: this.slots_++, geometry: undefined, revision: -1, size: 0 };
      this.entries_.set(feature, entry);
    }
    if (entry.geometry !== geometry || (geometry && entry.revision !== geometry.getRevision())) {
      if (entry.size) {
        // The old shape stays in the buffers under the old number, drawn no more.
        this.writeData_(entry.slot, null, null);
        entry.slot = this.slots_++;
      }
      this.garbage_ += entry.size;
      entry.geometry = geometry;
      entry.revision = geometry?.getRevision() ?? -1;
      entry.size = geometry ? this.addGeometry_(geometry, entry.slot) : 0;
      this.geometryDirty_ = true;
    }
    this.writeData_(entry.slot, paint, time);
    this.changed();
  }

  /** Stops drawing `feature`. */
  remove(feature: Feature): void {
    const entry = this.entries_.get(feature);
    if (!entry) return;
    this.entries_.delete(feature);
    this.writeData_(entry.slot, null, null);
    this.garbage_ += entry.size;
    this.changed();
  }

  /** Stops drawing every feature. */
  clearFeatures(): void {
    this.entries_.clear();
    this.slots_ = 0;
    this.data_.fill(0);
    this.fills_.clear();
    this.indices_.clear();
    this.lines_.clear();
    this.points_.clear();
    this.garbage_ = 0;
    this.maxWidth_ = 0;
    this.geometryDirty_ = this.dataDirty_ = true;
    this.changed();
  }

  /** The symbol of points and the dash pattern of lines (CSS pixels; empty: solid). */
  setSymbol(symbol: GlSymbol, dash: readonly number[] = []): void {
    this.symbol_ = symbol;
    this.dash_ = [...dash];
    this.changed();
  }

  /** Draws only features whose time span meets `window` (minutes); null: every feature. */
  setTimeWindow(window: [number, number] | null): void {
    this.time_ = window;
    this.changed();
  }

  override disposeInternal(): void {
    this.release_();
    super.disposeInternal();
  }

  /** Lets go of the WebGL context (the features are kept; a later frame makes a new one). */
  release(): void {
    this.release_();
  }

  private writeData_(slot: number, paint: GlPaint | null, time: { t0: number; t1: number } | null): void {
    const need = (slot + 1) * TEXELS * 4;
    if (need > this.data_.length) {
      const rows = Math.ceil((slot + 1) * TEXELS / DATA_WIDTH);
      const next = new Float32Array(Math.max(rows, (this.data_.length / (DATA_WIDTH * 4)) * 2) * DATA_WIDTH * 4);
      next.set(this.data_);
      this.data_ = next;
    }
    const d = this.data_;
    const i = slot * TEXELS * 4;
    if (paint) {
      d[i] = paint.fill[0] / 255;
      d[i + 1] = paint.fill[1] / 255;
      d[i + 2] = paint.fill[2] / 255;
      d[i + 3] = paint.fill[3] ?? 1;
      d[i + 4] = paint.stroke[0] / 255;
      d[i + 5] = paint.stroke[1] / 255;
      d[i + 6] = paint.stroke[2] / 255;
      d[i + 7] = paint.stroke[3] ?? 1;
      d[i + 8] = paint.width;
      if (paint.width > this.maxWidth_) this.maxWidth_ = paint.width;
    } else d.fill(0, i, i + 9);
    d[i + 9] = time ? time.t0 : 0;
    d[i + 10] = time ? time.t1 : 0;
    d[i + 11] = paint ? 1 : 0;
    this.dataDirty_ = true;
  }

  /** Cuts `geometry` up into the buffers, its vertices numbered `slot`; returns the floats it took. */
  private addGeometry_(geometry: Geometry, slot: number): number {
    const before = this.fills_.length + this.indices_.length + this.lines_.length + this.points_.length;
    for (const part of simpleParts(geometry, [])) {
      const type = part.getType();
      const flat = part.getFlatCoordinates();
      const stride = part.getStride();
      if (type === 'Point' || type === 'MultiPoint') this.addPoints_(flat, stride, slot);
      else if (type === 'LineString' || type === 'LinearRing') this.addLine_(flat, 0, flat.length, stride, slot, false);
      else if (type === 'MultiLineString') {
        let offset = 0;
        for (const end of (part as unknown as { getEnds(): number[] }).getEnds()) {
          this.addLine_(flat, offset, end, stride, slot, false);
          offset = end;
        }
      } else if (type === 'Polygon') this.addPolygon_(flat, 0, (part as unknown as { getEnds(): number[] }).getEnds(), stride, slot);
      else if (type === 'MultiPolygon') {
        let offset = 0;
        for (const ends of (part as unknown as { getEndss(): number[][] }).getEndss()) {
          this.addPolygon_(flat, offset, ends, stride, slot);
          offset = ends[ends.length - 1] ?? offset;
        }
      }
    }
    return this.fills_.length + this.indices_.length + this.lines_.length + this.points_.length - before;
  }

  private addPoints_(flat: number[], stride: number, slot: number): void {
    const n = flat.length / stride;
    const out = this.points_;
    out.reserve(n * POINT_FLOATS);
    for (let k = 0; k < flat.length; k += stride) {
      putPosition(out.data, out.length, flat[k], flat[k + 1]);
      out.data[out.length + 4] = slot;
      out.length += POINT_FLOATS;
    }
  }

  /** One line (`flat` from `offset` to `end`); `closed`: back to its first point. */
  private addLine_(flat: number[], offset: number, end: number, stride: number, slot: number, closed: boolean): void {
    const n = (end - offset) / stride;
    if (n < 2) return;
    const close = closed && (flat[offset] !== flat[end - stride] || flat[offset + 1] !== flat[end - stride + 1]);
    const out = this.lines_;
    out.reserve(n * SEGMENT_FLOATS);
    let distance = 0;
    const put = (x0: number, y0: number, x1: number, y1: number) => {
      const i = out.length;
      putPosition(out.data, i, x0, y0);
      putPosition(out.data, i + POS, x1, y1);
      out.data[i + 8] = slot;
      out.data[i + 9] = distance;
      out.length += SEGMENT_FLOATS;
      distance += Math.hypot(x1 - x0, y1 - y0);
    };
    for (let k = offset + stride; k < end; k += stride) put(flat[k - stride], flat[k - stride + 1], flat[k], flat[k + 1]);
    if (close) put(flat[end - stride], flat[end - stride + 1], flat[offset], flat[offset + 1]);
  }

  private addPolygon_(flat: number[], offset: number, ends: number[], stride: number, slot: number): void {
    if (!ends.length) return;
    const end = ends[ends.length - 1];
    const xy: number[] = [];
    const holes: number[] = [];
    let start = offset;
    for (const e of ends) {
      if (start !== offset) holes.push(xy.length / 2);
      for (let k = start; k < e; k += stride) xy.push(flat[k], flat[k + 1]);
      this.addLine_(flat, start, e, stride, slot, true);
      start = e;
    }
    if (end <= offset) return;
    const triangles = earcut(xy, holes, 2);
    const fills = this.fills_;
    const base = fills.length / FILL_STRIDE;
    fills.reserve(xy.length / 2 * FILL_STRIDE);
    for (let k = 0; k < xy.length; k += 2) {
      putPosition(fills.data, fills.length, xy[k], xy[k + 1]);
      fills.data[fills.length + 4] = slot;
      fills.length += FILL_STRIDE;
    }
    const indices = this.indices_;
    indices.reserve(triangles.length);
    for (const t of triangles) indices.data[indices.length++] = base + t;
  }

  /** Cuts up every feature's geometry again, leaving out what changed or went, and numbers the features afresh. */
  private compact_(): void {
    this.fills_.clear();
    this.indices_.clear();
    this.lines_.clear();
    this.points_.clear();
    const old = this.data_;
    const data = new Float32Array(Math.max(1, Math.ceil((this.entries_.size * TEXELS) / DATA_WIDTH)) * DATA_WIDTH * 4);
    let slot = 0;
    for (const entry of this.entries_.values()) {
      const row = TEXELS * 4;
      data.set(old.subarray(entry.slot * row, (entry.slot + 1) * row), slot * row);
      entry.slot = slot++;
      entry.size = entry.geometry ? this.addGeometry_(entry.geometry, entry.slot) : 0;
    }
    this.data_ = data;
    this.slots_ = slot;
    this.garbage_ = 0;
    this.geometryDirty_ = this.dataDirty_ = true;
    if (this.gpu_) this.gpu_.dataRows = 0;
  }

  private release_(): void {
    const gpu = this.gpu_;
    this.gpu_ = null;
    if (gpu && !gpu.gl.isContextLost()) gpu.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas_ = null;
  }

  private gpu(): Gpu | null {
    if (this.gpu_) return this.gpu_;
    const canvas = document.createElement('canvas');
    canvas.className = this.getClassName();
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: false });
    if (!gl) return null;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      // Made again on the next frame with a new context.
      if (this.gpu_?.gl === gl) {
        this.gpu_ = null;
        this.canvas_ = null;
        this.changed();
      }
    });
    const fill = program(gl, FILL_VERTEX, FILL_FRAGMENT);
    const line = program(gl, LINE_VERTEX, LINE_FRAGMENT);
    const point = program(gl, POINT_VERTEX, POINT_FRAGMENT);
    const gpu: Gpu = {
      gl,
      fill,
      line,
      point,
      fillBuffer: gl.createBuffer()!,
      fillIndex: gl.createBuffer()!,
      quads: gl.createBuffer()!,
      quadCount: 0,
      lineTexture: floatTexture(gl),
      pointTexture: floatTexture(gl),
      data: floatTexture(gl),
      maxRows: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      segments: 0,
      points: 0,
      dataRows: 0,
    };
    gl.bindVertexArray(fill.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gpu.fillBuffer);
    attribute(gl, fill.program, 'a_pos', 4, FILL_STRIDE, 0, 0);
    attribute(gl, fill.program, 'a_slot', 1, FILL_STRIDE, 4, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gpu.fillIndex);
    for (const p of [line, point]) {
      gl.bindVertexArray(p.vao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gpu.quads);
    }
    gl.bindVertexArray(null);
    this.canvas_ = canvas;
    this.gpu_ = gpu;
    this.geometryDirty_ = this.dataDirty_ = true;
    return gpu;
  }

  /** Uploads what changed since the last frame. */
  private upload_(gpu: Gpu): void {
    const gl = gpu.gl;
    const used = this.fills_.length + this.indices_.length + this.lines_.length + this.points_.length;
    const many = (this.garbage_ > 100_000 && this.garbage_ > used - this.garbage_) || this.slots_ > 2 * this.entries_.size + 10_000;
    if (many) this.compact_();
    if (this.geometryDirty_) {
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, gpu.fillBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.fills_.data.subarray(0, this.fills_.length), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gpu.fillIndex);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indices_.data.subarray(0, this.indices_.length), gl.STATIC_DRAW);
      gpu.segments = uploadTexels(gl, gpu.lineTexture, this.lines_, SEGMENT_FLOATS, gpu.maxRows);
      gpu.points = uploadTexels(gl, gpu.pointTexture, this.points_, POINT_FLOATS, gpu.maxRows);
      const quads = Math.max(gpu.segments, gpu.points);
      if (quads > gpu.quadCount) {
        gpu.quadCount = Math.max(quads, gpu.quadCount * 2, 1024);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gpu.quads);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIndices(gpu.quadCount), gl.STATIC_DRAW);
      }
      this.geometryDirty_ = false;
    }
    if (this.dataDirty_) {
      const rows = Math.max(1, Math.ceil((this.slots_ * TEXELS) / DATA_WIDTH));
      gl.bindTexture(gl.TEXTURE_2D, gpu.data);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      if (rows > gpu.dataRows) {
        const height = Math.min(this.data_.length / (DATA_WIDTH * 4), Math.max(rows, gpu.dataRows * 2));
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, DATA_WIDTH, height, 0, gl.RGBA, gl.FLOAT, this.data_.subarray(0, height * DATA_WIDTH * 4));
        gpu.dataRows = height;
      } else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, DATA_WIDTH, rows, gl.RGBA, gl.FLOAT, this.data_.subarray(0, rows * DATA_WIDTH * 4));
      this.dataDirty_ = false;
    }
  }

  override render(frameState: FrameState | null): HTMLElement | null {
    if (!frameState) return null;
    const gpu = this.gpu();
    if (!gpu) return (this.canvas_ ??= document.createElement('canvas'));
    const gl = gpu.gl;
    const canvas = this.canvas_!;
    const ratio = frameState.pixelRatio;
    const [w, h] = frameState.size;
    const width = Math.round(w * ratio);
    const height = Math.round(h * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const opacity = frameState.layerStatesArray[frameState.layerIndex]?.opacity ?? 1;
    canvas.style.opacity = opacity === 1 ? '' : String(opacity);
    if (gl.isContextLost()) return canvas;
    this.upload_(gpu);

    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const center = frameState.viewState.center;
    const hx = Math.fround(center[0]);
    const hy = Math.fround(center[1]);
    const t = frameState.coordinateToPixelTransform;
    const centerPx = applyTransform(t, [center[0], center[1]]);
    const resolution = frameState.viewState.resolution;
    const dash = this.dash_;
    const dashLength = dash.length >= 2 ? dash.slice(0, 4).reduce((a, b) => a + b, 0) : 0;
    const symbol = this.symbol_;

    const common = (p: Program) => {
      gl.useProgram(p.program);
      const u = p.uniforms;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, gpu.data);
      gl.uniform1i(u.get('u_data')!, 0);
      const geometryAt = u.get('u_geometry');
      if (geometryAt) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, p === gpu.line ? gpu.lineTexture : gpu.pointTexture);
        gl.uniform1i(geometryAt, 1);
      }
      gl.uniform4f(u.get('u_center')!, hx, hy, center[0] - hx, center[1] - hy);
      gl.uniformMatrix2fv(u.get('u_matrix')!, false, [t[0], t[1], t[2], t[3]]);
      gl.uniform2f(u.get('u_centerPx')!, centerPx[0], centerPx[1]);
      gl.uniform2f(u.get('u_size')!, w, h);
      gl.uniform1i(u.get('u_timed')!, this.time_ ? 1 : 0);
      gl.uniform2f(u.get('u_time')!, this.time_?.[0] ?? 0, this.time_?.[1] ?? 0);
      gl.uniform1f(u.get('u_opacity')!, 1);
      const ratioAt = u.get('u_ratio');
      if (ratioAt) gl.uniform1f(ratioAt, ratio);
      gl.bindVertexArray(p.vao);
    };

    const fillCount = this.indices_.length;
    if (fillCount) {
      common(gpu.fill);
      gl.drawElements(gl.TRIANGLES, fillCount, gl.UNSIGNED_INT, 0);
    }
    const segments = gpu.segments;
    if (segments > 0) {
      common(gpu.line);
      const u = gpu.line.uniforms;
      gl.uniform1f(u.get('u_pxPerUnit')!, 1 / resolution);
      const d = [0, 0, 0, 0];
      if (dashLength > 0) for (let i = 0; i < 4; i++) d[i] = dash[i] ?? 0;
      gl.uniform4f(u.get('u_dash')!, d[0], d[1], d[2], d[3]);
      gl.uniform1f(u.get('u_dashLength')!, dashLength);
      gl.drawElements(gl.TRIANGLES, segments * 6, gl.UNSIGNED_INT, 0);
    }
    const points = gpu.points;
    if (points > 0) {
      common(gpu.point);
      const u = gpu.point.uniforms;
      let extent: number;
      if (symbol.kind === 'circle') {
        gl.uniform1i(u.get('u_shape')!, 0);
        gl.uniform1f(u.get('u_radius')!, symbol.radius);
        extent = symbol.radius;
      } else if (symbol.kind === 'polygon') {
        const vertices = polygonVertices(symbol);
        gl.uniform1i(u.get('u_shape')!, 1);
        gl.uniform2fv(u.get('u_vertices')!, vertices);
        gl.uniform1i(u.get('u_count')!, vertices.length / 2);
        extent = Math.max(symbol.radius, symbol.radius2 ?? 0);
      } else {
        gl.uniform1i(u.get('u_shape')!, 2);
        gl.uniform3f(u.get('u_cross')!, symbol.arm, symbol.line / 2, symbol.angle);
        extent = Math.hypot(symbol.arm, symbol.line / 2);
      }
      gl.uniform1f(u.get('u_extent')!, extent);
      gl.drawElements(gl.TRIANGLES, points * 6, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(null);
    return canvas;
  }
}

/** The corners of a regular polygon or star symbol (CSS pixels, y down), as OpenLayers' RegularShape draws them. */
export function polygonVertices(symbol: Extract<GlSymbol, { kind: 'polygon' }>): Float32Array {
  const n = symbol.radius2 !== undefined ? symbol.points * 2 : symbol.points;
  const out = new Float32Array(20);
  const step = (2 * Math.PI) / n;
  for (let i = 0; i < n && i < 10; i++) {
    const r = symbol.radius2 !== undefined && i % 2 === 1 ? symbol.radius2 : symbol.radius;
    const a = -Math.PI / 2 + symbol.angle + i * step;
    out[2 * i] = r * Math.cos(a);
    out[2 * i + 1] = r * Math.sin(a);
  }
  return out.subarray(0, Math.min(n, 10) * 2);
}

function floatTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

let warned = false;

/** Uploads `array` (records of `floats` floats) to `texture`; returns how many records it holds (all, unless too many for one texture). */
function uploadTexels(gl: WebGL2RenderingContext, texture: WebGLTexture, array: Grow<Float32Array>, floats: number, maxRows: number): number {
  const rowFloats = GEOM_WIDTH * 4;
  let rows = Math.ceil(array.length / rowFloats);
  if (rows > maxRows) {
    if (!warned) console.warn(`GlVectorLayer: more segments or points than one texture holds; ${Math.floor((maxRows * rowFloats) / floats)} are drawn.`);
    warned = true;
    rows = maxRows;
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  // An empty texture is still one row, so the shaders always have something bound.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, GEOM_WIDTH, Math.max(1, rows), 0, gl.RGBA, gl.FLOAT, rows ? array.data.subarray(0, rows * rowFloats) : new Float32Array(rowFloats));
  return Math.floor(Math.min(array.length, rows * rowFloats) / floats);
}

/** Indices of `count` quads, four vertices each: (0, 1, 2) and (0, 2, 3). */
function quadIndices(count: number): Uint32Array {
  const out = new Uint32Array(count * 6);
  for (let q = 0, i = 0; q < count; q++, i += 6) {
    const v = q * 4;
    out[i] = v;
    out[i + 1] = v + 1;
    out[i + 2] = v + 2;
    out[i + 3] = v;
    out[i + 4] = v + 2;
    out[i + 5] = v + 3;
  }
  return out;
}
