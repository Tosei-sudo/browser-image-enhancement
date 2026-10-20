/**
 * The 「衛星パス」 panel's tracks in the 3D view (satellite-track.ts): each
 * satellite's orbit at its height in its own colour, with a curtain down to
 * the ground track, and what it can image as see-through areas on the ground.
 * At a single moment the satellite stands at its place as the imaging plan's
 * model (globe-satellite.ts), looking at its nadir.
 */
import { Cartesian2, Cartesian3, Color, Matrix4, NearFarScalar } from '@cesium/core';
import {
  CustomDataSource,
  LabelStyle,
  PerInstanceColorAppearance,
  PolygonHierarchy,
  PolylineDashMaterialProperty,
  PolylineGlowMaterialProperty,
  Primitive,
  VerticalOrigin,
  type CesiumWidget,
} from '@cesium/engine';
import { modelMatrix, modelParts } from './globe-satellite.js';
import type { Track3d } from './satellite-track.js';
import type { Xyz } from './imaging-plan-3d.js';

/** The model's size: this share of the camera's distance to it (as in globe-satellite.ts). */
const SCREEN_SHARE = 0.035;
const cartesian = (p: Xyz) => new Cartesian3(p[0], p[1], p[2]);

export class GlobeTracks {
  private readonly source_ = new CustomDataSource('satellite-tracks');
  private models_: Array<{ at: NonNullable<Track3d['at']>; primitive: Primitive }> = [];
  private tracks_: Track3d[] = [];
  private readonly unhook_: () => void;

  constructor(private readonly widget: CesiumWidget) {
    void widget.dataSources.add(this.source_);
    this.unhook_ = widget.scene.preRender.addEventListener(() => this.sizeModels_());
  }

  /** The tracks drawn now. */
  tracks(): readonly Track3d[] {
    return this.tracks_;
  }

  /** Draws `tracks` (none: clears). */
  show(tracks: Track3d[]): void {
    this.clear_();
    this.tracks_ = tracks;
    const entities = this.source_.entities;
    entities.suspendEvents();
    for (const track of tracks) {
      const color = Color.fromCssColorString(track.color);
      const orbit = track.orbit.map(cartesian);
      if (orbit.length > 1) {
        entities.add({ polyline: { positions: orbit, width: 5, arcType: 0, material: new PolylineGlowMaterialProperty({ color: color.withAlpha(0.9), glowPower: 0.25 }) } });
        entities.add({ wall: { positions: orbit, minimumHeights: track.heights.map(() => 0), maximumHeights: track.heights, material: color.withAlpha(0.12), outline: false } });
      }
      for (const ring of track.reach) {
        if (ring.length < 4) continue;
        entities.add({ polygon: { hierarchy: new PolygonHierarchy(Cartesian3.fromDegreesArray(ring.slice(0, -1).flat())), material: color.withAlpha(0.22) } });
      }
      const at = track.at;
      if (!at) continue;
      const from = cartesian(at.position);
      entities.add({ polyline: { positions: [from, cartesian(at.aim)], width: 2, arcType: 0, material: new PolylineDashMaterialProperty({ color: color.withAlpha(0.9), dashLength: 12 }) } });
      entities.add({
        position: from,
        label: {
          text: at.label,
          font: '600 13px sans-serif',
          fillColor: Color.WHITE,
          outlineColor: Color.BLACK,
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian2(0, -36),
          scaleByDistance: new NearFarScalar(1e5, 1, 2e7, 0.7),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      const primitive = new Primitive({
        geometryInstances: modelParts(),
        appearance: new PerInstanceColorAppearance({ flat: false, closed: true, translucent: false }),
        asynchronous: false,
        modelMatrix: modelMatrix(at, 1, new Matrix4()),
      });
      this.widget.scene.primitives.add(primitive);
      this.models_.push({ at, primitive });
    }
    entities.resumeEvents();
    this.sizeModels_();
    this.widget.scene.requestRender();
  }

  destroy(): void {
    this.clear_();
    this.unhook_();
    void this.widget.dataSources.remove(this.source_, true);
  }

  private clear_(): void {
    this.source_.entities.removeAll();
    for (const { primitive } of this.models_) this.widget.scene.primitives.remove(primitive);
    this.models_ = [];
    this.tracks_ = [];
    this.widget.scene.requestRender();
  }

  private sizeModels_(): void {
    const camera = this.widget.camera.positionWC;
    for (const { at, primitive } of this.models_) {
      const distance = Cartesian3.distance(camera, cartesian(at.position));
      modelMatrix(at, Math.max(10, distance * SCREEN_SHARE), primitive.modelMatrix);
    }
  }
}
