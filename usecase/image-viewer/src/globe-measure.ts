/**
 * Measuring in the 3D view: the 2D view's 「距離を測る」 and 「面積を測る」
 * pick points on whatever is under the cursor — the ground, 3D Tiles, or
 * multipatch shapes — at their heights.
 *
 * - Distance: the straight (slant) length through the points, the
 *   horizontal length along the ellipsoid, and the height difference; and the
 *   profile along the line (the ground from the elevation data, objects from
 *   what is drawn) with the line of sight from the first point to the last.
 * - Area: the horizontal area and perimeter of the polygon (geodesic).
 *
 * Click to add points, double-click (or right-click) to finish, Esc to clear.
 */
import { Cartesian2, Cartesian3, Cartographic, Color, Math as CesiumMath } from '@cesium/core';
import {
  CallbackProperty,
  ColorMaterialProperty,
  HeightReference,
  LabelStyle,
  PolygonHierarchy,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  VerticalOrigin,
  type CesiumWidget,
  type Entity,
} from '@cesium/engine';
import { formatArea, formatLength, geodesicArea, geodesicLength, geodesicPath } from './geodesic.js';
import type { LonLat } from './coordinates.js';
import { lineOfSight, type ProfileSample } from './viewshed.js';

export type GlobeMeasureMode = 'distance' | 'area';

/** A point picked: degrees and its true height above the ellipsoid (vertical exaggeration taken out). */
export interface PickedPoint {
  lon: number;
  lat: number;
  height: number;
}

/** What the measurement found, for the panel. */
export interface MeasureResult {
  mode: GlobeMeasureMode;
  points: PickedPoint[];
  /** Lines of text. */
  lines: string[];
  /** Along a distance measurement: the ground, the surface (with objects), and the line of sight. */
  profile: Profile | null;
}

export interface Profile {
  /** Ground heights (m above sea level; NaN where there is no elevation data). */
  ground: ProfileSample[];
  /** Heights of what is drawn (ground, 3D Tiles, multipatches), m above sea level; NaN where nothing was found. */
  surface: ProfileSample[];
  /** Heights of the first and last point, m above sea level. */
  from: number;
  to: number;
  /** Whether the line of sight is checked (two points: a straight line in plan). */
  sight: boolean;
  /** Distance of the first obstruction, or null when the last point is seen from the first (or not checked). */
  blocked: number | null;
  refraction: number;
}

export interface MeasureHost {
  widget: CesiumWidget;
  /** Ground height above sea level from the open DEMs, or null. */
  groundAt: (lon: number, lat: number) => number | null;
  /** Geoid height above the ellipsoid (0 when not loaded). */
  geoidAt: (lon: number, lat: number) => number;
  /** The refraction coefficient of the viewshed settings. */
  refraction: () => number;
  /** Called when the result changes. */
  onChange: (result: MeasureResult | null) => void;
  say: (message: string) => void;
}

/** Samples along a profile. */
const PROFILE_SAMPLES = 256;
const LINE = Color.fromCssColorString('#ffd400');

export class GlobeMeasure {
  private mode_: GlobeMeasureMode | null = null;
  private points_: PickedPoint[] = [];
  /** Where the points are drawn (exaggerated heights). */
  private shown_: Cartesian3[] = [];
  private cursor_: Cartesian3 | null = null;
  private finished_ = false;
  private readonly entities_: Entity[] = [];
  private readonly handler_: ScreenSpaceEventHandler;
  private result_: MeasureResult | null = null;

  constructor(private readonly host: MeasureHost) {
    const { widget } = host;
    this.handler_ = new ScreenSpaceEventHandler(widget.scene.canvas);
    this.handler_.setInputAction((e: { position: Cartesian2 }) => this.add_(e.position), ScreenSpaceEventType.LEFT_CLICK);
    this.handler_.setInputAction(() => this.finish_(true), ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    this.handler_.setInputAction(() => this.finish_(false), ScreenSpaceEventType.RIGHT_CLICK);
    this.handler_.setInputAction((e: { endPosition: Cartesian2 }) => {
      if (!this.mode_ || this.finished_ || !this.points_.length) return;
      this.cursor_ = this.pick_(e.endPosition)?.shown ?? null;
      widget.scene.requestRender();
    }, ScreenSpaceEventType.MOUSE_MOVE);
  }

  mode(): GlobeMeasureMode | null {
    return this.mode_;
  }

  /** Whether clicks on the globe add points now. */
  active(): boolean {
    return this.mode_ !== null;
  }

  result(): MeasureResult | null {
    return this.result_;
  }

  /** Starts measuring (or stops, with null); a measurement already made is cleared. */
  setMode(mode: GlobeMeasureMode | null): void {
    this.clear();
    this.mode_ = mode;
    this.host.widget.container.classList.toggle('measuring', mode !== null);
    if (mode) this.host.say(mode === 'distance' ? '3D 距離: 点をクリックし、ダブルクリックで終了（Esc で消去）' : '3D 面積: 点をクリックし、ダブルクリックで終了（Esc で消去）');
    this.host.onChange(null);
  }

  /** Clears what was measured; the mode stays. */
  clear(): void {
    for (const e of this.entities_.splice(0)) this.host.widget.entities.remove(e);
    this.points_ = [];
    this.shown_ = [];
    this.cursor_ = null;
    this.finished_ = false;
    this.result_ = null;
    this.host.onChange(null);
    this.host.widget.scene.requestRender();
  }

  /** Adds a point programmatically (tests): degrees and true height above the ellipsoid. */
  addPoint(point: PickedPoint): void {
    if (!this.mode_) return;
    if (this.finished_) this.restart_();
    const e = this.host.widget.scene.verticalExaggeration;
    this.push_(point, Cartesian3.fromDegrees(point.lon, point.lat, point.height * e));
  }

  /** Ends the measurement (as a double-click does). */
  finish(): void {
    this.finish_(false);
  }

  destroy(): void {
    this.clear();
    this.handler_.destroy();
  }

  private restart_(): void {
    const mode = this.mode_;
    this.clear();
    this.mode_ = mode;
  }

  /** What is under a pixel: an object drawn (3D Tiles, multipatch) at its surface, else the ground. */
  private pick_(position: Cartesian2): { point: PickedPoint; shown: Cartesian3 } | null {
    const scene = this.host.widget.scene;
    let shown: Cartesian3 | undefined;
    const picked = scene.pick(position) as { id?: unknown } | undefined;
    // Not the measurement's own marks.
    const own = picked?.id && this.entities_.includes(picked.id as Entity);
    if (picked && !own && scene.pickPositionSupported) shown = scene.pickPosition(position);
    if (!shown) {
      const ray = this.host.widget.camera.getPickRay(position);
      shown = (ray && scene.globe.pick(ray, scene)) || undefined;
    }
    if (!shown) return null;
    const c = Cartographic.fromCartesian(shown);
    if (!c) return null;
    const e = scene.verticalExaggeration || 1;
    return { point: { lon: CesiumMath.toDegrees(c.longitude), lat: CesiumMath.toDegrees(c.latitude), height: c.height / e }, shown };
  }

  private add_(position: Cartesian2): void {
    if (!this.mode_) return;
    if (this.finished_) this.restart_();
    const hit = this.pick_(position);
    if (!hit) return;
    this.push_(hit.point, hit.shown);
  }

  private push_(point: PickedPoint, shown: Cartesian3): void {
    if (!this.entities_.length) this.draw_();
    this.points_.push(point);
    this.shown_.push(shown);
    this.entities_.push(
      this.host.widget.entities.add({
        position: shown,
        point: { pixelSize: 8, color: LINE, outlineColor: Color.BLACK, outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      }),
    );
    this.update_();
  }

  private finish_(doubleClick: boolean): void {
    if (!this.mode_ || this.finished_) return;
    // The double-click's two clicks added the same point twice.
    if (doubleClick && this.points_.length >= 2) {
      const [a, b] = this.points_.slice(-2);
      if (Math.abs(a.lon - b.lon) < 1e-9 && Math.abs(a.lat - b.lat) < 1e-9) {
        this.points_.pop();
        this.shown_.pop();
        const mark = this.entities_.pop();
        if (mark) this.host.widget.entities.remove(mark);
      }
    }
    this.finished_ = true;
    this.cursor_ = null;
    this.update_();
  }

  /** The line (or polygon) through the points and the cursor. */
  private draw_(): void {
    const { widget } = this.host;
    const positions = new CallbackProperty(() => (this.cursor_ ? [...this.shown_, this.cursor_] : this.shown_), false);
    if (this.mode_ === 'area') {
      this.entities_.push(
        widget.entities.add({
          polygon: {
            hierarchy: new CallbackProperty(() => new PolygonHierarchy(this.cursor_ ? [...this.shown_, this.cursor_] : this.shown_), false),
            perPositionHeight: true,
            material: LINE.withAlpha(0.3),
          },
        }),
      );
    }
    this.entities_.push(
      widget.entities.add({
        polyline: {
          positions: this.mode_ === 'area' ? new CallbackProperty(() => {
            const p = this.cursor_ ? [...this.shown_, this.cursor_] : this.shown_;
            return p.length > 2 ? [...p, p[0]] : p;
          }, false) : positions,
          width: 3,
          material: new ColorMaterialProperty(LINE),
          // Seen through the ground and buildings too, fainter.
          depthFailMaterial: new ColorMaterialProperty(LINE.withAlpha(0.45)),
        },
      }),
    );
  }

  private label_(position: Cartesian3, text: string): void {
    this.entities_.push(
      this.host.widget.entities.add({
        position,
        label: {
          text,
          font: '13px sans-serif',
          style: LabelStyle.FILL_AND_OUTLINE,
          outlineWidth: 3,
          outlineColor: Color.BLACK,
          fillColor: Color.WHITE,
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian2(0, -10),
          heightReference: HeightReference.NONE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }),
    );
  }

  /** Works out the result and labels it. */
  private update_(): void {
    const { widget } = this.host;
    // Labels are made again each time.
    for (let i = this.entities_.length - 1; i >= 0; i--) {
      if (this.entities_[i].label) widget.entities.remove(this.entities_.splice(i, 1)[0]);
    }
    const points = this.points_;
    const lonLat: LonLat[] = points.map((p) => [p.lon, p.lat]);
    const lines: string[] = [];
    let profile: Profile | null = null;
    if (this.mode_ === 'distance' && points.length >= 2) {
      let slant = 0;
      for (let i = 1; i < points.length; i++) {
        const a = Cartesian3.fromDegrees(points[i - 1].lon, points[i - 1].lat, points[i - 1].height);
        const b = Cartesian3.fromDegrees(points[i].lon, points[i].lat, points[i].height);
        const d = Cartesian3.distance(a, b);
        slant += d;
        if (points.length > 2) this.label_(Cartesian3.midpoint(this.shown_[i - 1], this.shown_[i], new Cartesian3()), formatLength(d));
      }
      const horizontal = geodesicLength(lonLat);
      const rise = points[points.length - 1].height - points[0].height;
      lines.push(`斜距離 ${formatLength(slant)}`, `水平距離 ${formatLength(horizontal)}`, `高低差 ${rise >= 0 ? '+' : '−'}${Math.abs(rise).toFixed(2)} m`);
      this.label_(this.shown_[this.shown_.length - 1], `${formatLength(slant)}（水平 ${formatLength(horizontal)}、高低差 ${rise >= 0 ? '+' : '−'}${Math.abs(rise).toFixed(1)} m）`);
      if (this.finished_) {
        profile = this.profile_();
        if (profile?.sight) lines.push(profile.blocked === null ? '見通し: 始点から終点が見えます' : `見通し: 見えません（始点から ${formatLength(profile.blocked)} で遮られます）`);
      }
    } else if (this.mode_ === 'area' && points.length >= 3) {
      const { area, perimeter } = geodesicArea(lonLat);
      lines.push(`面積 ${formatArea(area)}（水平）`, `周長 ${formatLength(perimeter)}`);
      const centre = this.shown_.reduce((s, p) => Cartesian3.add(s, p, s), new Cartesian3());
      this.label_(Cartesian3.multiplyByScalar(centre, 1 / this.shown_.length, centre), `${formatArea(area)}`);
    }
    if (points.length) {
      const msl = points.map((p) => p.height - this.host.geoidAt(p.lon, p.lat));
      lines.push(`点 ${points.length}（標高 ${msl.map((h) => `${h.toFixed(1)} m`).join('、')}）`);
    }
    this.result_ = points.length ? { mode: this.mode_ ?? 'distance', points: [...points], lines, profile } : null;
    this.host.onChange(this.result_);
    widget.scene.requestRender();
  }

  /** The profile along the line: ground from the DEMs, surface from what is drawn. */
  private profile_(): Profile | null {
    const { widget, groundAt, geoidAt } = this.host;
    const scene = widget.scene;
    const points = this.points_;
    const path = geodesicPath(points.map((p): LonLat => [p.lon, p.lat]));
    // Cumulative distance along the path.
    const along = [0];
    for (let i = 1; i < path.length; i++) along.push(along[i - 1] + geodesicLength([path[i - 1], path[i]]));
    const length = along[along.length - 1];
    if (!(length > 0)) return null;
    const e = scene.verticalExaggeration || 1;
    const ground: ProfileSample[] = [];
    const surface: ProfileSample[] = [];
    const exclude = [...this.entities_];
    let piece = 1;
    for (let s = 0; s <= PROFILE_SAMPLES; s++) {
      const d = (length * s) / PROFILE_SAMPLES;
      while (piece < path.length - 1 && along[piece] < d) piece++;
      const t = along[piece] > along[piece - 1] ? (d - along[piece - 1]) / (along[piece] - along[piece - 1]) : 0;
      const lon = path[piece - 1][0] + (path[piece][0] - path[piece - 1][0]) * t;
      const lat = path[piece - 1][1] + (path[piece][1] - path[piece - 1][1]) * t;
      const g = groundAt(lon, lat);
      ground.push({ distance: d, height: g ?? NaN });
      let top = NaN;
      if (scene.sampleHeightSupported) {
        const h = scene.sampleHeight(Cartographic.fromDegrees(lon, lat), exclude);
        if (h !== undefined) top = h / e - geoidAt(lon, lat);
      }
      // What is drawn is never below the ground.
      surface.push({ distance: d, height: Number.isNaN(top) ? g ?? NaN : g === null ? top : Math.max(top, g) });
    }
    const first = points[0];
    const last = points[points.length - 1];
    const from = first.height - geoidAt(first.lon, first.lat);
    const to = last.height - geoidAt(last.lon, last.lat);
    const refraction = this.host.refraction();
    const heights = surface.map((s, i) => ({ distance: s.distance, height: Number.isNaN(s.height) ? ground[i].height : s.height }));
    const sight = points.length === 2;
    return { ground, surface, from, to, sight, blocked: sight ? lineOfSight(heights, from, to, refraction) : null, refraction };
  }
}
