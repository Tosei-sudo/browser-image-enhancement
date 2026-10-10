/**
 * Imaging plans in the 3D view (imaging-plan-3d.ts): each pass's orbit at its
 * height, with a curtain down to its ground track so it stands up from the
 * Earth; the satellite as a small model (body, solar panels and sensor) turned
 * so its sensor faces where it looks; and the beam from the sensor to the
 * scenes it takes. The chosen pass is drawn bright, the other passes of a
 * combination faint. The model keeps about the same size on screen however
 * far the camera is.
 */
import {
  BoundingSphere,
  BoxGeometry,
  Cartesian2,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  ComponentDatatype,
  CylinderGeometry,
  Geometry,
  GeometryAttribute,
  GeometryInstance,
  HeadingPitchRange,
  Math as CesiumMath,
  Matrix4,
  NearFarScalar,
  PrimitiveType,
} from '@cesium/core';
import {
  CustomDataSource,
  LabelStyle,
  PerInstanceColorAppearance,
  PolylineDashMaterialProperty,
  PolylineGlowMaterialProperty,
  Primitive,
  VerticalOrigin,
  type CesiumWidget,
} from '@cesium/engine';
import { attitude, ecefOf, type SatellitePass3d, type Xyz } from './imaging-plan-3d.js';

const ORBIT = Color.fromCssColorString('#38bdf8');
const BEAM = Color.fromCssColorString('#fbbf24');
const BODY = Color.fromCssColorString('#d4a72c');
const PANEL = Color.fromCssColorString('#1e3a8a');
const ARM = Color.fromCssColorString('#9ca3af');
const SENSOR = Color.fromCssColorString('#1f2937');
/** The model's size: this share of the camera's distance to it. */
const SCREEN_SHARE = 0.035;

const cartesian = (p: Xyz) => new Cartesian3(p[0], p[1], p[2]);

/** The parts of the satellite model, about 1 unit across, in its own frame (x along the track, z away from the aim). */
function modelParts(): GeometryInstance[] {
  const part = (geometry: BoxGeometry | CylinderGeometry, at: [number, number, number], color: Color, id: string) =>
    new GeometryInstance({
      geometry,
      modelMatrix: Matrix4.fromTranslation(new Cartesian3(...at)),
      attributes: { color: ColorGeometryInstanceAttribute.fromColor(color) },
      id,
    });
  const box = (x: number, y: number, z: number) => BoxGeometry.fromDimensions({ dimensions: new Cartesian3(x, y, z), vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT });
  return [
    part(box(0.5, 0.36, 0.36), [0, 0, 0], BODY, 'body'),
    part(box(0.06, 0.3, 0.04), [0, 0.33, 0], ARM, 'arm'),
    part(box(0.06, 0.3, 0.04), [0, -0.33, 0], ARM, 'arm'),
    part(box(0.4, 0.62, 0.02), [0, 0.79, 0], PANEL, 'panel'),
    part(box(0.4, 0.62, 0.02), [0, -0.79, 0], PANEL, 'panel'),
    // The sensor: a short barrel under the body, looking down −z.
    part(new CylinderGeometry({ length: 0.2, topRadius: 0.11, bottomRadius: 0.14, vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT }), [0, 0, -0.28], SENSOR, 'sensor'),
  ];
}

/** Where the satellite model is and which way it faces, at `scale` metres a unit. */
function modelMatrix(pass: SatellitePass3d, scale: number, result: Matrix4): Matrix4 {
  const { x, y, z } = attitude(pass);
  const p = pass.position;
  // Columns: the model's axes in the Earth's frame, scaled, then where it is.
  return Matrix4.fromArray([x[0] * scale, x[1] * scale, x[2] * scale, 0, y[0] * scale, y[1] * scale, y[2] * scale, 0, z[0] * scale, z[1] * scale, z[2] * scale, 0, p[0], p[1], p[2], 1], 0, result);
}

export class GlobeSatellites {
  private readonly source_ = new CustomDataSource('imaging-plan');
  private models_: Array<{ pass: SatellitePass3d; primitive: Primitive }> = [];
  /** The beams. */
  private others_: Primitive[] = [];
  private passes_: SatellitePass3d[] = [];
  private readonly unhook_: () => void;

  constructor(private readonly widget: CesiumWidget) {
    void widget.dataSources.add(this.source_);
    // The models keep their size on screen.
    this.unhook_ = widget.scene.preRender.addEventListener(() => this.sizeModels_());
  }

  /** The passes drawn now. */
  passes(): readonly SatellitePass3d[] {
    return this.passes_;
  }

  /** Draws `passes` (none: clears). */
  show(passes: SatellitePass3d[]): void {
    this.clear_();
    this.passes_ = passes;
    const entities = this.source_.entities;
    entities.suspendEvents();
    for (const pass of passes) {
      const bright = pass.chosen;
      const orbit = pass.orbit.map(cartesian);
      entities.add({
        polyline: {
          positions: orbit,
          width: bright ? 7 : 3,
          arcType: 0,
          material: new PolylineGlowMaterialProperty({ color: ORBIT.withAlpha(bright ? 0.95 : 0.5), glowPower: 0.25 }),
        },
      });
      // A curtain from the orbit down to its ground track: the orbit stands up from the Earth.
      entities.add({
        wall: { positions: orbit, minimumHeights: pass.heights.map(() => 0), maximumHeights: pass.heights, material: ORBIT.withAlpha(bright ? 0.22 : 0.08), outline: false },
      });
      // The beam: from the sensor to each scene, as see-through faces and the edges to its corners.
      const from = cartesian(pass.position);
      const faces: number[] = [];
      for (const ring of pass.scenes) {
        const ground = ring.slice(0, -1).map(([lon, lat]) => ecefOf(lon, lat));
        ground.forEach((a, i) => faces.push(...pass.position, ...a, ...ground[(i + 1) % ground.length]));
        // The corners: the ends of the two long edges (passShapes draws each in four pieces).
        for (const i of [0, 4, 5, 9].filter((k) => k < ground.length)) {
          entities.add({ polyline: { positions: [from, cartesian(ground[i])], width: 1, arcType: 0, material: BEAM.withAlpha(bright ? 0.8 : 0.35) } });
        }
      }
      if (faces.length) {
        const beam = new Primitive({
          geometryInstances: new GeometryInstance({
            geometry: new Geometry({
              attributes: { position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: Float64Array.from(faces) }) } as never,
              primitiveType: PrimitiveType.TRIANGLES,
              boundingSphere: BoundingSphere.fromVertices(faces),
            }),
            attributes: { color: ColorGeometryInstanceAttribute.fromColor(BEAM.withAlpha(bright ? 0.2 : 0.08)) },
            id: 'beam',
          }),
          appearance: new PerInstanceColorAppearance({ flat: true, translucent: true, closed: false }),
          asynchronous: false,
        });
        this.widget.scene.primitives.add(beam);
        this.others_.push(beam);
      }
      // The line of sight to the middle of the scenes.
      entities.add({
        polyline: { positions: [from, cartesian(pass.aim)], width: 2, arcType: 0, material: new PolylineDashMaterialProperty({ color: BEAM.withAlpha(bright ? 1 : 0.5), dashLength: 12 }) },
      });
      entities.add({
        position: from,
        label: {
          text: `${pass.name}\n${timeText(pass.time)}\nオフナディア ${pass.offNadir.toFixed(1)}°（${pass.side === 'left' ? '左' : '右'}）`,
          font: bright ? '600 13px sans-serif' : '12px sans-serif',
          fillColor: Color.WHITE,
          outlineColor: Color.BLACK,
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian2(0, -36),
          scaleByDistance: new NearFarScalar(1e5, 1, 2e7, 0.7),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          show: bright || passes.length <= 6,
        },
      });
      const primitive = new Primitive({
        geometryInstances: modelParts(),
        appearance: new PerInstanceColorAppearance({ flat: false, closed: true, translucent: false }),
        asynchronous: false,
        modelMatrix: modelMatrix(pass, 1, new Matrix4()),
      });
      this.widget.scene.primitives.add(primitive);
      this.models_.push({ pass, primitive });
    }
    entities.resumeEvents();
    this.sizeModels_();
    this.widget.scene.requestRender();
  }

  /**
   * Looks at the chosen pass from the side: the orbit, the satellite and the
   * beam to the ground. `right` pixels at the right of the view are covered
   * (by a panel): the pass is framed in the rest.
   */
  view(right = 0, duration = 1): boolean {
    const pass = this.passes_.find((p) => p.chosen) ?? this.passes_[0];
    if (!pass) return false;
    const sphere = BoundingSphere.fromPoints([cartesian(pass.position), cartesian(pass.aim)]);
    // Across the track from the side the satellite looks to, turned a little towards where it comes from, and from above: the orbit recedes into the distance.
    const { x } = attitude(pass);
    const east = Cartesian3.normalize(Cartesian3.cross(Cartesian3.UNIT_Z, sphere.center, new Cartesian3()), new Cartesian3());
    const north = Cartesian3.normalize(Cartesian3.cross(sphere.center, east, new Cartesian3()), new Cartesian3());
    const track = Math.atan2(Cartesian3.dot(cartesian(x), east), Cartesian3.dot(cartesian(x), north));
    const heading = track + (pass.side === 'left' ? Math.PI / 2 : -Math.PI / 2) + Math.PI + (pass.side === 'left' ? -1 : 1) * CesiumMath.toRadians(35);
    // Far enough for the sphere to fit the free part of the view, both ways.
    const camera = this.widget.camera;
    const canvas = this.widget.scene.canvas;
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    const free = Math.max(width * 0.3, width - right);
    const fovy = (camera.frustum as { fovy?: number }).fovy ?? Math.PI / 4;
    const tanY = Math.tan(fovy / 2);
    const tanX = (tanY * width) / height;
    const half = Math.min(fovy / 2, Math.atan((tanX * free) / width));
    const range = (sphere.radius / Math.sin(half)) * 1.3;
    camera.flyToBoundingSphere(sphere, {
      offset: new HeadingPitchRange(heading, CesiumMath.toRadians(-28), range),
      duration,
      // Then turned so the pass sits in the middle of the free part.
      complete: () => {
        const shift = (width - free) / 2;
        if (shift > 0) camera.lookRight(Math.atan((tanX * shift) / (width / 2)));
        this.widget.scene.requestRender();
      },
    });
    return true;
  }

  destroy(): void {
    this.clear_();
    this.unhook_();
    void this.widget.dataSources.remove(this.source_, true);
  }

  private clear_(): void {
    this.source_.entities.removeAll();
    for (const { primitive } of this.models_) this.widget.scene.primitives.remove(primitive);
    for (const primitive of this.others_.splice(0)) this.widget.scene.primitives.remove(primitive);
    this.models_ = [];
    this.passes_ = [];
    this.widget.scene.requestRender();
  }

  private sizeModels_(): void {
    const camera = this.widget.camera.positionWC;
    for (const { pass, primitive } of this.models_) {
      const distance = Cartesian3.distance(camera, cartesian(pass.position));
      modelMatrix(pass, Math.max(10, distance * SCREEN_SHARE), primitive.modelMatrix);
    }
  }
}

/** Local date and time, to the minute. */
function timeText(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
